// Logic inti AntiGPT (port agybot/bot.js, tanpa Telegram).
// agy TIDAK lagi dieksekusi langsung di host — semua proses agy berjalan di dalam
// sandbox Docker per chat (lihat sandboxManager.js), jadi agy bebas install apa pun
// tanpa menyentuh server.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureSandbox, spawnInSandbox, killAgy,
  getSafeContainerName, AGY_BIN_IN_SANDBOX, SANDBOX_IMAGE, GEMINI_DATA_DIR, SANDBOX_HOME,
} from './sandboxManager.js';
import { runAcpTurn } from './acpClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export { SANDBOX_IMAGE, getSafeContainerName };
// Token OAuth disimpan di folder state agy yang ter-mount ke /root/.gemini semua
// container sandbox, jadi bisa dibaca langsung dari host.
export const TOKEN_FILE = process.env.AGY_TOKEN_FILE || path.join(GEMINI_DATA_DIR, 'antigravity-cli/antigravity-oauth-token');
export const BASE = path.join(__dirname, 'sessions');
const TOKEN_BAK = path.join(__dirname, 'auth-backup', 'antigravity-oauth-token.bak');
export const DEFAULT_MODEL = 'gemini-3.8-flash-high'; // fallback sama dgn bot.js

fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });

// ---------- auth ----------
export function whoamiEmail() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).id_token_email || '(email tidak diketahui)'; }
  catch { return null; }
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
export function extractLoginUrl(buf) {
  const m = stripAnsi(String(buf)).match(/https:\/\/accounts\.google\.com\S*/);
  return m ? m[0].trim() : null;
}

// ---------- sesi (1 chat web = 1 folder, seperti 1 topic di bot) ----------
export const slugify = (s) => (s || 'sesi').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sesi';

