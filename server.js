const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { pool, init, getSettings, updateSettings } = require('./db');
const wa = require('./wa');

// Erros não tratados (ex.: "Connection Closed" do Baileys ao reconectar) não
// podem derrubar o processo — logamos e seguimos. O WhatsApp tem seu próprio
// mecanismo de reconexão.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (ignorado):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignorado):', err?.message || err);
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const sessions = new Map(); // token -> expira em ms

function requireAuth(req, res, next) {
  const t = req.cookies.token;
  if (t && sessions.get(t) && sessions.get(t) > Date.now()) return next();
  return res.status(401).json({ error: 'Não autenticado' });
}

// ---------- Auth ----------
app.post('/api/login', async (req, res) => {
  const s = await getSettings();
  if (req.body.password === s.admin_password) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + 7 * 24 * 3600 * 1000);
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.token) sessions.delete(req.cookies.token);
  res.clearCookie('token');
  res.json({ ok: true });
});

// ---------- Leads ----------
app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const { search, status } = req.query;
    let sql = 'SELECT * FROM leads';
    const params = [];
    const conds = [];
    if (search) {
      params.push(`%${search}%`);
      conds.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length} OR origin ILIKE $${params.length} OR notes ILIKE $${params.length})`);
    }
    if (status) { params.push(status); conds.push(`status = $${params.length}`); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', requireAuth, async (req, res) => {
  try {
    const { name, phone, origin, notes, status } = req.body;
    const digits = String(phone || '').replace(/\D/g, '');
    if (!name || !digits) return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });
    const { rows } = await pool.query(
      `INSERT INTO leads(name, phone, origin, notes, status) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [name, digits, origin || '', notes || '', status || 'novo']
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Já existe um lead com esse telefone' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const { name, phone, origin, notes, status } = req.body;
    const digits = String(phone || '').replace(/\D/g, '');
    const { rows } = await pool.query(
      `UPDATE leads SET name=$1, phone=$2, origin=$3, notes=$4, status=$5 WHERE id=$6 RETURNING *`,
      [name, digits, origin || '', notes || '', status || 'novo', req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM leads WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Import CSV ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/leads/import', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo CSV' });
    const rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
    let created = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const name = r.nome || r.name || r.Nome || r.nome_completo || '';
      const phone = String(r.telefone || r.phone || r.Telefone || r.celular || '').replace(/\D/g, '');
      if (!phone) { skipped++; continue; }
      const origin = r.origem || r.origin || r.fonte || '';
      const notes = r.observacoes || r.obs || r.notes || '';
      const status = r.status || 'novo';
      const exist = await pool.query(`SELECT id FROM leads WHERE phone=$1`, [phone]);
      if (exist.rows.length) {
        await pool.query(`UPDATE leads SET name=$1, origin=$2, notes=$3, status=$4 WHERE phone=$5`, [name, origin, notes, status, phone]);
        updated++;
      } else {
        await pool.query(`INSERT INTO leads(name, phone, origin, notes, status) VALUES($1,$2,$3,$4,$5)`, [name, phone, origin, notes, status]);
        created++;
      }
    }
    res.json({ created, updated, skipped });
  } catch (e) { res.status(500).json({ error: 'Erro ao processar CSV: ' + e.message }); }
});

