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
const { buildElicitationAnswer } = await import('./acpClient.js');
const { summarizeSession, parseTranscriptMessages } = await import('./transcriptParser.js');
const { scanLibrary } = await import('./libraryScanner.js');

const app = express();
app.set('trust proxy', true); // supaya req.secure / req.ip benar di belakang nginx / tunnel
app.use(express.json({ limit: '2mb' }));

const MAX_UPLOAD_FILES = Math.max(1, parseInt(process.env.MAX_UPLOAD_FILES || '20', 10) || 20);
const MAX_UPLOAD_MB = Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '100', 10) || 100);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const UPLOAD_TMP_DIR = path.join(__dirname, 'uploads', 'tmp');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
// Bersihkan sisa file upload sementara dari proses sebelumnya (mis. crash/restart saat upload berlangsung)
try {
  for (const name of fs.readdirSync(UPLOAD_TMP_DIR)) {
    fs.rmSync(path.join(UPLOAD_TMP_DIR, name), { recursive: true, force: true });
  }
} catch {}

// Pakai diskStorage (stream langsung ke disk) supaya upload besar/banyak tidak memakan RAM Node (limit PM2 1G).
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_TMP_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName(file.originalname)}`),
  }),
  limits: { files: MAX_UPLOAD_FILES, fileSize: MAX_UPLOAD_BYTES },
});
const PORT = parseInt(process.env.PORT || '3000', 10);

// ---------- HEALTH ----------
app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'antigpt' }));

// ---------- AUTH (token di .env) ----------
// Browser: POST /api/auth {token} → cookie httpOnly. Script/curl: header `Authorization: Bearer <token>`.
// Opsional: ADMIN_TOKEN mengunci manajemen akun (login/ganti akun/logout) & reset sandbox.
let AUTH_TOKEN = String(process.env.AUTH_TOKEN || '').trim();
if (!AUTH_TOKEN) {
  AUTH_TOKEN = crypto.randomBytes(24).toString('base64url');
  console.warn('[auth] ⚠️  AUTH_TOKEN belum di-set di .env — memakai token sementara (berubah tiap restart):');
  console.warn(`[auth]     ${AUTH_TOKEN}`);
}
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const ADMIN_ENABLED = !!ADMIN_TOKEN;
const AUTH_COOKIE = 'antigpt_auth';
const ADMIN_COOKIE = 'antigpt_admin';
const cookieValue = crypto.createHmac('sha256', AUTH_TOKEN).update('antigpt-cookie-v1').digest('base64url');
const adminCookieValue = ADMIN_ENABLED
  ? crypto.createHmac('sha256', ADMIN_TOKEN).update('antigpt-admin-cookie-v1').digest('base64url')
  : '';
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
function isAdmin(req) {
  if (!ADMIN_ENABLED) return true;
  const adminHdr = String(req.headers['x-admin-token'] || '').trim();
  if (adminHdr && safeEqual(adminHdr, ADMIN_TOKEN)) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (bearer && safeEqual(bearer.trim(), ADMIN_TOKEN)) return true;
  const c = readCookie(req, ADMIN_COOKIE);
  return !!c && safeEqual(c, adminCookieValue);
}
function isAuthed(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (bearer && safeEqual(bearer.trim(), AUTH_TOKEN)) return true;
  const c = readCookie(req, AUTH_COOKIE);
  if (c && safeEqual(c, cookieValue)) return true;
  return ADMIN_ENABLED && isAdmin(req);
}
function setCookie(req, res, name, value, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
// rate limit percobaan token salah: 10x / 15 menit per IP
const authFails = new Map();
const adminFails = new Map();
const FAIL_WINDOW = 15 * 60 * 1000, FAIL_MAX = 10;
const isRateLimited = (map, ip) => {
  const rec = map.get(ip);
  if (rec && Date.now() - rec.first > FAIL_WINDOW) { map.delete(ip); return false; }
  return !!rec && rec.count >= FAIL_MAX;
};
const recordFail = (map, ip) => {
  const cur = map.get(ip);
  map.set(ip, cur ? { ...cur, count: cur.count + 1 } : { first: Date.now(), count: 1 });
};

app.get('/api/auth', (req, res) => {
  const authed = isAuthed(req);
  res.json({ ok: true, authed, adminEnabled: ADMIN_ENABLED, isAdmin: authed && isAdmin(req) });
});
app.post('/api/auth', (req, res) => {
  const ip = req.ip || 'unknown';
  if (isRateLimited(authFails, ip)) {
    return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  }
  const token = String(req.body?.token || '').trim();
  const okUser = safeEqual(token, AUTH_TOKEN);
  const okAdmin = ADMIN_ENABLED && safeEqual(token, ADMIN_TOKEN);
  if (!okUser && !okAdmin) {
    recordFail(authFails, ip);
    return setTimeout(() => res.status(401).json({ ok: false, error: 'Token salah.' }), 600);
  }
  authFails.delete(ip);
  setCookie(req, res, AUTH_COOKIE, cookieValue, 60 * 60 * 24 * 365);
  if (okAdmin) setCookie(req, res, ADMIN_COOKIE, adminCookieValue, 60 * 60 * 24 * 365);
  else setCookie(req, res, ADMIN_COOKIE, '', 0);
  res.json({ ok: true, authed: true, isAdmin: !ADMIN_ENABLED || okAdmin });
});
app.post('/api/auth/logout', (req, res) => {
  setCookie(req, res, AUTH_COOKIE, '', 0);
  setCookie(req, res, ADMIN_COOKIE, '', 0);
  res.json({ ok: true });
});
// Semua /api/* lain wajib terautentikasi
app.use('/api', (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ ok: false, auth: false, error: 'Unauthorized' });
});
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(403).json({ ok: false, adminRequired: true, error: 'Butuh kunci admin untuk aksi ini.' });
}
app.post('/api/admin/auth', (req, res) => {
  if (!ADMIN_ENABLED) return res.json({ ok: true, isAdmin: true });
  const ip = req.ip || 'unknown';
  if (isRateLimited(adminFails, ip)) {
    return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  }
  if (!safeEqual(String(req.body?.token || '').trim(), ADMIN_TOKEN)) {
    recordFail(adminFails, ip);
    // 403 (bukan 401) agar browser tidak logout dari sesi chat utama
    return setTimeout(() => res.status(403).json({ ok: false, error: 'Kunci admin salah.' }), 600);
  }
  adminFails.delete(ip);
  setCookie(req, res, ADMIN_COOKIE, adminCookieValue, 60 * 60 * 24 * 365);
  res.json({ ok: true, isAdmin: true });
});
app.post('/api/admin/logout', (req, res) => {
  setCookie(req, res, ADMIN_COOKIE, '', 0);
  res.json({ ok: true, isAdmin: !ADMIN_ENABLED });
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
const videoTypes = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.ogv': 'video/ogg',
};
const audioTypes = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
};
const inlineMediaTypes = {
  ...imageTypes,
  ...videoTypes,
  ...audioTypes,
  '.pdf': 'application/pdf',
};
const fileTypes = {
  ...inlineMediaTypes,
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
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

function serveChatProjectFile(req, res, { imageOnly = false, mediaOnly = false, download = false } = {}) {
  const rawParam = req.params.filename || req.params[0] || '';
  let filename = String(rawParam);
  try { filename = decodeURIComponent(filename); } catch {}

  const filePath = resolveChatFile(req.params.chatId, filename, { imageOnly });
  if (!filePath) return res.sendStatus(404);

  try {
    const ext = path.extname(filePath).toLowerCase();
    if (mediaOnly && !inlineMediaTypes[ext]) return res.sendStatus(404);

    const stat = fs.statSync(filePath);
    const maxMb = mediaOnly ? 250 : (imageOnly ? 25 : 100);
    if (stat.size > maxMb * 1024 * 1024) return res.sendStatus(413);

    res.set('Content-Type', imageOnly ? imageTypes[ext] : (fileTypes[ext] || 'application/octet-stream'));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=300');
    if (!download && ext === '.svg') {
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }

    const downloadName = path.basename(filePath).replace(/^\d{10,}-[a-zA-Z0-9]{6,12}-/, '') || path.basename(filePath);
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
app.get('/api/chats/:chatId/media/:filename(*)', (req, res) => serveChatProjectFile(req, res, { mediaOnly: true, download: false }));
app.get('/api/chats/:chatId/files/:filename(*)', (req, res) => serveChatProjectFile(req, res, { download: true }));

// Pratinjau teks/kode/Markdown/CSV/JSON secara aman (maks 1 MB, dikembalikan sebagai JSON bukan HTML dieksekusi)
const previewTextExts = new Set([
  '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.bash', '.zsh',
  '.html', '.htm', '.css', '.scss', '.less', '.sql', '.yaml', '.yml', '.toml',
  '.ini', '.conf', '.cfg', '.xml', '.svg', '.env', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.lua', '.swift', '.dart',
  '.r', '.vue', '.svelte', '.graphql', '.prisma', '.gitignore',
]);
const MAX_PREVIEW_BYTES = 1024 * 1024; // 1 MB

app.get('/api/chats/:chatId/preview/:filename(*)', (req, res) => {
  const rawParam = req.params.filename || req.params[0] || '';
  let filename = String(rawParam);
  try { filename = decodeURIComponent(filename); } catch {}

  const filePath = resolveChatFile(req.params.chatId, filename);
  if (!filePath) return res.status(404).json({ ok: false, error: 'File tidak ditemukan.' });

  const ext = path.extname(filePath).toLowerCase();
  if (!previewTextExts.has(ext)) {
    return res.status(415).json({ ok: false, error: 'Format file ini tidak mendukung pratinjau teks.' });
  }

  let fd;
  try {
    const stat = fs.statSync(filePath);
    const readBytes = Math.min(stat.size, MAX_PREVIEW_BYTES);
    const buf = Buffer.alloc(readBytes);
    fd = fs.openSync(filePath, 'r');
    const n = readBytes > 0 ? fs.readSync(fd, buf, 0, readBytes, 0) : 0;
    const slice = buf.subarray(0, n);
    // Tolak file biner (terdeteksi null byte di 8 KB awal)
    if (slice.subarray(0, Math.min(n, 8192)).includes(0)) {
      return res.status(415).json({ ok: false, error: 'File biner tidak dapat ditampilkan sebagai teks.' });
    }
    res.set('Cache-Control', 'private, max-age=60');
    return res.json({
      ok: true,
      filename: path.basename(filePath),
      ext: ext.slice(1),
      size: stat.size,
      truncated: stat.size > MAX_PREVIEW_BYTES,
      content: slice.toString('utf8'),
    });
  } catch {
    return res.status(404).json({ ok: false, error: 'Gagal membaca file.' });
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
});

function cleanupTempFiles(files = []) {
  for (const file of files || []) {
    if (file?.path) {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }
}

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err?.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

function persistUploads(chatId, files = []) {
  if (!files.length) return [];
  const slug = agy.slugify(chatId || 'default');
  // Upload ditulis langsung ke workspace chat (ter-mount sebagai /home/AntiGPT di sandbox),
  // supaya agy bisa membacanya. path di prompt memakai path versi sandbox.
  const dir = path.join(agy.BASE, slug, 'project', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  try {
    for (const file of files) {
      const storedName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName(file.originalname)}`;
      const dest = path.join(dir, storedName);
      if (file.path) moveFile(file.path, dest);
      else if (file.buffer) fs.writeFileSync(dest, file.buffer);
      saved.push({ name: file.originalname, type: file.mimetype, size: file.size, path: `/home/AntiGPT/project/uploads/${storedName}` });
    }
    return saved;
  } catch (err) {
    cleanupTempFiles(files);
    throw err;
  }
}