export function topicDir(slug) {
  const d = path.join(BASE, slug);
  fs.mkdirSync(path.join(d, 'project'), { recursive: true });
  return _topicDir(d, slug);
}
function _topicDir(d, slug) {
  const agentsMd = path.join(d, 'AGENTS.md');
  const imageGuide = '\n\n## Menampilkan gambar di chat\nJika membuat gambar untuk pengguna, pastikan file final disimpan di folder ./project/ (atau folder kerja) dalam format PNG, JPG, WebP, GIF, AVIF, atau SVG. Cantumkan gambar di jawaban memakai Markdown dengan nama file relatif, misalnya ![Deskripsi gambar](gambar.png). Jika menampilkan beberapa gambar sekaligus agar rapi dalam grid 2 kolom, tulis berurutan dalam 1 paragraf tanpa baris kosong pemisah. Jangan gunakan URL file:// atau path absolut; salin gambar hasil generate ke ./project/ terlebih dahulu.\n';
  const mediaGuideHeading = '## Menampilkan video, audio, diagram & format kaya di chat';
  const mediaGuide = `\n\n${mediaGuideHeading}\n- **Tampil / putar langsung (pakai tanda \`!\` di luar tabel):**\n  - Video (.mp4 codec H.264 yuv420p + audio AAC + faststart, .webm, .mov): \`![Judul video](video.mp4)\` → tampil langsung sebagai Video Player + tombol unduh.\n  - Audio (.mp3, .wav, .ogg, .m4a): \`![Judul audio](audio.mp3)\` → tampil langsung sebagai Audio Player + tombol unduh.\n  - PDF (.pdf): \`![Judul dokumen](dokumen.pdf)\` → kartu pratinjau (Buka) + tombol unduh.\n  - Multi-foto grid: tulis beberapa \`![Deskripsi](file.png)\` berurutan dalam 1 paragraf tanpa baris kosong pemisah agar tampil sebagai grid 2 kolom & galeri geser.\n- **Kartu file unduh saja (tanpa \`!\`):** pakai \`[nama.ext](nama.ext)\` untuk daftar unduhan (atau jika hanya ingin memberi tombol unduh tanpa memutar inline). File media yang sudah ditampilkan langsung dengan \`![...]\` sudah punya tombol Unduh sendiri, jadi tidak perlu diulang di daftar unduhan kecuali diminta.\n- **File di dalam tabel:** tautan file di dalam sel tabel otomatis tampil sebagai chip ringkas 1 baris.\n- **Markdown kaya yang didukung:** rumus LaTeX ($...$ / $$...$$), blok diagram \`\`\`mermaid, GitHub Alerts (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION]), task list (- [x]), <br>, serta <details>/<summary>.\n`;
  const fileGuide = '\n\n## Mengirim file hasil di chat\nSimpan setiap file hasil kerja di folder ./project/ (atau folder kerja). Pada jawaban akhir, selalu berikan tautan Markdown dengan nama file relatif untuk setiap file yang perlu diunduh, misalnya [hasil.zip](hasil.zip) atau [script.py](script.py). Jika menghasilkan beberapa file terkait, sertakan tautan ke file satu per satu (tanpa mengulang media yang sudah ditampilkan langsung dengan ![...]) dan buat ZIP berisi semuanya agar pengguna bisa mengunduh sekaligus lewat tombol unduh di chat. Jangan gunakan tautan bertipe file:// atau path absolut di teks jawaban akhir.\n';
  const uploadGuide = '\n\n## File upload dari pengguna\nFile yang di-upload pengguna otomatis tersimpan di folder ./project/uploads/. Baca file di sana untuk menjawab; salin hasil kerja yang relevan ke ./project/ bila perlu.\n';

  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(agentsMd, `# AGENTS — ${slug}\n\nKamu adalah agent coding di folder proyek "${slug}".\nSemua file yang di-upload user ada di folder ./project/uploads/.\nKerjakan tugas di dalam folder ini. Tulis catatan penting ke AGENTS.md ini.\n\nFormat Tabel & Respon:\n- Jika user meminta perbandingan, jadwal, daftar harga, spesifikasi, atau data terstruktur, selalu sajikan dalam format Markdown Table standar.\n- Berikan respon yang ramah, ringkas, solutif, dan profesional${imageGuide}${mediaGuide}${fileGuide}${uploadGuide}\nDibuat otomatis: ${new Date().toLocaleString('id-ID')}\n`);
  } else {
    let current = fs.readFileSync(agentsMd, 'utf8');
    let updated = false;
    // Perbarui mediaGuide versi lama (yang memakai [video.mp4] tanpa `!`) ke aturan baru
    if (current.includes(mediaGuideHeading) && current.includes('misalnya [video.mp4](video.mp4)')) {
      current = current.replace(
        new RegExp(`\\n*${mediaGuideHeading}[\\s\\S]*?(?=\\n## |\\nDibuat otomatis:|$)`),
        mediaGuide.trimEnd(),
      );
      updated = true;
    }
    const missingGuides = [
      current.includes('## Menampilkan gambar di chat') ? '' : imageGuide,
      current.includes(mediaGuideHeading) ? '' : mediaGuide,
      current.includes('## Mengirim file hasil di chat') ? '' : fileGuide,
      current.includes('## File upload dari pengguna') ? '' : uploadGuide,
    ].join('');
    if (missingGuides) {
      current += missingGuides;
      updated = true;
    }
    if (updated) fs.writeFileSync(agentsMd, current);
  }
  return d;
}
export function readState(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(BASE, slug, 'state.json'), 'utf8')); } catch { return {}; }
}
export function writeState(slug, st) {
  fs.mkdirSync(path.join(BASE, slug), { recursive: true });
  fs.writeFileSync(path.join(BASE, slug, 'state.json'), JSON.stringify(st, null, 2));
}

// Hapus data internal CLI agy (conversations, brain, annotations, presence) milik satu conversation_id.
const AGY_CLI_DIR = path.join(GEMINI_DATA_DIR, 'antigravity-cli');
export function deleteConversationData(conversationId) {
  const id = String(conversationId || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) return 0;
  let removed = 0;
  const rmSafe = (dir, entry) => {
    const base = path.resolve(dir);
    const target = path.resolve(base, entry);
    if (!target.startsWith(base + path.sep)) return;
    try { fs.rmSync(target, { recursive: true, force: true }); removed++; } catch {}
  };
  for (const sub of ['conversations', 'annotations', 'presence']) {
    const dir = path.join(AGY_CLI_DIR, sub);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name === id || name.startsWith(id + '.')) rmSafe(dir, name);
    }
  }
  const brainEntry = path.join(AGY_CLI_DIR, 'brain', id);
  if (fs.existsSync(brainEntry)) rmSafe(path.join(AGY_CLI_DIR, 'brain'), id);
  return removed;
}

