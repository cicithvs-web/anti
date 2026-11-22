// sandboxManager.js — Pengelola persistent Docker sandbox untuk AntiGPT.
// Diadaptasi dari pola nroz (sandboxManager.js): 1 container per chat,
// workspace ter-mount, limit resource, auto-build image, eksekusi via docker exec.
//
// - Container : antigpt-sandbox-<slug>  (persisten, --restart unless-stopped)
// - Workspace : server/sessions/<slug>  → /home/AntiGPT (cwd agy)
// - State agy : server/sandbox-data/gemini → /root/.gemini (token + conversations persisten)

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SANDBOX_IMAGE = process.env.AGY_SANDBOX_IMAGE || 'antigpt-sandbox:latest';
export const SANDBOX_HOME = process.env.AGY_SANDBOX_HOME || '/home/AntiGPT';
export const AGY_BIN_IN_SANDBOX = process.env.AGY_SANDBOX_BIN || '/root/.local/bin/agy';
const MEMORY = process.env.AGY_SANDBOX_MEMORY || '2048m';
const CPUS = process.env.AGY_SANDBOX_CPUS || '2.0';
const PIDS = process.env.AGY_SANDBOX_PIDS || '512';

export const SESSIONS_BASE = path.join(__dirname, 'sessions');
export const SANDBOX_DATA_BASE = path.join(__dirname, 'sandbox-data');
// Seluruh ~/.gemini agy (token OAuth, conversations, history) di-share antar container
// — perilaku sama dengan saat agy jalan langsung di host: 1 akun, history persisten.
export const GEMINI_DATA_DIR = path.join(SANDBOX_DATA_BASE, 'gemini');

const execFileP = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });

