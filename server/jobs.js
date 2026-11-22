// jobs.js — job chat yang LEPAS dari koneksi HTTP.
// Proses agy tetap jalan walau browser refresh / layar HP mati / sinyal putus.
// Semua event (kecuali ping) disimpan berurutan dengan nomor `seq`, sehingga klien
// bisa menyambung ulang dan me-replay event mulai dari seq tertentu.

const KEEP_FINISHED_MS = 10 * 60 * 1000; // job selesai disimpan 10 menit untuk reconnect
const jobs = new Map(); // slug -> job

export function createJob(slug, meta = {}) {
  const prev = jobs.get(slug);
  if (prev?.cleanupTimer) clearTimeout(prev.cleanupTimer);

  const now = Date.now();
  const job = {
    slug,
    events: [],
    listeners: new Set(),
    done: false,
    deleted: false,
    controller: new AbortController(),
    createdAt: now,
    lastEventAt: now,
    queued: false,
    statusText: 'Menyiapkan…',
    title: meta.title || null,
    model: meta.model || null,
    userText: meta.userText ?? '',
    userAttachments: Array.isArray(meta.userAttachments) ? meta.userAttachments : [],
    cleanupTimer: null,
  };

  job.emit = (ev) => {
    if (job.done || job.deleted) return;
    const e = { ...ev, seq: job.events.length };
    job.events.push(e);
    job.lastEventAt = Date.now();
    if (e.type === 'queued') { job.queued = true; job.statusText = 'Menunggu antrean…'; }
    else if (e.type === 'start') { job.queued = false; job.statusText = 'Berpikir…'; }
    else if (e.type === 'status' && e.text) { job.statusText = e.text; }
    else if (e.type === 'thought') { job.statusText = 'Berpikir…'; }
    else if (e.type === 'step' && e.step) {
      job.statusText = e.step.status === 'running' ? (e.step.label || 'Menjalankan tool…') : 'Berpikir…';
    } else if (e.type === 'question') { job.statusText = 'Menunggu jawaban…'; }
    else if (e.type === 'question_done') { job.statusText = 'Berpikir…'; }
    else if (e.type === 'delta') { job.statusText = 'Menulis jawaban…'; }
    for (const fn of [...job.listeners]) { try { fn(e); } catch {} }
    if (e.type === 'done') {
      job.done = true;
      job.queued = false;
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

export function listActiveJobs() {
  const list = [];
  for (const j of jobs.values()) {
    if (j.done || j.deleted) continue;
    list.push({
      slug: j.slug,
      createdAt: j.createdAt,
      updatedAt: j.lastEventAt,
      queued: !!j.queued,
      hasQuestion: !!j.question,
      statusText: j.statusText || 'Menyiapkan…',
      title: j.title,
      model: j.model,
      userText: j.userText,
      userAttachments: j.userAttachments,
    });
  }
  return list;
}

export function stopJob(slug) {
  const j = jobs.get(slug);
  if (!j || j.done) return false;
  j.controller.abort();
  return true;
}

export function deleteJob(slug) {
  const j = jobs.get(slug);
  if (!j) return;
  j.deleted = true;
  j.listeners.clear();
  if (!j.done) j.controller.abort();
  if (j.cleanupTimer) clearTimeout(j.cleanupTimer);
  jobs.delete(slug);
}
