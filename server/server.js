// Backend AntiGPT — memakai logic agybot (server/agy.js) lewat HTTP API
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Muat .env dari root proyek (Node >= 20.12). Variabel yang sudah di-set di environment tetap menang.
try { process.loadEnvFile(path.join(__dirname, '../.env')); } catch {}

const agy = await import('./agy.js');
const agySandbox = await import('./sandboxManager.js');
const jobs = await import('./jobs.js');

const app = express();
app.set('trust proxy', true); // supaya req.secure / req.ip benar di belakang nginx / tunnel
app.use(express.json({ limit: '2mb' }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 15 * 1024 * 1024 },
});
const PORT = parseInt(process.env.PORT || '3000', 10);

// ---------- HEALTH ----------
app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'antigpt' }));

// ---------- AUTH (token di .env) ----------
// Browser: POST /api/auth {token} → cookie httpOnly. Script/curl: header `Authorization: Bearer <token>`.
let AUTH_TOKEN = String(process.env.AUTH_TOKEN || '').trim();
if (!AUTH_TOKEN) {
  AUTH_TOKEN = crypto.randomBytes(24).toString('base64url');
  console.warn('[auth] ⚠️  AUTH_TOKEN belum di-set di .env — memakai token sementara (berubah tiap restart):');
  console.warn(`[auth]     ${AUTH_TOKEN}`);
}
const AUTH_COOKIE = 'antigpt_auth';
const cookieValue = crypto.createHmac('sha256', AUTH_TOKEN).update('antigpt-cookie-v1').digest('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function isAuthed(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (bearer && safeEqual(bearer.trim(), AUTH_TOKEN)) return true;
  const c = readCookie(req, AUTH_COOKIE);
  return !!c && safeEqual(c, cookieValue);
}
function setAuthCookie(req, res, value, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
// rate limit percobaan token salah: 10x / 15 menit per IP
const authFails = new Map();
const FAIL_WINDOW = 15 * 60 * 1000, FAIL_MAX = 10;
app.get('/api/auth', (req, res) => res.json({ ok: true, authed: isAuthed(req) }));
app.post('/api/auth', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = authFails.get(ip);
  if (rec && now - rec.first > FAIL_WINDOW) authFails.delete(ip);
  const cur = authFails.get(ip);
  if (cur && cur.count >= FAIL_MAX) {
    return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  }
  if (!safeEqual(String(req.body?.token || '').trim(), AUTH_TOKEN)) {
    authFails.set(ip, cur ? { ...cur, count: cur.count + 1 } : { first: now, count: 1 });
    return setTimeout(() => res.status(401).json({ ok: false, error: 'Token salah.' }), 600);
  }
  authFails.delete(ip);
  setAuthCookie(req, res, cookieValue, 60 * 60 * 24 * 365);
  res.json({ ok: true, authed: true });
});
app.post('/api/auth/logout', (req, res) => { setAuthCookie(req, res, '', 0); res.json({ ok: true }); });
// Semua /api/* lain wajib terautentikasi
app.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ ok: false, auth: false, error: 'Unauthorized' });
});

