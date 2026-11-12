const { getSettings } = require('./db');
const fs = require('fs');
const path = require('path');

// Log de diagnóstico gravado em arquivo no diretório do app (o console fica
// inundado pelos erros "Bad MAC" do WhatsApp, então guardamos os detalhes da
// IA aqui).
function agentLog(msg) {
  try {
    fs.appendFileSync(path.join(__dirname, 'agent.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) { /* ignora */ }
}

async function generateReply(history, systemPrompt) {
  const s = await getSettings();
  const key = (s.gemini_api_key || '').trim();
  agentLog(`generateReply: tem_chave=${!!key}, inicio_chave=${key.slice(0, 8)}..., modelo=${s.ai_model}`);
  if (!key) { agentLog('generateReply: SEM CHAVE'); return null; }

  const model = s.ai_model || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: history,
    generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    agentLog(`generateReply: ERRO DE REDE: ${e.message}`);
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  agentLog(`generateReply: status=${res.status}`);
  if (!res.ok) {
    agentLog(`generateReply: ERRO API: ${JSON.stringify(data).slice(0, 500)}`);
    throw new Error(data.error?.message || `Erro na API Gemini (${res.status})`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || null;
  agentLog(`generateReply: resposta_ok=${text !== null}, tamanho=${text ? text.length : 0}`);
  return text;
}

module.exports = { generateReply };