// ---------- limit ----------
export function detectLimit(raw) {
  const t = String(raw || '');
  const hit = (re) => re.test(t);
  if (hit(/week/i) && hit(/limit|quota|exceed/i)) return { window: 'week', label: 'Mingguan (1 week)' };
  if (hit(/5\s*hour|\b5h\b|lima jam/i) && hit(/limit|quota|exceed/i)) return { window: '5h', label: '5 jam' };
  if (hit(/rate.?limit|\b429\b|resource.?exhausted|quota|limit.*(reach|exceed)/i)) return { window: 'other', label: 'Rate limit' };
  return null;
}
export function extractResetIn(raw) {
  const m = String(raw || '').match(/Resets? in ([0-9dhm s]+)/i);
  return m ? m[1].trim() : null;
}

const readMinutes = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
// Idle timeout: dianggap macet jika diam tanpa output selama N menit (0 = nonaktif)
export const PROMPT_IDLE_MIN = readMinutes('AGY_PROMPT_IDLE_MIN', 10);
// Max timeout: batas total 1 giliran eksekusi agar tidak mengunci slot antrean selamanya (0 = nonaktif)
export const PROMPT_MAX_MIN = readMinutes('AGY_PROMPT_MAX_MIN', 60);
// Batas waktu user menjawab popup pertanyaan AI (ask_question). Lewat batas → otomatis "Lewati" (0 = tanpa batas).
// Selama menunggu jawaban, idle/max timeout di atas dijeda.
export const QUESTION_TIMEOUT_MIN = readMinutes('AGY_QUESTION_TIMEOUT_MIN', 30);
// Cara menjalankan agy untuk chat:
//   acp   (default) → `agy acp` (JSON-RPC). Mendukung popup ask_question & teks proses berpikir.
//   print (cadangan) → `agy -p --output-format stream-json` (cara lama; ask_question selalu dijawab kosong).
export const AGY_MODE = String(process.env.AGY_MODE || 'acp').trim().toLowerCase() === 'print' ? 'print' : 'acp';
const MAX_RAW_OUT = 256 * 1024; // batasi tail buffer raw_output di RAM untuk tugas berdurasi lama

