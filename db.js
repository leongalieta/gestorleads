const { Pool } = require('pg');

// Parse manual da connection string (o parser padrão do pg quebra quando a
// senha contém caracteres especiais como '/', pois usa new URL()).
function parseDbUrl(url) {
  let s = String(url || '').replace(/^postgres(?:ql)?:\/\//i, '');
  let query = '';
  const qIdx = s.indexOf('?');
  if (qIdx >= 0) {
    query = s.slice(qIdx + 1);
    s = s.slice(0, qIdx);
  }
  const atIdx = s.lastIndexOf('@');
  let user = '';
  let password = '';
  let hostport = s;
  if (atIdx >= 0) {
    const ui = s.slice(0, atIdx);
    hostport = s.slice(atIdx + 1);
    const colonIdx = ui.indexOf(':');
    if (colonIdx >= 0) {
      user = ui.slice(0, colonIdx);
      password = ui.slice(colonIdx + 1);
    } else {
      user = ui;
    }
  }
  let host = hostport;
  let port = 5432;
  let database = 'postgres';
  const slashIdx = hostport.indexOf('/');
  if (slashIdx >= 0) {
    database = hostport.slice(slashIdx + 1);
    host = hostport.slice(0, slashIdx);
  }
  const cIdx = host.lastIndexOf(':');
  if (cIdx >= 0) {
    port = parseInt(host.slice(cIdx + 1), 10) || 5432;
    host = host.slice(0, cIdx);
  }
  const params = new URLSearchParams(query);
  const ssl = params.get('ssl') === 'true' || params.get('sslmode') === 'require';
  const dec = (v) => {
    try { return decodeURIComponent(v); } catch (e) { return v; }
  };
  return {
    host,
    port,
    user: dec(user),
    password: dec(password),
    database: dec(database),
    ssl: ssl ? { rejectUnauthorized: false } : undefined
  };
}

const cfg = parseDbUrl(process.env.DATABASE_URL);
const pool = new Pool(cfg);

const DEFAULT_SETTINGS = {
  admin_password: process.env.ADMIN_PASSWORD || 'admin123',
  send_delay_sec: 15,
  message_template: 'Olá {{nome}}! Aqui é do seu negócio.',
  statuses: ['novo', 'contatado', 'respondido', 'fechado', 'perdido'],
  ai_enabled: false,
  ai_model: 'gemini-2.5-flash',
  gemini_api_key: '',
  ai_system_prompt: 'Você é um assistente de atendimento atencioso e profissional. Responda de forma educada e objetiva, em português. Se não souber algo, diga que vai verificar e retornar em breve.'
};

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      origin TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'novo',
      tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT DEFAULT 'sent',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wa_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
  await pool.query(
    `INSERT INTO settings(key, value) VALUES('main', $1) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_SETTINGS)]
  );
}

async function getSettings() {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key='main'`);
  if (!rows.length) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...rows[0].value };
}

async function updateSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await pool.query(`UPDATE settings SET value=$1 WHERE key='main'`, [JSON.stringify(next)]);
  return next;
}

module.exports = { pool, init, getSettings, updateSettings };