// ---------- Mensagens ----------
app.get('/api/leads/:id/messages', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM messages WHERE lead_id=$1 ORDER BY created_at ASC`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Disparos ----------
app.post('/api/send', requireAuth, async (req, res) => {
  try {
    const { leadId, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });
    const lead = (await pool.query(`SELECT * FROM leads WHERE id=$1`, [leadId])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    await wa.sendToPhone(lead.phone, message);
    await pool.query(`INSERT INTO messages(lead_id, direction, body, status) VALUES($1,'enviada',$2,'enviada')`, [leadId, message]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

let bulk = { running: false, total: 0, sent: 0, failed: 0, current: '', cancel: false };

app.post('/api/send-bulk', requireAuth, async (req, res) => {
  try {
    const { leadIds, message, delaySec } = req.body;
    if (!leadIds || !leadIds.length) return res.status(400).json({ error: 'Selecione leads' });
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });
    if (bulk.running) return res.status(400).json({ error: 'Já existe um disparo em andamento' });
    const settings = await getSettings();
    const delay = Number(delaySec) || settings.send_delay_sec || 15;
    bulk = { running: true, total: leadIds.length, sent: 0, failed: 0, current: '', cancel: false };
    res.json({ ok: true, total: leadIds.length, delay });
    (async () => {
      for (const id of leadIds) {
        if (bulk.cancel) break;
        const lead = (await pool.query(`SELECT * FROM leads WHERE id=$1`, [id])).rows[0];
        if (!lead) { bulk.failed++; continue; }
        const msg = message.replace(/{{nome}}/gi, lead.name).replace(/{{telefone}}/gi, lead.phone);
        bulk.current = lead.name;
        try {
          await wa.sendToPhone(lead.phone, msg);
          await pool.query(`INSERT INTO messages(lead_id, direction, body, status) VALUES($1,'enviada',$2,'enviada')`, [id, msg]);
          bulk.sent++;
        } catch (e) { bulk.failed++; }
        if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));
      }
      bulk.running = false;
      bulk.current = '';
    })();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bulk/status', requireAuth, (req, res) => res.json(bulk));
app.post('/api/bulk/cancel', requireAuth, (req, res) => { bulk.cancel = true; res.json({ ok: true }); });

// ---------- Teste de envio ----------
app.post('/api/test-send', requireAuth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return res.status(400).json({ error: 'Informe um número de telefone' });
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' });
    await wa.sendToPhone(digits, message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// TEMPORÁRIO (diagnóstico): envia teste sem autenticação e mostra o estado
// da sessão. REMOVER depois de resolver.
app.post('/api/_test', async (req, res) => {
  try {
    const { phone, message } = req.body;
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return res.status(400).json({ error: 'Informe um número de telefone' });
    await wa.sendToPhone(digits, message || '✅ Teste do Gestor de Leads');
    res.json({ ok: true, status: wa.getStatus() });
  } catch (e) { res.status(500).json({ error: e.message, status: wa.getStatus() }); }
});

// TEMPORÁRIO (diagnóstico): limpa a sessão do WhatsApp sem autenticação.
// Após chamar, o usuário escaneia o QR na aba WhatsApp. REMOVER depois.
app.post('/api/_reset', async (req, res) => {
  try {
    await wa.resetSession();
    await wa.connect();
    res.json({ ok: true, status: wa.getStatus() });
  } catch (e) { res.status(500).json({ error: e.message, status: wa.getStatus() }); }
});

// ---------- WhatsApp ----------
app.get('/api/wa/status', requireAuth, (req, res) =>
  res.json({ status: wa.getStatus(), qr: wa.getQR(), error: wa.getLastError() })
);
app.post('/api/wa/connect', requireAuth, async (req, res) => {
  try { await wa.connect(); res.json({ status: wa.getStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wa/disconnect', requireAuth, async (req, res) => {
  try { await wa.disconnect(); res.json({ status: wa.getStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wa/reset', requireAuth, async (req, res) => {
  try { await wa.resetSession(); res.json({ status: wa.getStatus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Configurações ----------
app.get('/api/settings', requireAuth, async (req, res) => res.json(await getSettings()));
app.put('/api/settings', requireAuth, async (req, res) => {
  try { res.json(await updateSettings(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Frontend ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Boot ----------
(async () => {
  try {
    await init();
    const st = await getSettings();
    console.log(`[CONFIG] Agente IA: ${st.ai_enabled ? 'ATIVADO' : 'DESATIVADO'} | Chave Gemini: ${st.gemini_api_key ? 'configurada (' + String(st.gemini_api_key).slice(0, 6) + '...)' : 'NÃO configurada'} | Modelo: ${st.ai_model}`);
    console.log('Banco de dados pronto');
    app.listen(80, '0.0.0.0', () => {
      console.log('Gestor de Leads rodando na porta 80');
      wa.connect().catch((e) => console.error('Erro ao conectar WhatsApp:', e.message));
    });
  } catch (e) {
    console.error('Falha na inicialização:', e);
    process.exit(1);
  }
})();