// ---------- agyPrompt (async, jalan di sandbox) ----------
export function agyPrompt(slug, text, model, conversationId) {
  return new Promise(async (resolve) => {
    const args = ['-p', text, '--output-format', 'json', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    if (conversationId) args.push('--conversation', conversationId);
    let proc;
    try {
      proc = await spawnInSandbox(slug, [AGY_BIN_IN_SANDBOX, ...args], {
        timeoutMs: PROMPT_MAX_MIN > 0 ? PROMPT_MAX_MIN * 60 * 1000 : 0,
        onTimeout: () => killAgy(slug),
      });
    } catch (e) {
      resolve({ status: 'ERROR', response: String(e.message || e), error: String(e) });
      return;
    }
    let out = '';
    const appendOut = (s) => { out += s; if (out.length > MAX_RAW_OUT) out = out.slice(-MAX_RAW_OUT); };
    proc.stdout.on('data', (d) => appendOut(d.toString()));
    proc.stderr.on('data', (d) => appendOut(d.toString()));
    proc.on('error', (e) => resolve({ status: 'ERROR', response: String(e.message || e), error: String(e) }));
    proc.on('close', () => {
      const lim = detectLimit(out);
      const m = out.match(/\{[\s\S]*\}/);
      if (m) { try { const j = JSON.parse(m[0]); j.limitDetected = lim; j.raw_output = out; resolve(j); return; } catch {} }
      resolve({ status: 'ERROR', response: out.trim() || '(tidak ada output)', error: 'parse', limitDetected: lim, raw_output: out });
    });
  });
}

// ---------- agyPromptStream: sama dengan agyPrompt tapi --output-format stream-json ----------
// onEvent(ev) menerima event netral (lihat acpClient.js): tool / delta / think (durasi mikir tanpa teks).
export function agyPromptStream(slug, text, model, conversationId, onEvent, signal) {
  return new Promise(async (resolve) => {
    if (signal?.aborted) { resolve({ status: 'CANCELLED', response: '', cancelled: true }); return; }
    const args = ['-p', text, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    if (conversationId) args.push('--conversation', conversationId);
    let proc;
    let timedOut = null; // 'idle' | 'max' | null
    try {
      proc = await spawnInSandbox(slug, [AGY_BIN_IN_SANDBOX, ...args], {
        timeoutMs: PROMPT_MAX_MIN > 0 ? PROMPT_MAX_MIN * 60 * 1000 : 0,
        idleTimeoutMs: PROMPT_IDLE_MIN > 0 ? PROMPT_IDLE_MIN * 60 * 1000 : 0,
        onTimeout: (reason) => { timedOut = reason || 'max'; killAgy(slug); },
      });
    } catch (e) {
      resolve({ status: 'ERROR', response: String(e.message || e), error: String(e) });
      return;
    }
    let out = '', buf = '', result = null, convId = null, usage = null, settled = false, answerStep = null;
    const appendOut = (s) => { out += s; if (out.length > MAX_RAW_OUT) out = out.slice(-MAX_RAW_OUT); };
    const stop = () => { try { proc.kill('SIGKILL'); } catch {} killAgy(slug); };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    const emit = (ev) => { try { onEvent && onEvent(ev); } catch {} };
    const handleLine = (line) => {
      line = line.trim(); if (!line) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      const prevConv = convId;
      if (ev.conversation_id) convId = ev.conversation_id;
      const su = ev.step_update;
      if (su?.conversation_id) convId = su.conversation_id;
      if (convId && convId !== prevConv) emit({ kind: 'session', id: convId });
      if (su?.usage) usage = su.usage;
      if (ev.event === 'result') result = ev.result;
      if (!su) return;
      const idx = su.step_index;
      if (su.step_type === 'tool') {
        emit({
          kind: 'tool', id: idx, name: su.tool_name || '', params: su.tool_info?.parameters || {},
          status: su.state === 'DONE' ? 'done' : 'running', duration: su.duration_seconds ?? null,
          output: su.tool_info?.output ? String(su.tool_info.output).slice(0, 1500) : null,
        });
      } else if (su.step_type === 'agent_response') {
        if (su.text_delta) { answerStep = idx; emit({ kind: 'delta', text: su.text_delta }); }
        else if (su.state === 'DONE' && idx !== answerStep) {
          // langkah "mikir" sebelum memakai tool (mode print tidak membuka teks thinking-nya, hanya durasi & token)
          emit({ kind: 'think', id: idx, duration: su.duration_seconds ?? null, thinkingTokens: su.usage?.thinking_tokens ?? null });
        }
      }
    };
    proc.stdout.on('data', (d) => {
      const s = d.toString(); appendOut(s); buf += s;
      let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    proc.stderr.on('data', (d) => appendOut(d.toString()));
    proc.on('error', (e) => { if (!settled) { settled = true; resolve({ status: 'ERROR', response: String(e.message || e), error: String(e) }); } });
    proc.on('close', () => {
      if (settled) return;
      settled = true;
      if (buf) handleLine(buf);
      const lim = detectLimit(out);
      if (result) { resolve({ ...result, conversation_id: result.conversation_id || convId, usage: result.usage || usage, limitDetected: lim, raw_output: out }); return; }
      if (timedOut) {
        const msg = timedOut === 'idle'
          ? `Tidak ada aktivitas dari AI selama ${PROMPT_IDLE_MIN} menit (kemungkinan proses macet). Kirim "lanjutkan" jika tugas belum selesai.`
          : `Batas waktu maksimal eksekusi (${PROMPT_MAX_MIN} menit) tercapai. Kirim "lanjutkan" untuk meneruskan pekerjaan.`;
        resolve({ status: 'ERROR', timedOut, response: msg, conversation_id: convId, error: `timeout:${timedOut}`, limitDetected: lim, raw_output: out });
        return;
      }
      resolve({ status: 'ERROR', response: out.replace(/\{"event"[^\n]*\n?/g, '').trim() || '(tidak ada output)', conversation_id: convId, error: 'parse', limitDetected: lim, raw_output: out });
    });
  });
}

// ---------- agyPromptAcp: 1 giliran lewat `agy acp` (JSON-RPC stdio) di sandbox ----------
// Hasil sama bentuknya dengan agyPromptStream. Tambahan: onQuestion(question) → Promise<{action, content}>
// dipanggil saat AI memakai ask_question; selama menunggu, idle/max timeout dijeda.
export function agyPromptAcp(slug, text, model, conversationId, onEvent, signal, { onQuestion } = {}) {
  return new Promise(async (resolve) => {
    if (signal?.aborted) { resolve({ status: 'CANCELLED', response: '', cancelled: true }); return; }
    let proc;
    let timedOut = null; // 'idle' | 'max' | null
    try {
      proc = await spawnInSandbox(slug, [AGY_BIN_IN_SANDBOX, 'acp', '--dangerously-skip-permissions'], {
        timeoutMs: PROMPT_MAX_MIN > 0 ? PROMPT_MAX_MIN * 60 * 1000 : 0,
        idleTimeoutMs: PROMPT_IDLE_MIN > 0 ? PROMPT_IDLE_MIN * 60 * 1000 : 0,
        onTimeout: (reason) => { timedOut = reason || 'max'; killAgy(slug); },
      });
    } catch (e) {
      resolve({ status: 'ERROR', response: String(e.message || e), error: String(e) });
      return;
    }
    let out = '';
    const appendOut = (s) => { out += s; if (out.length > MAX_RAW_OUT) out = out.slice(-MAX_RAW_OUT); };
    proc.stderr.on('data', (d) => appendOut(d.toString()));
    let closed = false;
    const closedP = new Promise((r) => proc.on('close', () => { closed = true; r(); }));
    const stop = () => { try { proc.kill('SIGKILL'); } catch {} killAgy(slug); };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }

    const r = await runAcpTurn(proc, {
      cwd: SANDBOX_HOME, text, model, conversationId, onEvent, signal,
      brainDir: path.join(AGY_CLI_DIR, 'brain'),
      onActivity: () => proc.bumpIdle?.(),
      onQuestion: onQuestion && (async (q) => {
        proc.pauseTimers?.();
        try { return await onQuestion(q); } finally { proc.resumeTimers?.(); }
      }),
      log: (s) => console.warn(`[agy acp ${slug}] ${s}`),
    });
    signal?.removeEventListener('abort', stop);

    // Tutup sesi: stdin EOF → `agy acp` keluar sendiri (±0,5 dtk). Tunggu sampai benar-benar keluar
    // sebelum resolve, supaya job berikutnya di chat ini tidak bentrok dengan proses lama.
    if (!closed) {
      try { proc.stdin.end(); } catch {}
      const t = setTimeout(stop, 5000);
      await closedP;
      clearTimeout(t);
    }

    const raw = `${out}${r.error ? `\n${r.error}` : ''}`;
    // stderr agy acp berisi log biasa → deteksi limit hanya kalau gilirannya gagal (hindari salah deteksi)
    const lim = r.status === 'SUCCESS' ? null : detectLimit(raw);
    if (signal?.aborted || r.status === 'CANCELLED') {
      resolve({ status: 'CANCELLED', response: '', cancelled: true, conversation_id: r.conversation_id });
      return;
    }
    if (timedOut && r.status !== 'SUCCESS') {
      const msg = timedOut === 'idle'
        ? `Tidak ada aktivitas dari AI selama ${PROMPT_IDLE_MIN} menit (kemungkinan proses macet). Kirim "lanjutkan" jika tugas belum selesai.`
        : `Batas waktu maksimal eksekusi (${PROMPT_MAX_MIN} menit) tercapai. Kirim "lanjutkan" untuk meneruskan pekerjaan.`;
      resolve({ status: 'ERROR', timedOut, response: msg, conversation_id: r.conversation_id, error: `timeout:${timedOut}`, limitDetected: lim, raw_output: raw });
      return;
    }
    if (r.status === 'ERROR' && !r.response) r.response = out.trim().slice(-2000) || '(tidak ada output)';
    resolve({ ...r, limitDetected: lim, raw_output: raw });
  });
}

// Pilih mode sesuai AGY_MODE (acp default, print cadangan)
export function agyPromptLive(slug, text, model, conversationId, onEvent, signal, opts = {}) {
  return AGY_MODE === 'print'
    ? agyPromptStream(slug, text, model, conversationId, onEvent, signal)
    : agyPromptAcp(slug, text, model, conversationId, onEvent, signal, opts);
}

// ---------- antrean global FIFO (MAX_PARALLEL default 2) ----------
// Satu antrean untuk semua chat supaya adil (siapa duluan, dia duluan).
// Job yang dibatalkan saat masih menunggu langsung dikeluarkan dari antrean (tidak pernah dijalankan).
export const MAX_PARALLEL = Math.max(1, parseInt(process.env.AGY_MAX_PARALLEL || '2', 10) || 2);
let running = 0;
const queue = []; // { slug, fn, resolve, signal }
const cancelledResult = () => ({ status: 'CANCELLED', response: '', cancelled: true });
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    if (job.signal?.aborted) { job.resolve(cancelledResult()); continue; }
    running++;
    Promise.resolve().then(job.fn)
      .then((r) => job.resolve(r))
      .catch((e) => job.resolve({ status: 'ERROR', response: String(e.message || e) }))
      .finally(() => { running--; pump(); });
  }
}
export function runQueued(slug, fn, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(cancelledResult()); return; }
    const job = { slug, fn, resolve, signal };
    signal?.addEventListener('abort', () => {
      const i = queue.indexOf(job);
      if (i >= 0) { queue.splice(i, 1); resolve(cancelledResult()); }
    }, { once: true });
    queue.push(job);
    pump();
  });
}
export const runningCount = () => running;
export const queuedCount = () => queue.length;
export const queuedSlugs = () => queue.map((j) => j.slug);
export const isQueueFull = () => running >= MAX_PARALLEL;