function safeName(name) {
  return String(name || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
}

// Hanya layani file dari folder project/sesi milik chat tersebut; jangan pernah menerima path absolut dari browser.
const imageTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};
const fileTypes = {
  ...imageTypes,
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.sh': 'application/x-sh; charset=utf-8',
  '.sql': 'application/sql; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const FORBIDDEN_FILES = new Set(['state.json', 'agent.md', 'agents.md', 'gemini.md']);

function resolveChatFile(chatId, requestedPath, { imageOnly = false } = {}) {
  const rawPath = String(requestedPath || '').trim();
  if (!rawPath || rawPath.includes('..')) return null;

  const slug = agy.slugify(chatId);
  const sessionRoot = path.resolve(agy.BASE, slug);
  if (!fs.existsSync(sessionRoot)) return null;

  let realSessionRoot;
  try {
    realSessionRoot = fs.realpathSync(sessionRoot);
  } catch {
    return null;
  }

  const baseName = path.basename(rawPath);
  if (!baseName || baseName.startsWith('.') || FORBIDDEN_FILES.has(baseName.toLowerCase())) {
    return null;
  }

  const ext = path.extname(baseName).toLowerCase();
  if (imageOnly && !imageTypes[ext]) {
    return null;
  }

  const projectRoot = path.join(sessionRoot, 'project');

  const checkCandidate = (candidate) => {
    try {
      if (!fs.existsSync(candidate)) return null;
      const real = fs.realpathSync(candidate);
      const stat = fs.statSync(real);
      if (!stat.isFile()) return null;
      return real;
    } catch {
      return null;
    }
  };

  // 1. Cek di projectRoot (sesuai requestedPath atau baseName)
  const candidate1 = checkCandidate(path.join(projectRoot, rawPath));
  if (candidate1 && candidate1.startsWith(realSessionRoot + path.sep)) return candidate1;

  if (rawPath !== baseName) {
    const candidate1b = checkCandidate(path.join(projectRoot, baseName));
    if (candidate1b && candidate1b.startsWith(realSessionRoot + path.sep)) return candidate1b;
  }

  // 2. Cek di sessionRoot (root workspace jika AI simpan langsung di /home/AntiGPT)
  const candidate2 = checkCandidate(path.join(sessionRoot, rawPath));
  if (candidate2 && candidate2.startsWith(realSessionRoot + path.sep)) return candidate2;

  if (rawPath !== baseName) {
    const candidate2b = checkCandidate(path.join(sessionRoot, baseName));
    if (candidate2b && candidate2b.startsWith(realSessionRoot + path.sep)) return candidate2b;
  }

  // 3. Cek di brain directory (jika file merupakan artifact report dari agy)
  const state = agy.readState(slug);
  if (state?.conversation_id) {
    const brainDir = path.join(agySandbox.GEMINI_DATA_DIR, 'antigravity-cli', 'brain', String(state.conversation_id));
    if (fs.existsSync(brainDir)) {
      try {
        const realBrainDir = fs.realpathSync(brainDir);
        const candidate3 = checkCandidate(path.join(brainDir, baseName));
        if (candidate3 && candidate3.startsWith(realBrainDir + path.sep)) {
          return candidate3;
        }
      } catch {}
    }
  }

  // 4. Cari rekursif di projectRoot lalu sessionRoot jika ada di dalam subfolder
  const searchRecursive = (dir, depth = 0) => {
    if (depth > 4) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === baseName.toLowerCase()) {
          const real = checkCandidate(full);
          if (real && real.startsWith(realSessionRoot + path.sep)) return real;
        } else if (entry.isDirectory()) {
          const found = searchRecursive(full, depth + 1);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  };

  if (fs.existsSync(projectRoot)) {
    const foundInProject = searchRecursive(projectRoot);
    if (foundInProject) return foundInProject;
  }

  return searchRecursive(sessionRoot);
}

function serveChatProjectFile(req, res, { imageOnly = false, download = false } = {}) {
  const rawParam = req.params.filename || req.params[0] || '';
  let filename = String(rawParam);
  try { filename = decodeURIComponent(filename); } catch {}

  const filePath = resolveChatFile(req.params.chatId, filename, { imageOnly });
  if (!filePath) return res.sendStatus(404);

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > (imageOnly ? 25 : 100) * 1024 * 1024) return res.sendStatus(413);

    const ext = path.extname(filePath).toLowerCase();
    res.set('Content-Type', imageOnly ? imageTypes[ext] : (fileTypes[ext] || 'application/octet-stream'));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=300');

    const downloadName = path.basename(filePath);
    const send = download
      ? res.download(filePath, downloadName, (err) => {
          if (err && !res.headersSent) res.sendStatus(err.statusCode || 404);
        })
      : res.sendFile(filePath, (err) => {
          if (err && !res.headersSent) res.sendStatus(err.statusCode || 404);
        });
    return send;
  } catch {
    return res.sendStatus(404);
  }
}