function promptWithAttachments(text, files = []) {
  if (!files.length) return String(text || '');
  const attachmentText = files.map((file) => `- ${file.name} (${file.type || 'file'}): ${file.path}`).join('\n');
  const instruction = String(text || '').trim() || 'Analisis file terlampir secara detail dan jelaskan temuan utamanya.';
  return `${instruction}\n\n[ATTACHMENTS]\nPengguna melampirkan file berikut. Baca atau lihat file tersebut sebelum menjawab, lalu gunakan isinya sebagai konteks utama:\n${attachmentText}`;
}

// ---------- STATUS ----------
app.get('/api/status', (req, res) => {
  const admin = isAdmin(req);
  res.json({
    ok: true,
    email: agy.whoamiEmail(),
    loggedIn: !!agy.whoamiEmail(),
    running: agy.runningCount(),
    maxParallel: agy.MAX_PARALLEL,
    queued: agy.queuedCount(),
    mode: agy.AGY_MODE,
    adminEnabled: ADMIN_ENABLED,
    isAdmin: admin,
    login: admin ? agy.getLoginState() : null,
    limits: { files: MAX_UPLOAD_FILES, fileSizeMb: MAX_UPLOAD_MB },
  });
});

// ---------- MODELS (agy models) ----------
// Cache per akun dengan TTL 10 menit + dedupe request bersamaan; ?refresh=1 ambil realtime.
// Daftar kosong tidak menimpa cache lama (misal saat timeout sementara).
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let modelsCache = { email: undefined, at: 0, models: null, pending: null };
app.get('/api/models', async (req, res) => {
  const email = agy.whoamiEmail() || null;
  const force = !!req.query.refresh;
  const fresh = modelsCache.email === email
    && Array.isArray(modelsCache.models) && modelsCache.models.length > 0
    && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS;

  if (force || !fresh) {
    if (!modelsCache.pending || modelsCache.email !== email) {
      const prevModels = modelsCache.email === email && Array.isArray(modelsCache.models)
        ? modelsCache.models : null;
      const prevAt = modelsCache.email === email ? modelsCache.at : 0;
      modelsCache.email = email;
      modelsCache.pending = agy.listModels()
        .then((list) => {
          if (Array.isArray(list) && list.length > 0) {
            modelsCache = { email, at: Date.now(), models: list, pending: null };
          } else {
            modelsCache = { email, at: prevAt, models: prevModels || [], pending: null };
          }
          return modelsCache.models;
        })
        .catch(() => {
          modelsCache = { email, at: prevAt, models: prevModels || [], pending: null };
          return modelsCache.models;
        });
    }
    const list = await modelsCache.pending;
    return res.json({
      ok: true,
      email,
      models: list || [],
      default: agy.DEFAULT_MODEL,
      at: modelsCache.at || null,
    });
  }
  res.json({
    ok: true,
    email,
    models: modelsCache.models,
    default: agy.DEFAULT_MODEL,
    at: modelsCache.at || null,
    cached: true,
  });
});