export const slugSafe = (s) => String(s || 'default').trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
export const getSafeContainerName = (slug) => `antigpt-sandbox-${slugSafe(slug)}`;
export const getSessionWorkspace = (slug) => {
  const dir = path.join(SESSIONS_BASE, slugSafe(slug));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Fallback memakai tag TERPISAH supaya tag utama (SANDBOX_IMAGE) tidak pernah berisi ubuntu polos.
// Dengan begitu, build image asli akan dicoba lagi pada pemanggilan berikutnya.
const FALLBACK_IMAGE = `${SANDBOX_IMAGE.replace(/:[^/:]*$/, '')}:fallback`;

let imagePromise = null; // dedupe: banyak request bersamaan → hanya 1 build

/**
 * Memastikan image sandbox tersedia dan mengembalikan NAMA image yang harus dipakai.
 * Urutan: image utama sudah ada → pakai; belum → build dari server/Dockerfile.sandbox;
 * build gagal → fallback ubuntu:24.04 (tag :fallback, agy dipasang saat container dibuat).
 */
export function ensureSandboxImage() {
  if (!imagePromise) {
    imagePromise = buildImageIfNeeded().finally(() => { imagePromise = null; });
  }
  return imagePromise;
}

async function buildImageIfNeeded() {
  const quiet = { stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    await execFileP('docker', ['image', 'inspect', SANDBOX_IMAGE], quiet);
    return SANDBOX_IMAGE;
  } catch {
    console.log(`[Sandbox Auto-Build] Image '${SANDBOX_IMAGE}' belum ada, membangun dari Dockerfile.sandbox...`);
    const dockerfilePath = path.join(__dirname, 'Dockerfile.sandbox');
    if (fs.existsSync(dockerfilePath)) {
      const ok = await new Promise((resolve) => {
        const child = spawn('docker', ['build', '-f', dockerfilePath, '-t', SANDBOX_IMAGE, __dirname], { stdio: 'inherit' });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
      if (ok) { console.log(`[Sandbox Auto-Build] ✅ Image '${SANDBOX_IMAGE}' siap.`); return SANDBOX_IMAGE; }
      console.error(`[Sandbox Auto-Build] Build gagal, fallback ke ubuntu:24.04 (tag '${FALLBACK_IMAGE}')...`);
    } else {
      console.error(`[Sandbox Auto-Build] ${dockerfilePath} tidak ditemukan, fallback ke ubuntu:24.04...`);
    }
    try {
      await execFileP('docker', ['image', 'inspect', FALLBACK_IMAGE], quiet);
    } catch {
      await execFileP('docker', ['pull', 'ubuntu:24.04'], { stdio: 'inherit' });
      await execFileP('docker', ['tag', 'ubuntu:24.04', FALLBACK_IMAGE], quiet);
    }
    console.log(`[Sandbox Auto-Build] ⚠️ Memakai fallback '${FALLBACK_IMAGE}' (tanpa Python/Node/git; agy dipasang saat container dibuat).`);
    return FALLBACK_IMAGE;
  }
}

/**
 * Guard idempoten: pastikan binary agy ada di dalam container (untuk fallback image
 * polos, atau kalau user menghapus instalasi dari dalam sandbox).
 */
async function ensureAntigravity(containerName) {
  const check = `${AGY_BIN_IN_SANDBOX} --version`;
  const ensureCurl = `command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl ca-certificates)`;
  const install = `${ensureCurl} && curl -fsSL https://antigravity.google/cli/install.sh | bash`;
  const script = `if ! command -v agy >/dev/null 2>&1 && [ ! -x ${AGY_BIN_IN_SANDBOX} ]; then echo "[sandbox] menginstall antigravity..."; ${install}; fi; ${check}`;
  try {
    await execFileP('docker', ['exec', containerName, 'bash', '-c', script], { timeout: 5 * 60 * 1000 });
  } catch (err) {
    throw new Error(`Gagal memastikan antigravity di sandbox: ${err.message} ${err.stderr || ''}`);
  }
}

/**
 * Memastikan container sandbox untuk 1 chat aktif. Urutannya:
   sudah jalan → langsung pakai; berhenti → start; belum ada → buat baru.
 */
const sandboxPending = new Map(); // slug → Promise (hindari `docker run --name` ganda)
const lastUsed = new Map(); // slug aman → timestamp terakhir dipakai (untuk reaper idle)
export const touchSandbox = (slug) => lastUsed.set(slugSafe(slug), Date.now());

export function ensureSandbox(slug) {
  const safe = slugSafe(slug);
  touchSandbox(safe);
  if (!sandboxPending.has(safe)) {
    sandboxPending.set(safe, ensureSandboxOnce(safe).finally(() => sandboxPending.delete(safe)));
  }
  return sandboxPending.get(safe);
}

async function ensureSandboxOnce(slug) {
  const safe = slugSafe(slug);
  const containerName = getSafeContainerName(safe);
  const hostWorkspace = getSessionWorkspace(safe);
  fs.mkdirSync(GEMINI_DATA_DIR, { recursive: true });

  try {
    const { stdout } = await execFileP('docker', ['inspect', '-f', '{{.State.Running}}', containerName], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (stdout.trim() === 'true') return containerName;
    await execFileP('docker', ['start', containerName], { stdio: ['pipe', 'pipe', 'pipe'] });
    return containerName;
  } catch {
    const image = await ensureSandboxImage();
    await execFileP('docker', ['run', '-d',
      '--init',
      '--name', containerName,
      // tidak auto-restart: container di-start on-demand oleh ensureSandbox & di-stop reaper saat idle
      '--restart', 'no',
      '--memory', MEMORY,
      '--cpus', CPUS,
      '--pids-limit', PIDS,
      '-v', `${hostWorkspace}:${SANDBOX_HOME}`,
      '-v', `${GEMINI_DATA_DIR}:/root/.gemini`,
      '-w', SANDBOX_HOME,
      image, 'tail', '-f', '/dev/null',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    await ensureAntigravity(containerName);
    return containerName;
  }
}

/**
 * Spawn proses di dalam sandbox: docker exec -i -w /home/AntiGPT <container> <argv...>
 * argv dipakai langsung (tanpa bash -c) supaya output agy (json/stream-json) mengalir bersih.
 * opts:
 *   - timeoutMs     : batas total waktu jalan (ms)
 *   - idleTimeoutMs : batas diam tanpa output stdout/stderr (ms) — di-reset tiap ada chunk data
 *   - onTimeout(reason, slug) : dipanggil sekali saat salah satu timeout tercapai ('idle' | 'max')
 * child yang dikembalikan punya pauseTimers() / resumeTimers() untuk menjeda timeout sementara.
 */
export async function spawnInSandbox(slug, argv, { timeoutMs, idleTimeoutMs, onTimeout } = {}) {
  const containerName = await ensureSandbox(slug);
  const child = spawn('docker', ['exec', '-i', '-w', SANDBOX_HOME, containerName, ...argv], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  touchSandbox(slug);

  let finished = false;
  let paused = false;
  let maxTimer = null;
  let idleTimer = null;
  let maxRemaining = timeoutMs || 0;
  let maxStartedAt = Date.now();
  const clearTimers = () => {
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
  const triggerTimeout = (reason) => {
    if (finished) return;
    finished = true;
    clearTimers();
    try { child.kill('SIGKILL'); } catch {}
    try { onTimeout && onTimeout(reason, slug); } catch {}
  };
  const armIdle = () => {
    if (!idleTimeoutMs || finished || paused) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => triggerTimeout('idle'), idleTimeoutMs);
  };

  if (timeoutMs) maxTimer = setTimeout(() => triggerTimeout('max'), timeoutMs);
  // Jeda semua timeout selama menunggu input user (mis. popup ask_question), lalu lanjutkan sisa waktunya.
  child.pauseTimers = () => {
    if (finished || paused) return;
    paused = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; maxRemaining -= Date.now() - maxStartedAt; }
  };
  child.resumeTimers = () => {
    if (finished || !paused) return;
    paused = false;
    touchSandbox(slug);
    if (timeoutMs) {
      maxStartedAt = Date.now();
      maxTimer = setTimeout(() => triggerTimeout('max'), Math.max(5000, maxRemaining));
    }
    armIdle();
  };
  child.bumpIdle = () => {
    if (finished || paused) return;
    touchSandbox(slug);
    armIdle();
  };
  if (idleTimeoutMs) {
    armIdle();
    const bump = () => { touchSandbox(slug); armIdle(); };
    child.stdout.on('data', bump);
    child.stderr.on('data', bump);
  }
  child.on('close', () => { finished = true; clearTimers(); touchSandbox(slug); });
  child.on('error', () => { finished = true; clearTimers(); });
  return child;
}

/** Jalankan perintah shell di sandbox (bash -c), kembalikan stdout. Untuk util singkat. */
export async function execInSandbox(slug, command, { timeoutMs = 30_000 } = {}) {
  const containerName = await ensureSandbox(slug);
  const { stdout } = await execFileP('docker', ['exec', '-i', '-w', SANDBOX_HOME, containerName, 'bash', '-c', command], { timeout: timeoutMs });
  return stdout;
}

/**
 * Hentikan semua proses agy di container chat ini (dipakai saat timeout/abort).
 * Aman karena container terpisah per chat — tidak akan mengenai chat lain.
 */
export function killAgy(slug) {
  const containerName = getSafeContainerName(slug);
  const child = spawn('docker', ['exec', containerName, 'bash', '-c',
    'pkill -x agy 2>/dev/null; pkill -f "antigravity" 2>/dev/null; true'], { stdio: ['ignore', 'ignore', 'ignore'] });
  child.on('error', (err) => console.warn(`[Sandbox] killAgy ${slug}:`, err.message));
  child.unref();
}

export async function resetSandbox(slug) {
  const safe = slugSafe(slug);
  lastUsed.delete(safe);
  if (sandboxPending.has(safe)) {
    try { await sandboxPending.get(safe); } catch {}
  }
  try { await execFileP('docker', ['rm', '-f', getSafeContainerName(safe)], { stdio: ['pipe', 'pipe', 'pipe'] }); return true; }
  catch { return false; }
}

/**
 * Reaper: stop container sandbox yang idle (tidak dipakai > idleMs).
 * Container yang di-stop akan di-start lagi otomatis oleh ensureSandbox saat dibutuhkan.
 * isBusy(slug) → true kalau slug sedang dipakai (job berjalan / login), jangan di-stop.
 */
const CONTAINER_PREFIX = 'antigpt-sandbox-';
export function startIdleReaper({ idleMs, intervalMs = 5 * 60 * 1000, isBusy } = {}) {
  const migrated = new Set();
  const tick = async () => {
    let stdout = '';
    try {
      ({ stdout } = await execFileP('docker', ['ps', '--filter', `name=^${CONTAINER_PREFIX}`, '--format', '{{.Names}}'],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 }));
    } catch { return; }
    const now = Date.now();
    for (const name of stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(CONTAINER_PREFIX))) {
      const slug = name.slice(CONTAINER_PREFIX.length);
      if (!migrated.has(name)) {
        // container lama dibuat dengan --restart unless-stopped → matikan auto-restart-nya
        migrated.add(name);
        execFileP('docker', ['update', '--restart', 'no', name], { stdio: ['pipe', 'pipe', 'pipe'] }).catch(() => {});
      }
      if (!lastUsed.has(slug)) { lastUsed.set(slug, now); continue; } // belum tercatat (mis. server baru restart): beri masa tenggang
      if (isBusy?.(slug)) { lastUsed.set(slug, now); continue; }
      if (now - lastUsed.get(slug) < idleMs) continue;
      if (sandboxPending.has(slug)) continue;
      lastUsed.delete(slug);
      console.log(`[Sandbox Reaper] stop ${name} (idle > ${Math.round(idleMs / 60000)} mnt)`);
      execFileP('docker', ['stop', '-t', '3', name], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 }).catch(() => {});
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 15_000).unref?.();
  return timer;
}

export async function getSandboxInfo(slug) {
  const containerName = getSafeContainerName(slug);
  try {
    const { stdout } = await execFileP('docker', ['inspect', '-f',
      'Status: {{.State.Status}} | Started: {{.State.StartedAt}} | CPU: {{.HostConfig.NanoCpus}} | Mem: {{.HostConfig.Memory}}', containerName], { stdio: ['pipe', 'pipe', 'pipe'] });
    return { exists: true, info: stdout.trim(), containerName };
  } catch {
    return { exists: false, containerName };
  }
}

/** Daftar cepat semua container sandbox AntiGPT (slug -> { state, status }). */
export async function listSandboxes() {
  const map = new Map();
  try {
    const { stdout } = await execFileP('docker', [
      'ps', '-a',
      '--filter', `name=^${CONTAINER_PREFIX}`,
      '--format', '{{.Names}}\t{{.State}}\t{{.Status}}',
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 });
    for (const line of stdout.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const [name, state, ...rest] = s.split('\t');
      if (!name || !name.startsWith(CONTAINER_PREFIX)) continue;
      map.set(name.slice(CONTAINER_PREFIX.length), {
        state: (state || '').trim(),
        status: rest.join('\t').trim(),
      });
    }
  } catch {}
  return map;
}

/** Tidurkan (docker stop) 1 container sandbox tanpa menghapus chat/workspace. */
export async function stopSandbox(slug) {
  const safe = slugSafe(slug);
  lastUsed.delete(safe);
  try {
    await execFileP('docker', ['stop', '-t', '3', getSafeContainerName(safe)], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