app.get('/api/chats/:chatId/images/:filename(*)', (req, res) => serveChatProjectFile(req, res, { imageOnly: true }));
app.get('/api/chats/:chatId/files/:filename(*)', (req, res) => serveChatProjectFile(req, res, { download: true }));

function persistUploads(chatId, files = []) {
  if (!files.length) return [];
  const slug = agy.slugify(chatId || 'default');
  // Upload ditulis langsung ke workspace chat (ter-mount sebagai /home/AntiGPT di sandbox),
  // supaya agy bisa membacanya. path di prompt memakai path versi sandbox.
  const dir = path.join(agy.BASE, slug, 'project', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return files.map((file) => {
    const storedName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName(file.originalname)}`;
    fs.writeFileSync(path.join(dir, storedName), file.buffer);
    return { name: file.originalname, type: file.mimetype, size: file.size, path: `/home/AntiGPT/project/uploads/${storedName}` };
  });
}

function promptWithAttachments(text, files = []) {
  if (!files.length) return String(text || '');
  const attachmentText = files.map((file) => `- ${file.name} (${file.type || 'file'}): ${file.path}`).join('\n');
  const instruction = String(text || '').trim() || 'Analisis file terlampir secara detail dan jelaskan temuan utamanya.';
  return `${instruction}\n\n[ATTACHMENTS]\nPengguna melampirkan file berikut. Baca atau lihat file tersebut sebelum menjawab, lalu gunakan isinya sebagai konteks utama:\n${attachmentText}`;
}

// ---------- STATUS ----------
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    email: agy.whoamiEmail(),
    loggedIn: !!agy.whoamiEmail(),
    running: agy.runningCount(),
    maxParallel: agy.MAX_PARALLEL,
    queued: agy.queuedCount(),
    login: agy.getLoginState(),
  });
});

// ---------- MODELS (agy models) ----------
// Cache per akun: ganti akun (login/logout) → daftar model diambil ulang otomatis.
// Daftar kosong tidak di-cache (misal saat belum login), supaya dicoba lagi berikutnya.
let modelsCache = { email: undefined, models: null };
app.get('/api/models', async (req, res) => {
  const email = agy.whoamiEmail() || null;
  if (req.query.refresh || modelsCache.email !== email || !modelsCache.models?.length) {
    modelsCache = { email, models: await agy.listModels() };
  }
  res.json({ ok: true, email, models: modelsCache.models, default: agy.DEFAULT_MODEL });
});

// ---------- CHAT ----------
// body: { chatId, title, text, model }
app.post('/api/chat', upload.array('files', 5), async (req, res) => {
  const { chatId, text, model } = req.body || {};
  // validasi & cek login DULU, baru simpan upload (hindari file yatim)
  if ((!text || !String(text).trim()) && !req.files?.length) return res.status(400).json({ ok: false, error: 'teks atau file kosong' });
  if (!agy.whoamiEmail()) return res.json({ ok: false, needLogin: true, error: 'Belum login. Buka menu Akun → Login dengan Google.' });
  const files = persistUploads(chatId, req.files);

  const slug = agy.slugify(chatId || 'default');
  agy.topicDir(slug);
  const st = agy.readState(slug);
  if (model) st.model = model;
  if (!st.model) st.model = agy.DEFAULT_MODEL;
  agy.writeState(slug, st);

  const started = Date.now();
  const r = await agy.runQueued(slug, () => agy.agyPrompt(slug, promptWithAttachments(text, files), st.model, st.conversation_id));
  const raw = r.raw_output || r.response || '';

  if (r.conversation_id) st.conversation_id = r.conversation_id;
  if (r.usage) { st.last_usage = r.usage; st.last_model = st.model; st.last_ts = Date.now(); }
  agy.writeState(slug, st);

  const lim = r.limitDetected || null;
  res.json({
    ok: r.status === 'SUCCESS',
    answer: r.response || '',
    model: st.model,
    usage: r.usage || null,
    durationSec: Math.round((Date.now() - started) / 1000),
    limit: lim ? { ...lim, resetIn: agy.extractResetIn(raw) } : null,
    needLogin: !!agy.extractLoginUrl(raw) || /not (logged|signed) in|login required|unauthenticated/i.test(raw),
  });
});

// ---------- CHAT STREAM (NDJSON) — timeline proses agy (tool, durasi, teks bertahap) ----------
// Setiap baris = 1 JSON: {type:'step', step}, {type:'delta', text}, {type:'queued'}, {type:'done', ...}
function toolLabel(name, p = {}) {
  const f = (x) => String(x || '').split('/').pop();
  const map = {
    run_command: () => `Jalankan: ${p.CommandLine || ''}`,
    read_file: () => `Baca file ${f(p.Path || p.AbsolutePath)}`,
    view_file: () => `Baca file ${f(p.Path || p.AbsolutePath)}`,
    write_file: () => `Tulis file ${f(p.Path || p.TargetFile)}`,
    write_to_file: () => `Tulis file ${f(p.Path || p.TargetFile)}`,
    replace_file_content: () => `Edit file ${f(p.Path || p.TargetFile)}`,
    edit_file: () => `Edit file ${f(p.Path || p.TargetFile)}`,
    list_dir: () => `Lihat isi folder ${f(p.Path || p.DirectoryPath) || '.'}`,
    grep_search: () => `Cari "${p.Query || p.Pattern || ''}"`,
    search_web: () => `Cari di web: ${p.query || p.Query || ''}`,
    read_url_content: () => `Buka ${p.Url || p.url || ''}`,
  };
  return (map[name] ? map[name]() : name.replace(/_/g, ' ')).slice(0, 160);
}
const toolKind = (n) => /command|terminal/.test(n) ? 'terminal' : /write|edit|replace/.test(n) ? 'edit'
  : /read|view|list|grep|find|search_file/.test(n) ? 'read' : /web|url|browser/.test(n) ? 'web' : 'tool';

// Respons NDJSON: replay event job mulai `since`, lalu ikuti event baru sampai `done`.
// Putusnya koneksi TIDAK membatalkan job — klien bisa menyambung lagi lewat GET /api/chat/stream.
function pipeJob(job, since, req, res) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch {} };
  const ping = setInterval(() => send({ type: 'ping' }), 15000); // jaga koneksi tunnel tetap hidup
  let unsub = () => {};
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(ping);
    unsub();
    try { res.end(); } catch {}
  };
  res.on('close', () => { ended = true; clearInterval(ping); unsub(); });
  unsub = job.subscribe(since, (ev) => { send(ev); if (ev.type === 'done') finish(); });
  if (job.done) finish();
}
function ndjsonOnce(res, obj) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.end(JSON.stringify(obj) + '\n');
}

async function runChatJob(job, slug, prompt, st) {
  const started = Date.now();
  let answerStep = null;
  const onEvent = (ev) => {
    const su = ev.step_update;
    if (!su) return;
    const idx = su.step_index;
    if (su.step_type === 'tool') {
      const p = su.tool_info?.parameters || {};
      job.emit({ type: 'step', step: {
        id: idx, kind: toolKind(su.tool_name || ''), tool: su.tool_name, label: toolLabel(su.tool_name || 'tool', p),
        status: su.state === 'DONE' ? 'done' : 'running',
        duration: su.duration_seconds ?? null,
        output: su.tool_info?.output ? String(su.tool_info.output).slice(0, 1500) : null,
      } });
    } else if (su.step_type === 'agent_response') {
      if (su.text_delta) { answerStep = idx; job.emit({ type: 'delta', text: su.text_delta }); }
      else if (su.state === 'DONE' && idx !== answerStep) {
        // langkah "mikir" sebelum memakai tool (agy tidak membuka teks thinking-nya, hanya durasi & token)
        job.emit({ type: 'step', step: { id: idx, kind: 'think', label: 'Berpikir', status: 'done',
          duration: su.duration_seconds ?? null, thinkingTokens: su.usage?.thinking_tokens ?? null } });
      }
    }
  };

  try {
    if (agy.isQueueFull()) job.emit({ type: 'queued' });
    const signal = job.controller.signal;
    const r = await agy.runQueued(slug, () => {
      job.emit({ type: 'start' });
      return agy.agyPromptStream(slug, prompt, st.model, st.conversation_id, onEvent, signal);
    }, signal);
    const raw = r.raw_output || r.response || '';
    if (r.conversation_id) st.conversation_id = r.conversation_id;
    if (r.usage) { st.last_usage = r.usage; st.last_model = st.model; st.last_ts = Date.now(); }
    agy.writeState(slug, st);
    const cancelled = signal.aborted || r.status === 'CANCELLED';
    const lim = cancelled ? null : (r.limitDetected || null);
    job.emit({
      type: 'done', ok: !cancelled && r.status === 'SUCCESS', cancelled,
      answer: cancelled ? '' : (r.response || ''), model: st.model, usage: r.usage || null,
      durationSec: Math.round((Date.now() - started) / 1000),
      limit: lim ? { ...lim, resetIn: agy.extractResetIn(raw) } : null,
      needLogin: !cancelled && (!!agy.extractLoginUrl(raw) || /not (logged|signed) in|login required|unauthenticated/i.test(raw)),
    });
  } catch (e) {
    job.emit({ type: 'done', ok: false, answer: `Error: ${e.message || e}`, durationSec: Math.round((Date.now() - started) / 1000) });
  }
}

// Mulai job baru untuk chat ini, lalu stream event-nya.
app.post('/api/chat/stream', upload.array('files', 5), async (req, res) => {
  const { chatId, text, model } = req.body || {};
  // validasi & cek login DULU, baru simpan upload (hindari file yatim)
  if ((!text || !String(text).trim()) && !req.files?.length) return ndjsonOnce(res, { type: 'done', ok: false, answer: 'Error: teks atau file kosong' });
  if (!agy.whoamiEmail()) return ndjsonOnce(res, { type: 'done', ok: false, needLogin: true, answer: 'Belum login. Buka menu Akun → Login dengan Google.' });

  const slug = agy.slugify(chatId || 'default');
  if (jobs.isJobRunning(slug)) return ndjsonOnce(res, { type: 'done', ok: false, busy: true, answer: 'Chat ini masih memproses pesan sebelumnya.' });

  const files = persistUploads(chatId, req.files);
  agy.topicDir(slug);
  const st = agy.readState(slug);
  if (model) st.model = model;
  if (!st.model) st.model = agy.DEFAULT_MODEL;
  agy.writeState(slug, st);

  const job = jobs.createJob(slug);
  runChatJob(job, slug, promptWithAttachments(text, files), st); // sengaja tidak di-await
  pipeJob(job, 0, req, res);
});

// Sambung ulang ke job yang sedang/baru selesai berjalan: GET /api/chat/stream?chatId=..&since=<seq>
// Kalau tidak ada job (mis. server restart) → {type:'none'}.
app.get('/api/chat/stream', (req, res) => {
  const slug = agy.slugify(req.query.chatId || 'default');
  const job = jobs.getJob(slug);
  if (!job) return ndjsonOnce(res, { type: 'none' });
  pipeJob(job, parseInt(req.query.since, 10) || 0, req, res);
});

// Hentikan proses agy chat ini (eksplisit — tidak lagi bergantung pada putusnya koneksi)
app.post('/api/chat/stop', (req, res) => {
  const slug = agy.slugify(req.body?.chatId || 'default');
  res.json({ ok: true, stopped: jobs.stopJob(slug) });
});

// Hapus chat sepenuhnya: hentikan job, hapus container sandbox & folder sesi
app.delete('/api/chats/:chatId', async (req, res) => {
  const slug = agy.slugify(req.params.chatId);
  if (!slug || slug === 'default') return res.status(400).json({ ok: false, error: 'chatId tidak valid' });
  jobs.deleteJob(slug);
  const removed = await agySandbox.resetSandbox(slug);
  const dir = path.resolve(agy.BASE, slug);
  let deletedDir = false;
  if (dir.startsWith(path.resolve(agy.BASE) + path.sep)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); deletedDir = true; } catch (e) { console.warn('[delete]', slug, e.message); }
  }
  res.json({ ok: true, slug, containerRemoved: removed, sessionDeleted: deletedDir });
});

// reset percakapan 1 chat (hapus conversation_id)
app.post('/api/chat/reset', (req, res) => {
  const slug = agy.slugify(req.body?.chatId || 'default');
  const st = agy.readState(slug); delete st.conversation_id; agy.writeState(slug, st);
  res.json({ ok: true });
});

// ---------- QUOTA (/usage asli dari CLI) — di-cache 60 dtk per akun ----------
let quotaCache = { email: null, at: 0, groups: null, pending: null };
app.get('/api/quota', async (req, res) => {
  const email = agy.whoamiEmail();
  if (!email) return res.json({ ok: false, needLogin: true });
  const fresh = quotaCache.email === email && quotaCache.groups && Date.now() - quotaCache.at < 60_000;
  if (!fresh || req.query.refresh) {
    // dedupe: request bersamaan cukup menunggu 1 eksekusi agy
    if (!quotaCache.pending || quotaCache.email !== email) {
      quotaCache.email = email;
      quotaCache.pending = agy.getQuota().then((groups) => {
        if (groups) quotaCache = { email, at: Date.now(), groups, pending: null };
        else quotaCache.pending = null;
        return groups;
      });
    }
    const groups = await quotaCache.pending;
    return res.json({ ok: !!groups, groups: groups || [] });
  }
  res.json({ ok: true, groups: quotaCache.groups, cached: true });
});

// ---------- LOGIN / LOGOUT ----------
app.post('/api/login', async (req, res) => res.json(await agy.startLogin()));
app.get('/api/login/status', (req, res) =>
  res.json({ ok: true, active: agy.getLoginState(), result: agy.getLastLoginResult(), email: agy.whoamiEmail() }));
app.post('/api/login/code', (req, res) => res.json(agy.submitLoginCode(req.body?.code || '')));
app.post('/api/login/cancel', (req, res) => res.json(agy.cancelLogin()));
app.post('/api/logout', (req, res) => res.json(agy.logout()));

// ---------- SANDBOX (Docker per chat) ----------
app.get('/api/sandbox/status', async (req, res) => {
  const slug = agy.slugify(req.query.chatId || 'default');
  res.json({ ok: true, slug, ...(await agySandbox.getSandboxInfo(slug)) });
});
app.post('/api/sandbox/reset', async (req, res) => {
  const slug = agy.slugify(req.body?.chatId || 'default');
  const removed = await agySandbox.resetSandbox(slug);
  // Container dibuat ulang otomatis (beserta install agy) saat chat berikutnya berjalan.
  res.json({ ok: removed, slug, note: 'Container direset; akan dibuat ulang otomatis saat chat berikutnya.' });
});

// ---------- FRONTEND ----------
const dist = path.join(__dirname, '../dist');
app.use(express.static(dist));
app.get(/^\/(?!api\/|health$).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));

// ---------- REAPER: stop container sandbox yang idle ----------
const IDLE_MIN = parseFloat(process.env.AGY_SANDBOX_IDLE_MIN || '30');
if (IDLE_MIN > 0) {
  agySandbox.startIdleReaper({
    idleMs: IDLE_MIN * 60 * 1000,
    isBusy: (slug) => jobs.isJobRunning(slug) || (slug === 'default' && !!agy.getLoginState()),
  });
}

app.listen(PORT, '0.0.0.0', () => console.log(`[server] AntiGPT + agybot logic di port ${PORT} | sandbox=${agy.SANDBOX_IMAGE} (agy dieksekusi di Docker) | auth=${process.env.AUTH_TOKEN ? '.env' : 'token sementara'} | idle-stop=${IDLE_MIN} mnt`));