// ---------- CHAT ----------
// body: { chatId, title, text, model }
app.post('/api/chat', upload.array('files', MAX_UPLOAD_FILES), async (req, res, next) => {
  try {
    const { chatId, text, model } = req.body || {};
    // validasi & cek login DULU, baru simpan upload ke folder sesi (hindari file yatim)
    if ((!text || !String(text).trim()) && !req.files?.length) {
      cleanupTempFiles(req.files);
      return res.status(400).json({ ok: false, error: 'teks atau file kosong' });
    }
    if (!agy.whoamiEmail()) {
      cleanupTempFiles(req.files);
      return res.json({ ok: false, needLogin: true, error: 'Belum login. Buka menu Akun → Login dengan Google.' });
    }
    const files = persistUploads(chatId, req.files);

    const slug = agy.slugify(chatId || 'default');
    agy.topicDir(slug);
    const st = agy.readState(slug);
    if (model) st.model = model;
    if (!st.model) st.model = agy.DEFAULT_MODEL;
    if (!st.title) st.title = (String(text || '').replace(/\s+/g, ' ').trim() || files[0]?.name || slug).slice(0, 80);
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
  } catch (err) {
    cleanupTempFiles(req.files);
    next(err);
  }
});

// ---------- CHAT STREAM (NDJSON) — timeline proses agy (tool, durasi, teks bertahap) ----------
// Setiap baris = 1 JSON: {type:'step', step}, {type:'delta', text}, {type:'queued'}, {type:'done', ...}
function toolLabel(name, p = {}, fallbackTitle = '') {
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
    ask_question: () => {
      const qs = Array.isArray(p.questions) ? p.questions : [];
      return `Bertanya: ${qs[0]?.question || ''}${qs.length > 1 ? ` (+${qs.length - 1} pertanyaan)` : ''}`;
    },
    invoke_subagent: () => `Subagent: ${p.Role || p.TypeName || 'background'}`,
    run_workflow: () => `Workflow: ${p.Description || 'menjalankan alur kerja'}`,
    schedule: () => 'Menjadwalkan timer',
  };
  return (map[name] ? map[name]() : (fallbackTitle || name.replace(/_/g, ' '))).slice(0, 160);
}
const toolKind = (n) => /command|terminal/.test(n) ? 'terminal' : /write|edit|replace/.test(n) ? 'edit'
  : /read|view|list|grep|find|search_file/.test(n) ? 'read' : /web|url|browser/.test(n) ? 'web'
  : /question/.test(n) ? 'question' : 'tool';

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
  let partial = '';
  const questionOutputs = new Map(); // toolCallId → ringkasan jawaban user untuk ditampilkan di output step
  // onEvent menerima event netral dari agy.js (sama untuk mode acp & print)
  const onEvent = (ev) => {
    if (ev.kind === 'session' && ev.id) {
      job.conversationId = ev.id;
      return;
    }
    if (ev.kind === 'tool') {
      const done = ev.status !== 'running';
      job.emit({ type: 'step', step: {
        id: ev.id, kind: toolKind(ev.name || ''), tool: ev.name, label: toolLabel(ev.name || 'tool', ev.params || {}, ev.title || ''),
        status: done ? 'done' : 'running',
        error: ev.status === 'error' || undefined,
        duration: ev.duration ?? null,
        output: ev.output ?? (done ? questionOutputs.get(ev.id) ?? null : null),
      } });
    } else if (ev.kind === 'delta') {
      partial += ev.text;
      job.emit({ type: 'delta', text: ev.text });
    } else if (ev.kind === 'thought') {
      // teks proses berpikir (mode acp) — dikirim bertahap, klien menyambungnya per id
      job.emit({ type: 'thought', id: ev.id, text: ev.text });
    } else if (ev.kind === 'status' && ev.text) {
      job.emit({ type: 'status', text: ev.text });
    } else if (ev.kind === 'think') {
      // mode print: hanya durasi & token mikir
      job.emit({ type: 'step', step: { id: ev.id, kind: 'think', label: 'Berpikir', status: 'done',
        duration: ev.duration ?? null, thinkingTokens: ev.thinkingTokens ?? null } });
    }
  };

  // AI memakai ask_question → kirim event `question` ke klien, tunggu POST /api/chat/answer.
  const signal = job.controller.signal;
  const onQuestion = (q) => new Promise((resolve) => {
    const id = crypto.randomUUID().slice(0, 12);
    const timeoutMs = agy.QUESTION_TIMEOUT_MIN > 0 ? agy.QUESTION_TIMEOUT_MIN * 60 * 1000 : 0;
    let timer = null;
    const finish = (answer, info) => {
      if (job.question?.id !== id) return false;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      job.question = null;
      if (q.toolCallId) {
        if (info?.answered && Array.isArray(info.summary) && info.summary.length) {
          questionOutputs.set(q.toolCallId, info.summary.map((s) => `${s.title}\n→ ${s.answer || '(kosong)'}`).join('\n\n'));
        } else if (info?.skipped) {
          questionOutputs.set(q.toolCallId, info.timedOut ? 'Dilewati otomatis (batas waktu habis).' : 'Dilewati.');
        }
      }
      job.emit({ type: 'question_done', id, ...info });
      resolve(answer);
      return true;
    };
    const onAbort = () => finish({ action: 'cancel' }, { cancelled: true });
    job.question = { id, q, finish };
    if (timeoutMs) {
      timer = setTimeout(() => finish({ action: 'decline' }, { skipped: true, timedOut: true }), timeoutMs);
      timer.unref?.();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    job.emit({ type: 'question', question: {
      id, message: q.message, fields: q.fields,
      expiresAt: timeoutMs ? Date.now() + timeoutMs : null,
    } });
  });

  try {
    if (agy.isQueueFull()) job.emit({ type: 'queued' });
    const r = await agy.runQueued(slug, () => {
      job.emit({ type: 'start' });
      return agy.agyPromptLive(slug, prompt, st.model, st.conversation_id, onEvent, signal, { onQuestion });
    }, signal);
    const raw = r.raw_output || r.response || '';
    // Jangan tulis ulang state.json kalau obrolan sudah dihapus (cegah folder yatim setelah DELETE)
    if (job.deleted) {
      if (r.conversation_id) agy.deleteConversationData(r.conversation_id);
    } else {
      if (r.conversation_id) st.conversation_id = r.conversation_id;
      if (r.usage) { st.last_usage = r.usage; st.last_model = st.model; st.last_ts = Date.now(); }
      agy.writeState(slug, st);
    }
    const cancelled = signal.aborted || r.status === 'CANCELLED';
    const timedOut = !cancelled && r.timedOut ? r.timedOut : null;
    const lim = cancelled ? null : (r.limitDetected || null);
    let answer = cancelled ? '' : (r.response || '');
    if (timedOut) {
      const note = `⏱️ ${r.response}`;
      answer = partial ? `${partial}\n\n${note}` : note;
    }
    job.emit({
      type: 'done', ok: !cancelled && r.status === 'SUCCESS', cancelled, timedOut,
      answer, model: st.model, usage: r.usage || null,
      durationSec: Math.round((Date.now() - started) / 1000),
      limit: lim ? { ...lim, resetIn: agy.extractResetIn(raw) } : null,
      needLogin: !cancelled && (!!agy.extractLoginUrl(raw) || /not (logged|signed) in|login required|unauthenticated|auth(entication)? required/i.test(raw)),
    });
  } catch (e) {
    job.emit({ type: 'done', ok: false, answer: `Error: ${e.message || e}`, durationSec: Math.round((Date.now() - started) / 1000) });
  }
}

