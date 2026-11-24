// services/ai.js — frontend ↔ backend (logic agybot di server/agy.js)
const BASE = import.meta.env?.VITE_API_BASE || '';

// ---------- auth ----------
// Server mengembalikan 401 kalau cookie token belum ada / salah → App menampilkan layar token.
export const AUTH_EVENT = 'antigpt:auth-required';
function checkAuth(r) {
  if (r.status === 401) {
    window.dispatchEvent(new Event(AUTH_EVENT));
    const err = new Error('Butuh token akses');
    err.status = 401;
    throw err;
  }
}

async function jfetch(url, opts = {}) {
  const r = await fetch(BASE + url, {
    credentials: 'include',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  checkAuth(r);
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    try { err.body = await r.json(); } catch {}
    throw err;
  }
  return r.json();
}
const post = (url, body) => jfetch(url, { method: 'POST', body: JSON.stringify(body || {}) });

export const authCheck = () => jfetch('/api/auth');
export async function authLogin(token) {
  try { return await post('/api/auth', { token }); }
  catch (e) { return { ok: false, error: e.body?.error || e.message }; }
}
export const authLogout = () => post('/api/auth/logout');
export async function adminLogin(token) {
  try { return await post('/api/admin/auth', { token }); }
  catch (e) { return { ok: false, error: e.body?.error || e.message }; }
}
export const adminLogout = () => post('/api/admin/logout');

export const apiStatus = () => jfetch('/api/status');
export const getModels = ({ refresh = false } = {}) =>
  jfetch('/api/models' + (refresh ? '?refresh=1' : ''));
export const getQuota = ({ refresh = false } = {}) =>
  jfetch('/api/quota' + (refresh ? '?refresh=1' : ''));
export const chatFileUrl = (chatId, filename) => `${BASE}/api/chats/${encodeURIComponent(chatId)}/files/${encodeURIComponent(filename)}`;
export const chatMediaUrl = (chatId, filename) => `${BASE}/api/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(filename)}`;
export const chatImageUrl = (chatId, filename) => `${BASE}/api/chats/${encodeURIComponent(chatId)}/images/${encodeURIComponent(filename)}`;
export const getChatFilePreview = (chatId, filename) =>
  jfetch(`/api/chats/${encodeURIComponent(chatId)}/preview/${encodeURIComponent(filename)}`);

export const loginStart = () => post('/api/login');
export const loginStatus = () => jfetch('/api/login/status');
export const loginCode = (code) => post('/api/login/code', { code });
export const loginCancel = () => post('/api/login/cancel');
export const logout = () => post('/api/logout');
export const resetChat = (chatId) => post('/api/chat/reset', { chatId });
export const stopChat = (chatId) => post('/api/chat/stop', { chatId });
export const answerQuestion = ({ chatId, questionId, answers, skip = false }) =>
  post('/api/chat/answer', { chatId, questionId, answers, skip });
export const deleteChatOnServer = (chatId) =>
  jfetch(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });

