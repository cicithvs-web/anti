// services/ai.js — frontend ↔ backend (logic agybot di server/agy.js)
const BASE = import.meta.env?.VITE_API_BASE || '';

async function jfetch(url, opts = {}) {
  const r = await fetch(BASE + url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const post = (url, body) => jfetch(url, { method: 'POST', body: JSON.stringify(body || {}) });

export const apiStatus = () => jfetch('/api/status');
export const getModels = () => jfetch('/api/models');
export const getQuota = () => jfetch('/api/quota');
export const chatFileUrl = (chatId, filename) => `${BASE}/api/chats/${encodeURIComponent(chatId)}/files/${encodeURIComponent(filename)}`;
export const chatImageUrl = (chatId, filename) => `${BASE}/api/chats/${encodeURIComponent(chatId)}/images/${encodeURIComponent(filename)}`;

export const loginStart = () => post('/api/login');
export const loginStatus = () => jfetch('/api/login/status');
export const loginCode = (code) => post('/api/login/code', { code });
export const loginCancel = () => post('/api/login/cancel');
export const logout = () => post('/api/logout');
export const resetChat = (chatId) => post('/api/chat/reset', { chatId });

// Versi streaming: baca NDJSON dari /api/chat/stream, panggil onEvent per event
// event: {type:'queued'|'start'|'step'|'delta'|'done'|'ping', ...}
export async function sendToAIStream({ chatId, model, text, files = [], signal }, onEvent) {
  const body = new FormData();
  body.append('chatId', chatId || 'default');
  body.append('model', model || '');
  body.append('text', text || '');
  files.forEach((item) => {
    if (item?.file) body.append('files', item.file, item.name || item.file.name);
  });
  const r = await fetch(BASE + '/api/chat/stream', {
    method: 'POST', body, signal,
  });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'done') done = ev;
      onEvent?.(ev);
    }
  }
  if (!done) throw new Error('Koneksi terputus sebelum jawaban selesai');
  if (done.needLogin && !done.ok) throw new Error('🔑 Belum login ke akun AI. Tap avatar di kiri bawah → Login dengan Google.');
  let out = done.answer || '(tidak ada jawaban)';
  if (!done.ok && done.answer) out = '❌ ' + out;
  if (done.limit) {
    out += `\n\n🚨 **Limit terdeteksi (${done.limit.label})**` +
      (done.limit.resetIn ? ` — reset dalam **${done.limit.resetIn}**` : '') +
      '. Tunggu reset atau login ke akun lain.';
  }
  return { text: out, durationSec: done.durationSec, usage: done.usage };
}

// Kirim pesan ke agy. chatId = id chat web (1 chat = 1 sesi/folder agy, seperti topic di bot)
export async function sendToAI({ chatId, model, messages, text }) {
  const last = [...(messages || [])].reverse().find((m) => m.role === 'user');
  const prompt = text || last?.content || '';
  const r = await post('/api/chat', { chatId, text: prompt, model });
  if (r.needLogin && !r.ok) throw new Error('🔑 Belum login ke akun AI. Tap avatar di kiri bawah → Login dengan Google.');
  let out = r.answer || r.error || '(tidak ada jawaban)';
  if (!r.ok && r.answer) out = '❌ ' + out;
  if (r.limit) {
    out += `\n\n🚨 **Limit terdeteksi (${r.limit.label})**` +
      (r.limit.resetIn ? ` — reset dalam **${r.limit.resetIn}**` : '') +
      '. Tunggu reset atau login ke akun lain.';
  }
  return out;
}