// Mulai job baru untuk chat ini, lalu stream event-nya.
app.post('/api/chat/stream', upload.array('files', MAX_UPLOAD_FILES), async (req, res) => {
  try {
    const { chatId, text, model } = req.body || {};
    // validasi & cek login DULU, baru simpan upload ke folder sesi (hindari file yatim)
    if ((!text || !String(text).trim()) && !req.files?.length) {
      cleanupTempFiles(req.files);
      return ndjsonOnce(res, { type: 'done', ok: false, answer: 'Error: teks atau file kosong' });
    }
    if (!agy.whoamiEmail()) {
      cleanupTempFiles(req.files);
      return ndjsonOnce(res, { type: 'done', ok: false, needLogin: true, answer: 'Belum login. Buka menu Akun → Login dengan Google.' });
    }

    const slug = agy.slugify(chatId || 'default');
    if (jobs.isJobRunning(slug)) {
      cleanupTempFiles(req.files);
      return ndjsonOnce(res, { type: 'done', ok: false, busy: true, answer: 'Chat ini masih memproses pesan sebelumnya.' });
    }

    const files = persistUploads(chatId, req.files);
    agy.topicDir(slug);
    const st = agy.readState(slug);
    if (model) st.model = model;
    if (!st.model) st.model = agy.DEFAULT_MODEL;
    if (!st.title) st.title = (String(text || '').replace(/\s+/g, ' ').trim() || files[0]?.name || slug).slice(0, 80);
    agy.writeState(slug, st);

    const userAttachments = files.map((f) => ({
      name: f.name, type: f.type, size: f.size, stored: `uploads/${path.basename(f.path)}`,
    }));
    const job = jobs.createJob(slug, {
      userText: String(text || ''),
      userAttachments,
      model: st.model,
      title: st.title,
    });
    // Beri tahu klien lokasi upload (relatif ke folder project) supaya lampiran gambar
    // di pesan terkirim bisa ditampilkan lagi lewat /api/chats/:chatId/images/...
    if (files.length) {
      job.emit({ type: 'uploads', files: files.map((f) => ({ name: f.name, stored: `uploads/${path.basename(f.path)}` })) });
    }
    runChatJob(job, slug, promptWithAttachments(text, files), st); // sengaja tidak di-await
    pipeJob(job, 0, req, res);
  } catch (err) {
    cleanupTempFiles(req.files);
    if (!res.headersSent) ndjsonOnce(res, { type: 'done', ok: false, answer: `Error: ${err?.message || err}` });
  }
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

// Jawab popup pertanyaan AI (ask_question, mode acp).
// body: { chatId, questionId, answers: { q1: '2', q1_other: '...', q2: ['1','3'] } } atau { chatId, questionId, skip: true }
app.post('/api/chat/answer', (req, res) => {
  const { chatId, questionId, answers, skip } = req.body || {};
  const job = jobs.getJob(agy.slugify(chatId || 'default'));
  const pq = job?.question;
  if (!pq || pq.id !== questionId) return res.status(409).json({ ok: false, error: 'Pertanyaan ini sudah tidak aktif.' });
  if (skip) { pq.finish({ action: 'decline' }, { skipped: true }); return res.json({ ok: true }); }
  const { content, summary, error } = buildElicitationAnswer(pq.q, answers && typeof answers === 'object' ? answers : {});
  if (error) return res.status(400).json({ ok: false, error });
  if (!Object.keys(content).length) return res.status(400).json({ ok: false, error: 'Pilih atau tulis jawaban dulu.' });
  pq.finish({ action: 'accept', content }, { answered: true, summary });
  res.json({ ok: true });
});

// Hapus chat sepenuhnya: hentikan job, hapus container sandbox, folder sesi, & riwayat internal agy
app.delete('/api/chats/:chatId', async (req, res) => {
  const slug = agy.slugify(req.params.chatId);
  if (!slug || slug === 'default') return res.status(400).json({ ok: false, error: 'chatId tidak valid' });
  const convIds = new Set();
  const prevState = agy.readState(slug);
  if (prevState.conversation_id) convIds.add(prevState.conversation_id);
  const activeJob = jobs.getJob(slug);
  if (activeJob?.conversationId) convIds.add(activeJob.conversationId);

  jobs.deleteJob(slug);
  const removed = await agySandbox.resetSandbox(slug);
  const dir = path.resolve(agy.BASE, slug);
  let deletedDir = false;
  if (dir.startsWith(path.resolve(agy.BASE) + path.sep)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); deletedDir = true; } catch (e) { console.warn('[delete]', slug, e.message); }
  }
  let agyDataRemoved = 0;
  for (const id of convIds) agyDataRemoved += agy.deleteConversationData(id);
  res.json({ ok: true, slug, containerRemoved: removed, sessionDeleted: deletedDir, agyDataRemoved });
});

