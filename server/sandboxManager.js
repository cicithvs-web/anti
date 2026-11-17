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

/**
 * Memastikan image sandbox tersedia. Kalau belum ada, build dari Dockerfile.sandbox.
 * Fallback terakhir: pull ubuntu:24.04 (guard ensureAntigravity akan memasang agy
 * di dalam container saat pertama dibuat).
 */
export async function ensureSandboxImage() {
  try {
    await execFileP('docker', ['image', 'inspect', SANDBOX_IMAGE], { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    console.log(`[Sandbox Auto-Build] Image '${SANDBOX_IMAGE}' belum ada, membangun dari Dockerfile.sandbox...`);
    const dockerfilePath = path.join(__dirname, 'Dockerfile.sandbox');
    if (fs.existsSync(dockerfilePath)) {
      const ok = await new Promise((resolve) => {
        const child = spawn('docker', ['build', '-f', dockerfilePath, '-t', SANDBOX_IMAGE, __dirname], { stdio: 'inherit' });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
      if (ok) { console.log(`[Sandbox Auto-Build] ✅ Image '${SANDBOX_IMAGE}' siap.`); return true; }
      console.error('[Sandbox Auto-Build] Build gagal, fallback ke ubuntu:24.04...');
    }
    await execFileP('docker', ['pull', 'ubuntu:24.04'], { stdio: 'inherit' });
    await execFileP('docker', ['tag', 'ubuntu:24.04', SANDBOX_IMAGE], { stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`[Sandbox Auto-Build] ✅ Fallback image siap (agy dipasang saat container dibuat).`);
    return true;
  }
}

/**
 * Guard idempoten: pastikan binary agy ada di dalam container (untuk fallback image
 * polos, atau kalau user menghapus instalasi dari dalam sandbox).
 */
async function ensureAntigravity(containerName) {
  const check = `${AGY_BIN_IN_SANDBOX} --version`;
  const install = `curl -fsSL https://antigravity.google/cli/install.sh | bash`;
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
export async function ensureSandbox(slug) {
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
    await ensureSandboxImage();
    await execFileP('docker', ['run', '-d',
      '--init',
      '--name', containerName,
      '--restart', 'unless-stopped',
      '--memory', MEMORY,
      '--cpus', CPUS,
      '--pids-limit', PIDS,
      '-v', `${hostWorkspace}:${SANDBOX_HOME}`,
      '-v', `${GEMINI_DATA_DIR}:/root/.gemini`,
      '-w', SANDBOX_HOME,
      SANDBOX_IMAGE, 'tail', '-f', '/dev/null',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    await ensureAntigravity(containerName);
    return containerName;
  }
}

/**
 * Spawn proses di dalam sandbox: docker exec -i -w /home/AntiGPT <container> <argv...>
 * argv dipakai langsung (tanpa bash -c) supaya output agy (json/stream-json) mengalir bersih.
 * opts: { timeoutMs, onTimeout } — onTimeout(slug) dipanggil sekali saat timeout.
 */
export async function spawnInSandbox(slug, argv, { timeoutMs, onTimeout } = {}) {
  const containerName = await ensureSandbox(slug);
  const child = spawn('docker', ['exec', '-i', '-w', SANDBOX_HOME, containerName, ...argv], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (timeoutMs) {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      try { onTimeout && onTimeout(slug); } catch {}
    }, timeoutMs);
    child.on('close', () => clearTimeout(timer));
    child.on('error', () => clearTimeout(timer));
  }
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
  try { await execFileP('docker', ['rm', '-f', getSafeContainerName(slug)], { stdio: ['pipe', 'pipe', 'pipe'] }); return true; }
  catch { return false; }
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