// ---------- admin chats (hanya untuk pemegang ADMIN_TOKEN) ----------
export const getAdminChats = () => jfetch('/api/admin/chats');
export const getAdminChat = (chatId) => jfetch(`/api/admin/chats/${encodeURIComponent(chatId)}`);
export const updateAdminChat = (chatId, patch) =>
  jfetch(`/api/admin/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', body: JSON.stringify(patch || {}) });
export const sleepAdminChat = (chatId) => post(`/api/admin/chats/${encodeURIComponent(chatId)}/sleep`);

// ---------- daftar model (cache sessionStorage, 10 menit, per akun) ----------
const MODELS_KEY = 'models_cache_v1';
const MODELS_TTL = 10 * 60 * 1000;
export function cachedModels() {
  try { return JSON.parse(sessionStorage.getItem(MODELS_KEY) || 'null'); } catch { return null; }
}
let modelsPending = null;
let modelsPendingForced = false;
export async function loadModels({ email, force = false } = {}) {
  const c = cachedModels();
  const fresh = c?.list?.length && Date.now() - c.at < MODELS_TTL && (email === undefined || c.email === email);
  if (fresh && !force) return c.list;
  if (!modelsPending || (force && !modelsPendingForced)) {
    modelsPendingForced = !!force;
    const p = getModels({ refresh: !!force })
      .then((r) => {
        const list = (r.models || []).map((m) => ({ id: m.id, name: m.name, desc: m.id }));
        if (list.length) {
          try { sessionStorage.setItem(MODELS_KEY, JSON.stringify({ email: r.email ?? null, at: Date.now(), list })); } catch {}
        }
        return list.length ? list : (c?.list || []);
      })
      .finally(() => {
        if (modelsPending === p) { modelsPending = null; modelsPendingForced = false; }
      });
    modelsPending = p;
  }
  return modelsPending;
}

// ---------- kuota (cache sessionStorage hanya untuk tampilan awal sambil auto-refresh realtime) ----------
const QUOTA_KEY = 'quota_cache_v1';
export function cachedQuota(email) {
  try {
    const c = JSON.parse(sessionStorage.getItem(QUOTA_KEY) || 'null');
    if (!c || !Array.isArray(c.groups)) return null;
    if (email !== undefined && c.email !== email) return null;
    return c;
  } catch { return null; }
}
let quotaPending = null;
let quotaPendingEmail = undefined;
export const isQuotaPending = () => !!quotaPending;
export async function loadQuota({ email, refresh = true } = {}) {
  if (!quotaPending || quotaPendingEmail !== email) {
    quotaPendingEmail = email;
    const p = getQuota({ refresh })
      .then((r) => {
        if (r.needLogin) {
          try { sessionStorage.removeItem(QUOTA_KEY); } catch {}
          return r;
        }
        if (r.ok && Array.isArray(r.groups)) {
          const entry = { email: r.email ?? email ?? null, at: r.at || Date.now(), groups: r.groups };
          try { sessionStorage.setItem(QUOTA_KEY, JSON.stringify(entry)); } catch {}
          return { ...r, at: entry.at };
        }
        return r;
      })
      .finally(() => {
        if (quotaPending === p) { quotaPending = null; quotaPendingEmail = undefined; }
      });
    quotaPending = p;
  }
  return quotaPending;
}

// ---------- streaming chat (NDJSON) ----------
// event: {type:'queued'|'start'|'step'|'thought'|'delta'|'question'|'question_done'|'done'|'none'|'ping', seq?, ...}
// Mengembalikan { done, none }. Kalau stream putus di tengah jalan → { done: null } (bukan throw),
// supaya pemanggil bisa menyambung ulang. fetch yang gagal total / AbortError tetap di-throw.
async function readNdjson(r, onEvent) {
  checkAuth(r);
  if (!r.ok || !r.body) {
    let msg = r.status === 413
      ? 'Ukuran file melebihi batas upload server.'
      : `HTTP ${r.status}`;
    try {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await r.json();
        if (j?.error) msg = j.error;
      }
    } catch {}
    throw new Error(msg);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = null, none = false, alive = false;
  const handle = (line) => {
    line = line.trim();
    if (!line) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    alive = true;
    if (ev.type === 'ping') return;
    if (ev.type === 'none') { none = true; return; }
    if (ev.type === 'done') done = ev;
    onEvent?.(ev);
  };
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    if (buf) handle(buf);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // koneksi putus di tengah stream → biar pemanggil reconnect
  }
  return { done, none, alive };
}

// Mulai job baru di server
export async function startChatStream({ chatId, model, text, files = [], signal }, onEvent) {
  const body = new FormData();
  body.append('chatId', chatId || 'default');
  body.append('model', model || '');
  body.append('text', text || '');
  files.forEach((item) => {
    if (item?.file) body.append('files', item.file, item.name || item.file.name);
  });
  const r = await fetch(BASE + '/api/chat/stream', { method: 'POST', body, signal, credentials: 'include' });
  return readNdjson(r, onEvent);
}

// Sambung ulang ke job yang sedang berjalan (setelah refresh / koneksi putus)
export async function resumeChatStream({ chatId, since = 0, signal }, onEvent) {
  const q = `chatId=${encodeURIComponent(chatId)}&since=${since}`;
  const r = await fetch(`${BASE}/api/chat/stream?${q}`, { signal, credentials: 'include' });
  return readNdjson(r, onEvent);
}

// Ubah event `done` jadi teks jawaban final
export function formatDone(done) {
  if (done.needLogin && !done.ok) throw new Error('🔑 Belum login ke akun AI. Tap avatar di kiri bawah → Login dengan Google.');
  let out = done.answer || '(tidak ada jawaban)';
  if (!done.ok && done.answer && !done.timedOut) out = '❌ ' + out;
  if (done.limit) {
    out += `\n\n🚨 **Limit terdeteksi (${done.limit.label})**` +
      (done.limit.resetIn ? ` — reset dalam **${done.limit.resetIn}**` : '') +
      '. Tunggu reset atau login ke akun lain.';
  }
  return { text: out, durationSec: done.durationSec, usage: done.usage };
}

// Kirim pesan ke agy (non-stream). chatId = id chat web (1 chat = 1 sesi/folder agy, seperti topic di bot)
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