// reset percakapan 1 chat (hapus conversation_id & riwayat internal agy lama)
app.post('/api/chat/reset', (req, res) => {
  const slug = agy.slugify(req.body?.chatId || 'default');
  const st = agy.readState(slug);
  const prevId = st.conversation_id;
  delete st.conversation_id;
  agy.writeState(slug, st);
  const agyDataRemoved = prevId ? agy.deleteConversationData(prevId) : 0;
  res.json({ ok: true, agyDataRemoved });
});

// ---------- QUOTA (/usage asli dari CLI) — dedupe request bersamaan; ?refresh=1 ambil realtime ----------
let quotaCache = { email: null, at: 0, groups: null, pending: null };
app.get('/api/quota', async (req, res) => {
  const email = agy.whoamiEmail();
  if (!email) return res.json({ ok: false, needLogin: true });
  const fresh = quotaCache.email === email && quotaCache.groups && Date.now() - quotaCache.at < 15_000;
  if (!fresh || req.query.refresh) {
    // dedupe: request bersamaan untuk akun yang sama cukup menunggu 1 eksekusi agy
    if (!quotaCache.pending || quotaCache.email !== email) {
      const prevGroups = quotaCache.email === email ? quotaCache.groups : null;
      const prevAt = quotaCache.email === email ? quotaCache.at : 0;
      quotaCache.email = email;
      quotaCache.pending = agy.getQuota().then((groups) => {
        if (groups) quotaCache = { email, at: Date.now(), groups, pending: null };
        else quotaCache = { email, at: prevAt, groups: prevGroups, pending: null };
        return groups;
      });
    }
    const groups = await quotaCache.pending;
    return res.json({ ok: !!groups, email, groups: groups || [], at: groups ? quotaCache.at : null });
  }
  res.json({ ok: true, email, groups: quotaCache.groups, at: quotaCache.at, cached: true });
});

