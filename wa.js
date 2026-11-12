const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino')({ level: 'warn' });
const { pool, getSettings } = require('./db');
const { generateReply } = require('./ai');
const fs = require('fs');
const path = require('path');

// Log de diagnóstico persistente no diretório do app (o console é inundado
// pelos erros "Bad MAC" do WhatsApp, então guardamos tudo em arquivo).
function agentLog(msg) {
  try {
    fs.appendFileSync(path.join(__dirname, 'agent.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) { console.error('[agentLog ERRO]', e.message); }
}
agentLog('--- wa.js carregado (boot) ---');

let sock = null;
let status = 'disconnected'; // disconnected | connecting | qr | connected
let currentQR = null; // data URL
let lastError = '';
let connectedNumber = '';
let reconnectTimer = null;
let retryDelay = 5000;

// O WhatsApp migrou para "Linked ID" (LID): mensagens de contatos podem chegar
// com o JID terminando em @lid em vez de @s.whatsapp.net. O Baileys publica a
// relação LID -> número real nos eventos "contacts.update", que guardamos aqui.
const lidToJid = new Map();

function recordLidMapping(updates) {
  for (const u of updates || []) {
    const lid = u.lid;      // ex.: "123456789@lid" (ou só o número)
    const jid = u.id;       // ex.: "554491457224@s.whatsapp.net"
    if (lid && jid) {
      const lidKey = String(lid).includes('@') ? String(lid) : String(lid) + '@lid';
      lidToJid.set(lidKey, jid);
      lidToJid.set(String(lid).split('@')[0], jid);
      agentLog(`Mapeamento LID: ${lidKey} -> ${jid}`);
    }
  }
}

// Converte o remoteJid (que pode ser @lid) para o JID de telefone real.
function resolveJid(remoteJid) {
  if (!remoteJid) return null;
  if (remoteJid.endsWith('@s.whatsapp.net')) return remoteJid;
  if (remoteJid.endsWith('@lid')) {
    const direct = lidToJid.get(remoteJid);
    if (direct) return direct;
    const byNum = lidToJid.get(remoteJid.split('@')[0]);
    if (byNum) return byNum;
    return null; // ainda não conhecemos o mapeamento
  }
  return null;
}

// Tenta descobrir o número real de um JID @lid consultando o WhatsApp via
// USync (LID -> PN). Cacheia falhas para não repetir consultas inúteis.
const failedLid = new Set();

async function resolveLidViaUsync(lidJid) {
  if (!sock || !lidJid) return null;
  if (failedLid.has(lidJid)) return null;
  try {
    const result = await sock.query({
      tag: 'iq',
      attrs: { type: 'get', to: 's.whatsapp.net', xmlns: 'usync', sid: sock.user?.id || 'unknown', mode: 'query', last: 'true', index: '0', context: 'interactive' },
      content: [
        { tag: 'query', attrs: { deskweb: 'true', epoch: '1' }, content: [
          { tag: 'contact', attrs: { type: 'lid', jid: lidJid }, content: [] }
        ]},
        { tag: 'list', attrs: {} }
      ]
    });
    agentLog(`USync LID resposta bruta (${lidJid}): ${JSON.stringify(result).slice(0, 400)}`);
    const walk = (node) => {
      if (!node) return null;
      if (node.attrs && node.attrs.jid && node.attrs.jid.endsWith('@s.whatsapp.net')) {
        return node.attrs.jid;
      }
      for (const c of node.content || []) {
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    const jid = walk(result);
    if (jid) {
      lidToJid.set(lidJid, jid);
      lidToJid.set(lidJid.split('@')[0], jid);
      agentLog(`USync LID: ${lidJid} -> ${jid}`);
      return jid;
    }
    agentLog(`USync LID: ${lidJid} sem resultado`);
    failedLid.add(lidJid);
    return null;
  } catch (e) {
    agentLog(`USync LID erro (${lidJid}): ${e.message}`);
    failedLid.add(lidJid);
    return null;
  }
}

const toDB = (obj) => JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
const fromDB = (obj) => JSON.parse(JSON.stringify(obj), BufferJSON.reviver);

async function loadStateMap() {
  const { rows } = await pool.query(`SELECT key, value FROM wa_state`);
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

async function useDBAuthState() {
  const map = await loadStateMap();
  const creds = map['creds'] ? fromDB(map['creds']) : initAuthCreds();
  const keys = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        const k = `${type}:${id}`;
        if (map[k] !== undefined) data[id] = fromDB(map[k]);
      }
      return data;
    },
    set: async (data) => {
      for (const type in data) {
        for (const id in data[type]) {
          const k = `${type}:${id}`;
          map[k] = toDB(data[type][id]);
          await pool.query(
            `INSERT INTO wa_state(key, value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
            [k, JSON.stringify(map[k])]
          );
        }
      }
    },
    remove: async (ids) => {
      for (const k of ids) {
        delete map[k];
        await pool.query(`DELETE FROM wa_state WHERE key=$1`, [k]);
      }
    }
  };
  return {
    state: { creds, keys },
    saveCreds: async () => {
      map['creds'] = toDB(creds);
      await pool.query(
        `INSERT INTO wa_state(key, value) VALUES('creds', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
        [JSON.stringify(map['creds'])]
      );
    }
  };
}

async function connect() {
  if (sock) { return; }
  status = 'connecting';
  lastError = '';
  try {
    const { state, saveCreds } = await useDBAuthState();
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    const s = makeWASocket({
      version,
      logger: pino,
      auth: state,
      printQRInTerminal: false,
      browser: ['ShardCloud', 'Chrome', '120.0.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    sock = s;

    s.ev.on('creds.update', saveCreds);
    s.ev.on('contacts.update', recordLidMapping);
    s.ev.on('contacts.upsert', recordLidMapping);
    s.ev.on('contacts.update', recordLidMapping);

    s.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try { currentQR = await QRCode.toDataURL(qr); status = 'qr'; } catch (e) { console.error('QR error', e); }
      }
      if (connection === 'open') {
        status = 'connected';
        currentQR = null;
        lastError = '';
        retryDelay = 5000;
        connectedNumber = s.user?.id ? s.user.id.split(':')[0] : '';
        console.log('WhatsApp conectado! Número conectado: ' + (connectedNumber || 'desconhecido'));
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || code === DisconnectReason.userLoggedOut;
        sock = null;
        currentQR = null;
        connectedNumber = '';
        if (loggedOut) {
          status = 'disconnected';
          lastError = 'Sessão encerrada. Escaneie o QR Code novamente para conectar.';
        } else {
          status = 'connecting';
          lastError = `Conexão caiu (código ${code || 'desconhecido'}). Reconectando em ${Math.round(retryDelay / 1000)}s...`;
          scheduleReconnect();
        }
      }
    });

    s.ev.on('messages.upsert', handleMessages);
  } catch (e) {
    console.error('Falha ao conectar WhatsApp:', e.message);
    status = 'disconnected';
    lastError = e.message;
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}

async function handleMessages({ messages, type }) {
  agentLog(`UPSERT: type=${type}, qtd=${(messages || []).length}`);
  if (type !== 'notify') return;
  for (const m of messages || []) {
    try {
      if (!m.key || !m.key.remoteJid) {
        agentLog(`sem remoteJid: tipos=${JSON.stringify(m.message ? Object.keys(m.message) : [])}`);
        continue;
      }
      const isMe = !!m.key.fromMe;
      const rawJid = m.key.remoteJid;
      const body =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        '';
      agentLog(`MSG: jid=${rawJid}, fromMe=${isMe}, body="${String(body).slice(0, 40)}", tipos=${JSON.stringify(m.message ? Object.keys(m.message) : [])}`);
      agentLog(`MSG BRUTO: ${JSON.stringify({ key: m.key, messageType: m.messageType, message: m.message, pushName: m.pushName, messageStubType: m.messageStubType, status: m.status }).slice(0, 900)}`);
      // Só resolvemos LID para mensagens reais recebidas (com texto), nunca
      // para protocolMessage nem para mensagens enviadas por nós.
      let resolved = resolveJid(rawJid);
      if (!resolved && rawJid.endsWith('@lid') && !isMe && body) {
        agentLog(`Tentando USync para ${rawJid}...`);
        resolved = await resolveLidViaUsync(rawJid);
      }
      if (!resolved) {
        if (!isMe && body) {
          agentLog(`Mensagem de ${rawJid} sem resolver: tipos=${JSON.stringify(m.message ? Object.keys(m.message) : [])}`);
        }
        continue;
      }
      const phone = resolved.split('@')[0];
      if (!body) {
        agentLog(`Mensagem SEM TEXTO (${phone}): tipos=${JSON.stringify(m.message ? Object.keys(m.message) : [])}`);
        continue;
      }
      const lead = await findLeadByPhone(phone);
      agentLog(`Mensagem de ${phone} (fromMe=${isMe}) — lead encontrado: ${lead ? '#' + lead.id : 'NÃO'}`);
      if (!lead) continue;
      await pool.query(
        `INSERT INTO messages(lead_id, direction, body, status) VALUES($1, $2, $3, 'entregue')`,
        [lead.id, isMe ? 'enviada' : 'recebida', body]
      );
      if (!isMe) {
        await pool.query(`UPDATE leads SET status='respondido' WHERE id=$1`, [lead.id]);
        maybeAutoReply(lead, body);
      }
    } catch (e) {
      console.error('Erro ao processar mensagem:', e.message);
    }
  }
}

// Exibe "digitando..." no WhatsApp enquanto o agente compõe a resposta.
// O status "composing" expira sozinho após alguns segundos, então é reenviado
// periodicamente enquanto a IA ainda está gerando a resposta.
async function sendTyping(jid, durationMs) {
  if (!sock || status !== 'connected' || !jid) return;
  const startedAt = Date.now();
  const ping = async () => {
    if (Date.now() - startedAt > durationMs) return;
    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) { /* ignora */ }
    setTimeout(ping, 7000);
  };
  ping();
}

async function maybeAutoReply(lead, incomingText) {
  try {
    const s = await getSettings();
    agentLog(`maybeAutoReply chamado: ai_enabled=${s.ai_enabled}, tem_chave=${!!(s.gemini_api_key || '').trim()}`);
    if (!s.ai_enabled || !(s.gemini_api_key || '').trim()) return;
    const jid = normalizePhone(lead.phone);
    // pequena pausa para parecer natural
    await new Promise((r) => setTimeout(r, 1500));
    // mostra "digitando..." enquanto a IA pensa e escreve a resposta
    sendTyping(jid, 45000);
    const { rows: hist } = await pool.query(
      `SELECT direction, body FROM messages WHERE lead_id=$1 ORDER BY created_at ASC LIMIT 12`,
      [lead.id]
    );
    const contents = hist.map((m) => ({
      role: m.direction === 'enviada' ? 'model' : 'user',
      parts: [{ text: m.body }]
    }));
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: incomingText }] });
    const reply = await generateReply(contents, s.ai_system_prompt || '');
    if (!reply) return;
    if (sock && status === 'connected') {
      try { await sock.sendPresenceUpdate('paused', jid); } catch (e) { /* ignora */ }
    }
    await sendToPhone(lead.phone, reply);
    await pool.query(
      `INSERT INTO messages(lead_id, direction, body, status) VALUES($1,'enviada',$2,'enviada (IA)')`,
      [lead.id, reply]
    );
  } catch (e) {
    console.error('Erro no agente de IA:', e.message);
  }
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  return (digits.startsWith('55') ? digits : '55' + digits) + '@s.whatsapp.net';
}

// Busca um lead pelo telefone tolerando a presença/ausência do DDI (55) na
// gravação. Ex.: a mensagem chega como 554491457224, mas o lead pode estar
// salvo como 4491457224 (11 dígitos, como o formulário sugere).
async function findLeadByPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  const full = digits.startsWith('55') ? digits : '55' + digits;
  const local = full.startsWith('55') ? full.slice(2) : full;
  const { rows } = await pool.query(
    `SELECT id FROM leads WHERE phone = $1 OR phone = $2 OR phone = $3 LIMIT 1`,
    [digits, full, local]
  );
  return rows[0] || null;
}

async function sendToPhone(phone, text) {
  if (!sock || status !== 'connected') throw new Error('WhatsApp não está conectado. Abra a aba WhatsApp e verifique o status.');
  const jid = normalizePhone(phone);
  if (!jid) throw new Error('Telefone inválido: ' + phone);
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.error('Erro ao enviar mensagem para', phone, ':', e.message);
    throw e;
  }
  return jid;
}

async function disconnect() {
  clearTimeout(reconnectTimer);
  if (sock) {
    try { await sock.logout(); } catch (e) { /* ignore */ }
    sock = null;
  }
  status = 'disconnected';
  currentQR = null;
  lastError = 'Desconectado manualmente.';
}

// Limpa a sessão salva no banco e desconecta — força um QR novo do zero.
async function resetSession() {
  clearTimeout(reconnectTimer);
  if (sock) {
    try { await sock.end(undefined); } catch (e) { /* ignore */ }
    sock = null;
  }
  await pool.query(`DELETE FROM wa_state`);
  status = 'disconnected';
  currentQR = null;
  lastError = 'Sessão limpa. Escaneie o QR Code novamente para conectar.';
  connectedNumber = '';
  retryDelay = 5000;
}

function getStatus() { return status; }
function getQR() { return currentQR; }
function getLastError() { return lastError; }

module.exports = { connect, disconnect, resetSession, sendToPhone, getStatus, getQR, getLastError, normalizePhone };