// ---------- models & quota (via sandbox, async — tidak memblokir event loop) ----------
async function execAgyDefault(args, timeout) {
  const container = await ensureSandbox('default');
  return new Promise((resolve) => {
    execFile('docker', ['exec', '-i', '-w', '/home/AntiGPT', container, AGY_BIN_IN_SANDBOX, ...args],
      { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, stdout: stdout || '' }));
  });
}
export async function listModels() {
  let r;
  try { r = await execAgyDefault(['models'], 60000); }
  catch (e) { console.error('[agy] listModels: sandbox gagal disiapkan:', e.message); return []; }
  return r.stdout.split('\n').filter((l) => l.includes('\t')).map((l) => {
    const [id, ...rest] = l.split('\t');
    return { id: id.trim(), name: rest.join(' ').trim() || id.trim() };
  });
}
export async function getQuota() {
  let r;
  try { r = await execAgyDefault(['-p', '/usage', '--output-format', 'json'], 90000); }
  catch (e) { console.error('[agy] getQuota: sandbox gagal disiapkan:', e.message); return null; }
  if (r.ok && r.stdout) {
    try { const g = JSON.parse(r.stdout)?.command?.data?.groups; if (Array.isArray(g)) return g; } catch {}
  }
  return null;
}

// ---------- login state machine (persis /login bot.js, tapi agy jalan di sandbox) ----------
let loginState = null; // { proc, poll, timeout, url, status, email, hadOld }
export const getLoginState = () => loginState && { status: loginState.status, url: loginState.url, email: loginState.email };
let lastLoginResult = null;
export const getLastLoginResult = () => lastLoginResult;