// ---------- LOGIN / LOGOUT (khusus admin jika ADMIN_TOKEN di-set) ----------
app.post('/api/login', requireAdmin, async (req, res) => res.json(await agy.startLogin()));
app.get('/api/login/status', requireAdmin, (req, res) =>
  res.json({ ok: true, active: agy.getLoginState(), result: agy.getLastLoginResult(), email: agy.whoamiEmail() }));
app.post('/api/login/code', requireAdmin, (req, res) => res.json(agy.submitLoginCode(req.body?.code || '')));
app.post('/api/login/cancel', requireAdmin, (req, res) => res.json(agy.cancelLogin()));
app.post('/api/logout', requireAdmin, (req, res) => res.json(agy.logout()));

// ---------- SANDBOX (Docker per chat) ----------
app.get('/api/sandbox/status', async (req, res) => {
  const slug = agy.slugify(req.query.chatId || 'default');
  res.json({ ok: true, slug, ...(await agySandbox.getSandboxInfo(slug)) });
});
app.post('/api/sandbox/reset', requireAdmin, async (req, res) => {
  const slug = agy.slugify(req.body?.chatId || 'default');
  const removed = await agySandbox.resetSandbox(slug);
  // Container dibuat ulang otomatis (beserta install agy) saat chat berikutnya berjalan.
  res.json({ ok: removed, slug, note: 'Container direset; akan dibuat ulang otomatis saat chat berikutnya.' });
});

// ---------- ADMIN CHATS (riwayat semua sesi di VPS — khusus pemegang ADMIN_TOKEN) ----------
const BRAIN_DIR = path.join(agySandbox.GEMINI_DATA_DIR, 'antigravity-cli', 'brain');

function jobStatusOf(aj, queuedSet) {
  if (!aj) return null;
  if (aj.hasQuestion) return 'question';
  if (aj.queued || queuedSet?.has(aj.slug)) return 'queued';
  return 'running';
}

