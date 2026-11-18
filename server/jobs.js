// jobs.js — job chat yang LEPAS dari koneksi HTTP.
// Proses agy tetap jalan walau browser refresh / layar HP mati / sinyal putus.
// Semua event (kecuali ping) disimpan berurutan dengan nomor `seq`, sehingga klien
// bisa menyambung ulang dan me-replay event mulai dari seq tertentu.

const KEEP_FINISHED_MS = 10 * 60 * 1000; // job selesai disimpan 10 menit untuk reconnect
const jobs = new Map(); // slug -> job

export function createJob(slug) {
  const prev = jobs.get(slug);
  if (prev?.cleanupTimer) clearTimeout(prev.cleanupTimer);

  const job = {
    slug,
    events: [],
    listeners: new Set(),
    done: false,
    controller: new AbortController(),
    createdAt: Date.now(),
    cleanupTimer: null,
  };

  job.emit = (ev) => {
    if (job.done) return;
    const e = { ...ev, seq: job.events.length };
    job.events.push(e);
    for (const fn of [...job.listeners]) { try { fn(e); } catch {} }
    if (e.type === 'done') {
      job.done = true;
      job.listeners.clear();
      job.cleanupTimer = setTimeout(() => { if (jobs.get(slug) === job) jobs.delete(slug); }, KEEP_FINISHED_MS);
      job.cleanupTimer.unref?.();
    }
  };

  // Replay event mulai `since`, lalu ikuti event baru. Mengembalikan fungsi unsubscribe.
  job.subscribe = (since, fn) => {
    const start = Math.max(0, Number.isFinite(since) ? since : 0);
    for (const e of job.events.slice(start)) fn(e);
    if (job.done) return () => {};
    job.listeners.add(fn);
    return () => job.listeners.delete(fn);
  };

  jobs.set(slug, job);
  return job;
}

export const getJob = (slug) => jobs.get(slug) || null;
export const isJobRunning = (slug) => { const j = jobs.get(slug); return !!j && !j.done; };

export function stopJob(slug) {
  const j = jobs.get(slug);
  if (!j || j.done) return false;
  j.controller.abort();
  return true;
}

export function deleteJob(slug) {
  const j = jobs.get(slug);
  if (!j) return;
  if (!j.done) j.controller.abort();
  if (j.cleanupTimer) clearTimeout(j.cleanupTimer);
  jobs.delete(slug);
}