function loginCleanup(restoreOld) {
  if (!loginState) return;
  try { clearInterval(loginState.poll); } catch {}
  try { clearTimeout(loginState.timeout); } catch {}
  try { loginState.proc.kill('SIGKILL'); } catch {}
  try { killAgy('default'); } catch {}
  if (restoreOld && loginState.hadOld && fs.existsSync(TOKEN_BAK)) fs.copyFileSync(TOKEN_BAK, TOKEN_FILE);
  loginState = null;
}

export async function startLogin() {
  if (loginState) return { ok: false, error: 'Masih ada proses login berjalan.', ...getLoginState() };
  const hadOld = fs.existsSync(TOKEN_FILE);
  try { fs.mkdirSync(path.dirname(TOKEN_BAK), { recursive: true }); } catch {}
  if (hadOld) {
    try { fs.copyFileSync(TOKEN_FILE, TOKEN_BAK); fs.unlinkSync(TOKEN_FILE); } catch {}
  }
  let proc;
  try {
    await ensureSandbox('default');
    // login interaktif butuh pty: bungkus agy dengan `script` di dalam container
    proc = spawn('docker', ['exec', '-i',
      '-e', 'TERM=xterm',
      getSafeContainerName('default'),
      'script', '-qfc', `stty cols 2000 rows 50 2>/dev/null; ${AGY_BIN_IN_SANDBOX}`, '/dev/null'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    if (hadOld) { try { fs.copyFileSync(TOKEN_BAK, TOKEN_FILE); } catch {} }
    return { ok: false, error: `Gagal menyiapkan sandbox login: ${e.message}` };
  }
  loginState = { proc, poll: null, timeout: null, url: null, status: 'preparing', email: null, hadOld };
  lastLoginResult = null;
  const st = loginState;
  let out = '';
  proc.stdout.on('data', (d) => {
    out += d;
    if (!st.url) { const u = extractLoginUrl(out); if (u) { st.url = u; st.status = 'waiting'; } }
  });
  proc.stderr.on('data', (d) => { out += d; });
  // Enter untuk pilih opsi pertama di welcome screen (sama dgn bot.js)
  setTimeout(() => { try { proc.stdin.write('\r'); } catch {} }, 2500);
  setTimeout(() => { try { if (!st.url) proc.stdin.write('\r'); } catch {} }, 6000);

  st.poll = setInterval(() => {
    if (loginState !== st) return;
    if (fs.existsSync(TOKEN_FILE)) {
      const email = whoamiEmail() || 'akun baru';
      loginCleanup(false);
      try { fs.unlinkSync(TOKEN_BAK); } catch {}
      lastLoginResult = { status: 'success', email };
    } else if (!st.url && Date.now() - st.started > 30000) {
      loginCleanup(true);
      lastLoginResult = { status: 'failed', error: 'Gagal mengambil link login. Coba lagi.', raw: stripAnsi(out).slice(-800) };
    }
  }, 1500);
  st.started = Date.now();
  st.timeout = setTimeout(() => {
    if (loginState !== st) return;
    loginCleanup(true);
    lastLoginResult = { status: 'timeout', error: 'Waktu login habis (5 menit). Akun lama tetap dipakai.' };
  }, 5 * 60 * 1000);
  return { ok: true, status: 'preparing' };
}

// Beberapa versi CLI minta user paste kode otorisasi setelah login
export function submitLoginCode(code) {
  if (!loginState) return { ok: false, error: 'Tidak ada proses login.' };
  try { loginState.proc.stdin.write(String(code).trim() + '\r'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
export function cancelLogin() {
  if (!loginState) return { ok: false, error: 'Tidak ada proses login.' };
  loginCleanup(true);
  lastLoginResult = { status: 'cancelled' };
  return { ok: true };
}
export function logout() {
  if (loginState) return { ok: false, error: 'Selesaikan/batalkan proses login dulu.' };
  const email = whoamiEmail();
  if (!email) return { ok: false, error: 'Memang belum login.' };
  try { fs.mkdirSync(path.dirname(TOKEN_BAK), { recursive: true }); fs.copyFileSync(TOKEN_FILE, TOKEN_BAK); } catch {}
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  return { ok: true, email };
}