app.get('/api/admin/chats', requireAdmin, async (req, res) => {
  const slugs = new Set();
  try {
    for (const entry of fs.readdirSync(agy.BASE, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'default' && !entry.name.startsWith('.')) {
        slugs.add(entry.name);
      }
    }
  } catch {}

  const activeList = jobs.listActiveJobs();
  const activeMap = new Map(activeList.map((j) => [j.slug, j]));
  const queuedSet = new Set(agy.queuedSlugs());
  for (const j of activeList) {
    if (j.slug && j.slug !== 'default') slugs.add(j.slug);
  }

  const sandboxes = await agySandbox.listSandboxes();
  const chats = [];
  for (const slug of slugs) {
    const sessionRoot = path.join(agy.BASE, slug);
    const sum = summarizeSession(slug, sessionRoot, BRAIN_DIR);
    const aj = activeMap.get(slug) || null;
    const sb = sandboxes.get(agySandbox.slugSafe(slug)) || null;
    if (aj) {
      if (sum.title === slug && aj.title) sum.title = aj.title;
      if (!sum.model && aj.model) sum.model = aj.model;
      sum.updatedAt = Math.max(sum.updatedAt, aj.updatedAt || aj.createdAt || 0);
    }
    chats.push({
      ...sum,
      jobStatus: jobStatusOf(aj, queuedSet),
      jobDetail: aj?.statusText || null,
      jobStartedAt: aj?.createdAt || null,
      containerState: sb?.state || null,
      containerStatus: sb?.status || null,
    });
  }

  chats.sort((a, b) => {
    const aLive = a.jobStatus ? 1 : 0;
    const bLive = b.jobStatus ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  res.json({
    ok: true,
    running: agy.runningCount(),
    queued: agy.queuedCount(),
    maxParallel: agy.MAX_PARALLEL,
    chats,
  });
});

app.get('/api/admin/chats/:chatId', requireAdmin, async (req, res) => {
  const slug = agy.slugify(req.params.chatId);
  if (!slug || slug === 'default') return res.status(400).json({ ok: false, error: 'chatId tidak valid' });

  const sessionRoot = path.resolve(agy.BASE, slug);
  if (!sessionRoot.startsWith(path.resolve(agy.BASE) + path.sep)) {
    return res.status(400).json({ ok: false, error: 'chatId tidak valid' });
  }
  const job = jobs.getJob(slug);
  const runningJob = job && !job.done && !job.deleted ? job : null;
  if (!fs.existsSync(sessionRoot) && !runningJob) {
    return res.status(404).json({ ok: false, error: 'Sesi tidak ditemukan.' });
  }

  const sum = summarizeSession(slug, sessionRoot, BRAIN_DIR);
  const convId = sum.conversationId || runningJob?.conversationId || null;
  const parsed = parseTranscriptMessages(BRAIN_DIR, convId, sessionRoot, { toolLabel, toolKind });
  let messages = parsed.messages;

  if (runningJob) {
    // Sisipkan/ganti giliran yang masih berjalan dengan placeholder streaming agar klien bisa replay live dari seq 0
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx] : null;
    const sameTurn = !!lastUser && (
      (lastUser.createdAt && lastUser.createdAt >= runningJob.createdAt - 15_000)
      || (lastUserIdx >= messages.length - 2 && String(lastUser.content || '').trim() === String(runningJob.userText || '').trim())
    );
    if (sameTurn) {
      messages = messages.slice(0, lastUserIdx + 1);
    } else {
      messages = [
        ...messages,
        {
          id: `live-user-${runningJob.createdAt}`,
          role: 'user',
          content: runningJob.userText || '',
          ...(runningJob.userAttachments?.length ? { attachments: runningJob.userAttachments } : {}),
          createdAt: runningJob.createdAt,
        },
      ];
    }
    messages.push({
      id: `live-ai-${runningJob.createdAt}`,
      role: 'assistant',
      content: '',
      steps: [],
      streaming: true,
      status: runningJob.statusText || 'Menyambung…',
      startedAt: runningJob.createdAt,
    });
  }

  const sandboxes = await agySandbox.listSandboxes();
  const sb = sandboxes.get(agySandbox.slugSafe(slug)) || null;
  const queuedSet = new Set(agy.queuedSlugs());
  const aj = runningJob ? {
    slug,
    queued: !!runningJob.queued,
    hasQuestion: !!runningJob.question,
    statusText: runningJob.statusText,
    createdAt: runningJob.createdAt,
  } : null;

  res.json({
    ok: true,
    chat: {
      ...sum,
      messages,
      jobStatus: jobStatusOf(aj, queuedSet),
      jobDetail: aj?.statusText || null,
      jobStartedAt: aj?.createdAt || null,
      containerState: sb?.state || null,
      containerStatus: sb?.status || null,
      activeJob: runningJob ? {
        running: true,
        queued: !!runningJob.queued || queuedSet.has(slug),
        hasQuestion: !!runningJob.question,
        statusText: runningJob.statusText || 'Berjalan…',
        startedAt: runningJob.createdAt,
      } : null,
    },
  });
});

app.patch('/api/admin/chats/:chatId', requireAdmin, (req, res) => {
  const slug = agy.slugify(req.params.chatId);
  if (!slug || slug === 'default') return res.status(400).json({ ok: false, error: 'chatId tidak valid' });
  const sessionRoot = path.resolve(agy.BASE, slug);
  if (!sessionRoot.startsWith(path.resolve(agy.BASE) + path.sep) || !fs.existsSync(sessionRoot)) {
    return res.status(404).json({ ok: false, error: 'Sesi tidak ditemukan.' });
  }
  const st = agy.readState(slug);
  const { title, pinned, model } = req.body || {};
  if (typeof title === 'string' && title.trim()) st.title = title.trim().slice(0, 120);
  if (typeof pinned === 'boolean') st.pinned = pinned;
  if (typeof model === 'string' && model.trim()) st.model = model.trim();
  agy.writeState(slug, st);
  res.json({ ok: true, chat: { id: slug, title: st.title, pinned: !!st.pinned, model: st.model || null } });
});

app.post('/api/admin/chats/:chatId/sleep', requireAdmin, async (req, res) => {
  const slug = agy.slugify(req.params.chatId);
  if (!slug || slug === 'default') return res.status(400).json({ ok: false, error: 'chatId tidak valid' });
  if (jobs.isJobRunning(slug)) {
    return res.status(409).json({ ok: false, error: 'Chat masih berjalan. Hentikan dulu sebelum menidurkan sandbox.' });
  }
  const stopped = await agySandbox.stopSandbox(slug);
  res.json({ ok: true, slug, stopped });
});

// ---------- ARTEFAK (buatan AI) & DROPLY (kiriman User) ----------
app.post('/api/library', (req, res) => {
  const scope = req.body?.scope === 'droply' ? 'droply' : 'artifacts';
  const allServer = !!req.body?.allServer;

  let chatInputs = [];
  if (allServer) {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, adminRequired: true, error: 'Butuh kunci admin.' });
    }
    try {
      const entries = fs.readdirSync(agy.BASE, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'default') continue;
        const sessionDir = path.join(agy.BASE, ent.name);
        const sum = summarizeSession(ent.name, sessionDir, BRAIN_DIR);
        if (sum) chatInputs.push({ id: sum.id, title: sum.title, updatedAt: sum.updatedAt });
      }
    } catch (err) {
      console.error('[library] gagal memindai daftar sesi admin:', err);
    }
  } else {
    const rawList = Array.isArray(req.body?.chats) ? req.body.chats.slice(0, 500) : [];
    chatInputs = rawList
      .filter((c) => c && typeof c.id === 'string' && c.id.trim())
      .map((c) => ({
        id: c.id.trim(),
        title: typeof c.title === 'string' ? c.title.slice(0, 120) : '',
        updatedAt: Number(c.updatedAt) || 0,
        refs: Array.isArray(c.refs) ? c.refs.slice(0, 400) : undefined,
        links: Array.isArray(c.links) ? c.links.slice(0, 400) : undefined,
      }));
  }

  const result = scanLibrary({
    scope,
    chats: chatInputs,
    agy,
    brainBaseDir: BRAIN_DIR,
    resolveChatFile,
  });

  res.json({ ok: true, scope, ...result });
});

// ---------- UNDUH APK ANDROID ----------
const APK_FILE = path.join(__dirname, '../releases/AntiGPT.apk');
const APK_META_FILE = path.join(__dirname, '../releases/apk-meta.json');

function readApkInfo() {
  try {
    if (!fs.existsSync(APK_FILE)) return null;
    const stat = fs.statSync(APK_FILE);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(APK_META_FILE, 'utf8')); } catch {}
    return {
      exists: true,
      filename: 'AntiGPT.apk',
      sizeBytes: stat.size,
      sizeLabel: `${(stat.size / (1024 * 1024)).toFixed(2)} MB`,
      versionName: meta.versionName || '1.0.0',
      versionCode: meta.versionCode || 1,
      builtAt: meta.builtAt || stat.mtime.toISOString(),
      sha256: meta.sha256 || '',
    };
  } catch {
    return null;
  }
}

function sendApk(req, res) {
  if (!fs.existsSync(APK_FILE)) {
    return res.status(404).json({ ok: false, error: 'File AntiGPT.apk belum tersedia.' });
  }
  res.set('Content-Type', 'application/vnd.android.package-archive');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-cache');
  return res.download(APK_FILE, 'AntiGPT.apk');
}

app.get(['/AntiGPT.apk', '/download/AntiGPT.apk'], sendApk);

app.get('/download', (req, res) => {
  const info = readApkInfo();
  const available = !!info?.exists;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#faf9f5" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <title>Unduh AntiGPT untuk Android</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg:#faf9f5; --surface:#fff; --panel:#f5f4ef; --border:#e5e3dc; --text:#1f1e1d; --muted:#6b6a66; --accent:#c96442; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#171614; --surface:#272522; --panel:#211f1c; --border:#403c36; --text:#f3f0e9; --muted:#aaa49a; --accent:#e48763; }
    }
    body { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: calc(20px + env(safe-area-inset-top, 0px)) 16px calc(24px + env(safe-area-inset-bottom, 0px)); background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; }
    .card { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: 24px; padding: 28px 22px; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,.06); }
    .mark { width: 72px; height: 72px; margin: 0 auto 14px; border-radius: 18px; background: var(--panel); border: 1px solid var(--border); display: grid; place-items: center; }
    .mark img { width: 50px; height: 50px; object-fit: contain; }
    h1 { font-family: Georgia, serif; font-weight: 400; font-size: 28px; margin-bottom: 6px; }
    .sub { color: var(--muted); font-size: 14.5px; line-height: 1.5; margin-bottom: 20px; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 18px; }
    .meta-box { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 10px; }
    .meta-box small { display: block; color: var(--muted); font-size: 11.5px; margin-bottom: 2px; }
    .meta-box strong { font-size: 14px; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 14px 18px; border-radius: 14px; background: var(--accent); color: #fff; font-weight: 600; font-size: 15.5px; text-decoration: none; margin-bottom: 10px; }
    .btn.secondary { background: var(--panel); color: var(--text); border: 1px solid var(--border); font-size: 14.5px; margin-bottom: 0; }
    .steps { text-align: left; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); line-height: 1.6; }
    .steps ol { padding-left: 18px; margin-top: 6px; }
    .sha { margin-top: 10px; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: var(--muted); word-break: break-all; }
  </style>
</head>
<body>
  <main class="card">
    <div class="mark"><img src="/logo.png" alt="AntiGPT" /></div>
    <h1>AntiGPT</h1>
    <p class="sub">Aplikasi Android resmi AntiGPT — tampilan pas untuk layar HP, bebas tabrakan status bar &amp; navigasi.</p>
    ${available ? `
      <div class="meta">
        <div class="meta-box"><small>Versi</small><strong>v${info.versionName}</strong></div>
        <div class="meta-box"><small>Ukuran</small><strong>${info.sizeLabel}</strong></div>
      </div>
      <a class="btn" href="/AntiGPT.apk" download="AntiGPT.apk">Unduh AntiGPT.apk</a>
      <a class="btn secondary" href="/">Buka versi Web</a>
      <div class="steps">
        <strong>Cara pasang:</strong>
        <ol>
          <li>Ketuk <b>Unduh AntiGPT.apk</b> lalu tunggu unduhan selesai.</li>
          <li>Buka file <b>AntiGPT.apk</b> dari notifikasi / File Manager.</li>
          <li>Jika diminta, aktifkan <b>Izinkan dari sumber ini</b>, lalu ketuk <b>Pasang</b>.</li>
        </ol>
        ${info.sha256 ? `<div class="sha">SHA-256: ${info.sha256}</div>` : ''}
      </div>
    ` : `
      <p class="sub">APK sedang disiapkan. Silakan coba lagi sebentar lagi.</p>
      <a class="btn secondary" href="/">Kembali ke AntiGPT</a>
    `}
  </main>
</body>
</html>`);
});

// ---------- FRONTEND ----------
const dist = path.join(__dirname, '../dist');
app.use(express.static(dist));
app.get(/^\/(?!api\/|health$|download(?:\/|$)|AntiGPT\.apk$).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));

// ---------- ERROR HANDLER (termasuk MulterError agar tidak jatuh ke HTTP 500 polos) ----------
app.use((err, req, res, _next) => {
  cleanupTempFiles(req.files);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        ok: false,
        code: err.code,
        error: `Ukuran file${err.filename ? ` "${err.filename}"` : ''} melebihi batas maksimal ${MAX_UPLOAD_MB} MB per file.`,
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        ok: false,
        code: err.code,
        error: `Jumlah file melebihi batas maksimal ${MAX_UPLOAD_FILES} file per kirim.`,
      });
    }
    return res.status(400).json({
      ok: false,
      code: err.code,
      error: `Upload gagal (${err.code}): ${err.message}`,
    });
  }
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return;
  const status = err?.status || err?.statusCode || 500;
  res.status(status).json({ ok: false, error: err?.message || 'Internal Server Error' });
});

// ---------- REAPER: stop container sandbox yang idle ----------
const IDLE_MIN = parseFloat(process.env.AGY_SANDBOX_IDLE_MIN || '30');
if (IDLE_MIN > 0) {
  agySandbox.startIdleReaper({
    idleMs: IDLE_MIN * 60 * 1000,
    isBusy: (slug) => jobs.isJobRunning(slug) || (slug === 'default' && !!agy.getLoginState()),
  });
}

app.listen(PORT, '0.0.0.0', () => console.log(`[server] AntiGPT + agybot logic di port ${PORT} | sandbox=${agy.SANDBOX_IMAGE} (agy dieksekusi di Docker) | auth=${process.env.AUTH_TOKEN ? '.env' : 'token sementara'} | admin=${ADMIN_ENABLED ? '.env' : 'nonaktif'} | idle-stop=${IDLE_MIN} mnt | prompt-timeout=idle ${agy.PROMPT_IDLE_MIN}m / max ${agy.PROMPT_MAX_MIN}m`));
