// acpClient.js — klien minimal Agent Client Protocol (ACP) untuk `agy acp` (JSON-RPC lewat stdio).
// Dipakai menggantikan `agy -p` supaya tool interaktif (ask_question) bisa dijawab user:
// agy mengirim request `elicitation/create` → kita teruskan ke UI → jawaban dikirim balik.
//
// Catatan penting soal proses latar belakang & subagent di ACP:
// Berbeda dengan `agy -p` (yang otomatis menunggu WaitForConversationFullyIdle), di ACP
// `session/prompt` langsung mengembalikan `stopReason: "end_turn"` begitu giliran awal selesai
// meskipun subagent (mis. `image-generator`) atau background task (`run_command`, `run_workflow`)
// masih berjalan. Jika kita langsung menutup `agy acp` saat itu, subagent langsung mati.
// Karena itu, jika giliran ini meluncurkan proses latar belakang / subagent, kita tetap
// menjaga koneksi ACP hidup sampai semua proses latar belakang + reactive wakeup selesai.
//
// Event yang dikirim ke onEvent (format netral, sama untuk mode ACP maupun print):
//   { kind: 'session', id }                                   → id percakapan (= conversation_id)
//   { kind: 'delta', text }                                   → potongan teks jawaban
//   { kind: 'thought', id, text }                             → potongan teks proses berpikir
//   { kind: 'status', text }                                  → pembaruan status singkat
//   { kind: 'tool', id, name, title, params, status, duration, output }  status: running|done|error

import fs from 'node:fs';
import path from 'node:path';

const PROTOCOL_VERSION = 1;
const MAX_TOOL_OUTPUT = 1500;
const ASYNC_TOOLS = new Set(['invoke_subagent', 'run_workflow', 'schedule', 'swarm', 'browser_subagent']);
const BG_POLL_MS = 500;
const BG_STABILIZE_MS = 2500;
const SUBAGENT_START_GRACE_MS = 20_000;
const SUBAGENT_SILENT_GRACE_MS = 4000;

// ---------- util ----------
function mapUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    thinking_tokens: u.thoughtTokens ?? 0,
    cache_read_tokens: u.cachedReadTokens ?? 0,
    total_tokens: u.totalTokens ?? 0,
  };
}

function toolOutput(t) {
  const parts = (Array.isArray(t.content) ? t.content : []).map((c) => {
    if (c?.type === 'content') return c.content?.type === 'text' ? c.content.text : '';
    if (c?.type === 'diff') return [c.path, c.newText].filter((x) => x != null).join('\n');
    return '';
  }).filter(Boolean);
  let out = parts.join('\n');
  if (!out && t.rawOutput) {
    out = typeof t.rawOutput === 'string' ? t.rawOutput : (t.rawOutput.output || t.rawOutput.error || '');
  }
  return out ? String(out).slice(0, MAX_TOOL_OUTPUT) : null;
}

const isDaemonTool = (t) => !!(t?.rawInput?.IsDaemon || t?.args?.IsDaemon);

// ---------- inspeksi transcript.jsonl untuk mendeteksi subagent & background task aktif ----------
function readTranscript(brainDir, convId) {
  if (!brainDir || !convId) return null;
  const file = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    const stat = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    const steps = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { steps.push(JSON.parse(s)); } catch {}
    }
    return { mtimeMs: stat.mtimeMs, steps };
  } catch {
    return null;
  }
}

const isTerminalStep = (step) => {
  if (!step) return false;
  if (step.type === 'ERROR_MESSAGE') return true;
  return step.type === 'PLANNER_RESPONSE' && step.status === 'DONE' && !(step.tool_calls && step.tool_calls.length > 0);
};

function hasDaemonCallArg(tc) {
  const v = tc?.args?.IsDaemon;
  return v === true || v === 'true';
}

/**
 * Periksa apakah percakapan (mulai baris `baseline`) masih punya background task,
 * subagent aktif (rekursif), atau reactive wakeup yang belum selesai diproses parent.
 * Mengembalikan { busy, maxMtimeMs }.
 */
export function inspectBackgroundState(brainDir, convId, baseline, now, tracker, visited = new Set()) {
  if (!brainDir || !convId || visited.has(convId)) return { busy: false, maxMtimeMs: 0 };
  visited.add(convId);
  const tr = readTranscript(brainDir, convId);
  if (!tr) return { busy: false, maxMtimeMs: 0 };

  let maxMtimeMs = tr.mtimeMs;
  const steps = tr.steps.slice(Math.max(0, baseline));
  if (!steps.length) return { busy: false, maxMtimeMs };

  const daemonTaskHints = new Set(); // index step tool_calls yg IsDaemon=true
  const pendingTasks = new Set();
  const subagents = new Map(); // subId -> { createdAt, killed }
  const receivedFrom = new Map(); // senderId -> { lastIdx, count }
  let sawBackgroundWork = false;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const content = String(st.content || '');
    const tcs = Array.isArray(st.tool_calls) ? st.tool_calls : [];

    for (const tc of tcs) {
      if ((tc.name === 'run_command' || tc.name === 'schedule') && hasDaemonCallArg(tc)) {
        daemonTaskHints.add(st.step_index);
      }
      if (tc.name === 'manage_task') {
        const act = String(tc.args?.Action || '').replace(/^"|"$/g, '');
        const tid = String(tc.args?.TaskId || '').replace(/^"|"$/g, '');
        if (act === 'kill' && tid) pendingTasks.delete(tid);
      }
      if (tc.name === 'manage_subagents') {
        const act = String(tc.args?.Action || '').replace(/^"|"$/g, '');
        if (act === 'kill_all') {
          for (const v of subagents.values()) v.killed = true;
        } else if (act === 'kill') {
          const rawIds = String(tc.args?.ConversationIds || '');
          for (const [sid, info] of subagents.entries()) {
            if (rawIds.includes(sid)) info.killed = true;
          }
        }
      }
    }

    // Background task diluncurkan (run_command async / run_workflow / schedule)
    const tm = /Tool is running as a background task with task id:\s*([^\s]+)/.exec(content);
    if (tm && st.type === 'GENERIC') {
      const tid = tm[1];
      // Cek apakah step PLANNER_RESPONSE tepat sebelum ini menandai IsDaemon=true
      let isDaemon = false;
      for (let j = i - 1; j >= 0; j--) {
        if (steps[j].type === 'PLANNER_RESPONSE') {
          if (daemonTaskHints.has(steps[j].step_index)) isDaemon = true;
          break;
        }
      }
      if (!isDaemon) {
        pendingTasks.add(tid);
        sawBackgroundWork = true;
      }
    }

    // Subagent dibuat (invoke_subagent)
    if (st.type === 'GENERIC' && content.includes('Created the following subagent:')) {
      const sm = /"conversationId"\s*:\s*"([a-zA-Z0-9_-]+)"/.exec(content);
      if (sm) {
        const sid = sm[1];
        if (!subagents.has(sid)) {
          if (!tracker.subFirstSeen.has(sid)) tracker.subFirstSeen.set(sid, now);
          subagents.set(sid, { killed: false });
          sawBackgroundWork = true;
        }
      }
    }

    // Pesan reactive wakeup dari task / subagent
    if (st.type === 'SYSTEM_MESSAGE') {
      const snd = /sender=([^\s\]]+)/g;
      let m;
      while ((m = snd.exec(content)) !== null) {
        const sender = m[1];
        const prev = receivedFrom.get(sender);
        receivedFrom.set(sender, { lastIdx: i, count: (prev?.count || 0) + 1 });
        pendingTasks.delete(sender);
        sawBackgroundWork = true;
      }
      const fin = /Task id "([^"]+)" (?:finished|failed|cancelled|stopped)/g;
      while ((m = fin.exec(content)) !== null) {
        pendingTasks.delete(m[1]);
        sawBackgroundWork = true;
      }
    }
  }

  // 1. Masih ada background task yang belum selesai?
  if (pendingTasks.size > 0) return { busy: true, maxMtimeMs };

  // 2. Periksa setiap subagent yang diluncurkan pada giliran ini
  let mustProcessStepIdx = -1;
  for (const [sid, info] of subagents.entries()) {
    if (info.killed) continue;
    const subTr = readTranscript(brainDir, sid);
    if (!subTr) {
      // Baru dibuat, file transkripnya mungkin belum sempat ditulis ke disk
      const firstSeen = tracker.subFirstSeen.get(sid) || now;
      if (now - firstSeen < SUBAGENT_START_GRACE_MS) return { busy: true, maxMtimeMs };
      continue;
    }
    if (subTr.mtimeMs > maxMtimeMs) maxMtimeMs = subTr.mtimeMs;
    const subLast = subTr.steps[subTr.steps.length - 1];

    // Rekursif: cek apakah subagent sendiri masih punya child task/subagent
    const nested = inspectBackgroundState(brainDir, sid, 0, now, tracker, visited);
    if (nested.maxMtimeMs > maxMtimeMs) maxMtimeMs = nested.maxMtimeMs;
    if (nested.busy) return { busy: true, maxMtimeMs };

    if (!isTerminalStep(subLast)) return { busy: true, maxMtimeMs };

    // Subagent sudah selesai; cek apakah ia sempat mengirim pesan ke parent
    const sentCount = subTr.steps.filter((s) =>
      s.type === 'GENERIC' && String(s.content || '').includes(`Message sent to "${convId}"`),
    ).length;
    const rec = receivedFrom.get(sid);
    if (sentCount > 0) {
      if (!rec || rec.count < sentCount) {
        // Pesan baru terkirim dari subagent, tunggu parent menerimanya
        if (!tracker.subDoneAt.has(sid)) tracker.subDoneAt.set(sid, now);
        if (now - tracker.subDoneAt.get(sid) < 15_000) return { busy: true, maxMtimeMs };
      } else if (rec.lastIdx > mustProcessStepIdx) {
        mustProcessStepIdx = rec.lastIdx;
      }
    } else if (!rec) {
      // Subagent selesai tanpa send_message: beri jeda singkat kalau sistem mengirim notifikasi otomatis
      if (!tracker.subDoneAt.has(sid)) tracker.subDoneAt.set(sid, now);
      if (now - tracker.subDoneAt.get(sid) < SUBAGENT_SILENT_GRACE_MS) return { busy: true, maxMtimeMs };
    } else if (rec.lastIdx > mustProcessStepIdx) {
      mustProcessStepIdx = rec.lastIdx;
    }
  }

  // 3. Cek apakah parent sudah selesai memproses pesan terakhir (wakeup dari subagent/task).
  // Hanya berlaku bila giliran ini memang pernah meluncurkan background task / subagent;
  // jika tidak (mis. error kuota 429 yang tidak menulis PLANNER_RESPONSE ke transcript.jsonl),
  // jangan menahan koneksi di waitForBackgroundIdle.
  if (!sawBackgroundWork) return { busy: false, maxMtimeMs };
  const lastIdx = steps.length - 1;
  const lastStep = steps[lastIdx];
  if (!isTerminalStep(lastStep)) return { busy: true, maxMtimeMs };
  if (mustProcessStepIdx >= 0 && lastIdx <= mustProcessStepIdx) return { busy: true, maxMtimeMs };

  return { busy: false, maxMtimeMs };
}

/**
 * Ubah params `elicitation/create` (JSON schema form) jadi pertanyaan yang gampang dirender UI.
 * Contoh schema dari agy untuk ask_question:
 *   { q1: { type:'string', title:'Apa warna favoritmu?', oneOf:[{const:'1',title:'(Recommended) Merah'}, ...] },
 *     q1_other: { type:'string', title:'Other', description:'Optional free-form answer to: ...' } }
 */
export function parseElicitation(params) {
  const schema = params?.requestedSchema || {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const toOptions = (list, names) => (Array.isArray(list) ? list : []).map((o, i) => {
    const opt = o && typeof o === 'object'
      ? { value: o.const ?? o.value ?? o.enum?.[0], label: String(o.title ?? o.const ?? o.value ?? '') }
      : { value: o, label: String(names?.[i] ?? o) };
    const m = /^\(recommended\)\s*/i.exec(opt.label);
    return m ? { ...opt, label: opt.label.slice(m[0].length), recommended: true } : opt;
  });
  const fields = [];
  for (const [key, s] of Object.entries(props)) {
    if (!s || typeof s !== 'object') continue;
    if (key.endsWith('_other') && props[key.slice(0, -6)]) continue; // digabung ke field induknya
    let type = 'text';
    let options = [];
    if (s.type === 'array') {
      type = 'multi';
      const it = s.items || {};
      options = toOptions(it.oneOf || it.anyOf || it.enum, it.enumNames);
    } else if (s.oneOf || s.anyOf || s.enum) {
      type = 'single';
      options = toOptions(s.oneOf || s.anyOf || s.enum, s.enumNames);
    } else if (s.type === 'boolean') type = 'boolean';
    else if (s.type === 'number' || s.type === 'integer') type = 'number';
    fields.push({
      key, type, options,
      title: String(s.title || key),
      description: String(s.description || ''),
      otherKey: props[`${key}_other`] ? `${key}_other` : null,
      required: required.includes(key),
    });
  }
  return { message: String(params?.message || ''), toolCallId: params?.toolCallId || null, fields };
}

/**
 * Validasi jawaban dari UI terhadap pertanyaan → content untuk respons elicitation.
 * answers: { q1: '2', q1_other: 'teks bebas', q2: ['1','3'] }
 * Mengembalikan { content, summary } atau { error }.
 */
export function buildElicitationAnswer(question, answers = {}) {
  const content = {};
  const summary = [];
  for (const f of question.fields || []) {
    const raw = answers[f.key];
    const other = f.otherKey ? String(answers[f.otherKey] ?? '').trim().slice(0, 4000) : '';
    const labels = [];
    if (f.type === 'single') {
      const opt = f.options.find((o) => String(o.value) === String(raw));
      if (opt) { content[f.key] = opt.value; labels.push(opt.label); }
    } else if (f.type === 'multi') {
      const vals = (Array.isArray(raw) ? raw : []).map(String);
      const picked = f.options.filter((o) => vals.includes(String(o.value)));
      if (picked.length) { content[f.key] = picked.map((o) => o.value); labels.push(...picked.map((o) => o.label)); }
    } else if (f.type === 'boolean') {
      if (typeof raw === 'boolean') { content[f.key] = raw; labels.push(raw ? 'Ya' : 'Tidak'); }
    } else if (f.type === 'number') {
      const n = Number(raw);
      if (raw !== '' && raw != null && Number.isFinite(n)) { content[f.key] = n; labels.push(String(n)); }
    } else {
      const t = String(raw ?? '').trim().slice(0, 4000);
      if (t) { content[f.key] = t; labels.push(t); }
    }
    if (other) { content[f.otherKey] = other; labels.push(other); }
    if (f.required && !labels.length) return { error: `Pertanyaan "${f.title}" wajib dijawab.` };
    summary.push({ title: f.title, answer: labels.join(', ') });
  }
  return { content, summary };
}

/**
 * Jalankan 1 giliran prompt lewat proses `agy acp` yang sudah di-spawn.
 * opts: { cwd, text, model, conversationId, brainDir, onEvent, onActivity,
 *         onQuestion(question) → Promise<{action, content?}>, signal, log }
 * Resolve: { status: 'SUCCESS'|'ERROR'|'CANCELLED', response, conversation_id, usage, stopReason?, error? }
 */
export function runAcpTurn(proc, opts) {
  const { cwd, text, model, conversationId, brainDir, onQuestion, onActivity, signal } = opts;
  const onEvent = (ev) => { try { opts.onEvent?.(ev); } catch {} };
  const log = opts.log || (() => {});

  return new Promise((resolve) => {
    let nextId = 0, buf = '', settled = false, sessionId = null, prompting = false;
    let response = '', lastKind = null, thoughtId = null, thoughtSeq = 0;
    let sawAsyncTool = false, inQuestion = false, lastUpdateAt = Date.now(), bgTimer = null;
    const pending = new Map();      // id request kita → { res, rej }
    const tools = new Map();        // toolCallId → state gabungan + waktu mulai

    // Cegah uncaught EPIPE jika proses agy sudah mati saat menulis session/cancel atau request
    proc.stdin?.on('error', () => {});
    const write = (m) => {
      if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return;
      try { proc.stdin.write(JSON.stringify(m) + '\n'); } catch {}
    };
    const clearBgTimer = () => { if (bgTimer) { clearInterval(bgTimer); bgTimer = null; } };
    const onSignalAbort = () => {
      if (!settled && sessionId) write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    };
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearBgTimer();
      signal?.removeEventListener('abort', onSignalAbort);
      for (const p of pending.values()) p.rej(new Error('ACP ditutup'));
      pending.clear();
      resolve(r);
    };
    const request = (method, params) => new Promise((res, rej) => {
      if (settled) { rej(new Error('ACP ditutup')); return; }
      const id = ++nextId;
      pending.set(id, { res, rej });
      write({ jsonrpc: '2.0', id, method, params });
    });
    const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
    const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

    const hasRunningTools = () => {
      for (const t of tools.values()) {
        if (isDaemonTool(t)) continue;
        if (t.status !== 'completed' && t.status !== 'failed') return true;
      }
      return false;
    };

    // ---- request dari agent ke kita ----
    async function handleServerRequest(m) {
      if (m.method === 'elicitation/create') {
        if (!onQuestion || m.params?.mode === 'url') { reply(m.id, { action: 'decline' }); return; }
        inQuestion = true;
        lastUpdateAt = Date.now();
        let ans;
        try { ans = await onQuestion(parseElicitation(m.params)); }
        catch (e) { log(`onQuestion error: ${e.message}`); }
        finally { inQuestion = false; lastUpdateAt = Date.now(); }
        reply(m.id, ans && ans.action ? ans : { action: 'decline' });
        return;
      }
      if (m.method === 'session/request_permission') {
        // Mestinya tidak muncul karena --dangerously-skip-permissions; kalau muncul, izinkan (perilaku sama).
        const optsList = m.params?.options || [];
        const opt = optsList.find((o) => /^allow/.test(o.kind || '')) || optsList[0];
        reply(m.id, opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
        return;
      }
      replyError(m.id, -32601, `Method tidak didukung: ${m.method}`);
    }

    // ---- notifikasi session/update ----
    function handleUpdate(u) {
      if (!u || !prompting) return; // abaikan replay riwayat sebelum prompt dikirim
      lastUpdateAt = Date.now();
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          const t = u.content?.type === 'text' ? u.content.text : '';
          if (!t) return;
          // teks setelah tool/pikiran = paragraf baru (hindari double newline jika agy sudah menyertakannya)
          const needsSep = lastKind && lastKind !== 'text' && response && !response.endsWith('\n\n') && !t.startsWith('\n');
          const d = needsSep ? `\n\n${t}` : t;
          response += d;
          lastKind = 'text';
          onEvent({ kind: 'delta', text: d });
          return;
        }
        case 'agent_thought_chunk': {
          const t = u.content?.type === 'text' ? u.content.text : '';
          if (!t) return;
          if (lastKind !== 'thought') thoughtId = `think-${++thoughtSeq}`;
          lastKind = 'thought';
          onEvent({ kind: 'thought', id: thoughtId, text: t });
          return;
        }
        case 'tool_call':
        case 'tool_call_update': {
          const id = u.toolCallId;
          if (!id) return;
          const prev = tools.get(id) || { startedAt: Date.now() };
          const t = { ...prev, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) };
          tools.set(id, t);
          if (ASYNC_TOOLS.has(t.name) && !isDaemonTool(t)) sawAsyncTool = true;
          lastKind = 'tool';
          const done = t.status === 'completed' || t.status === 'failed';
          onEvent({
            kind: 'tool', id,
            name: t.name || '',
            title: t.title || '',
            params: t.rawInput || t.args || {},
            status: done ? (t.status === 'failed' ? 'error' : 'done') : 'running',
            duration: done ? (Date.now() - t.startedAt) / 1000 : null,
            output: done ? toolOutput(t) : null,
          });
          return;
        }
        default:
      }
    }

    // Tunggu sampai semua background task, subagent, dan reactive wakeup selesai.
    function waitForBackgroundIdle(baseline) {
      return new Promise((doneWait) => {
        const tracker = { subFirstSeen: new Map(), subDoneAt: new Map() };
        let lastMtime = 0;
        let idleSince = null;
        const done = () => { clearBgTimer(); doneWait(); };
        if (signal?.aborted || settled) { done(); return; }
        signal?.addEventListener('abort', done, { once: true });

        const check = () => {
          if (settled || signal?.aborted) { done(); return; }
          const now = Date.now();
          if (inQuestion || hasRunningTools()) { idleSince = null; return; }

          const st = inspectBackgroundState(brainDir, sessionId, baseline, now, tracker);
          if (st.maxMtimeMs > lastMtime) {
            lastMtime = st.maxMtimeMs;
            try { onActivity?.(); } catch {}
          }
          if (st.busy) { idleSince = null; return; }
          if (idleSince === null) idleSince = now;
          if (now - idleSince >= BG_STABILIZE_MS && now - lastUpdateAt >= BG_STABILIZE_MS) done();
        };

        bgTimer = setInterval(check, BG_POLL_MS);
        check();
      });
    }

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && !m.method) { // respons atas request kita
          const p = pending.get(m.id);
          if (!p) continue;
          pending.delete(m.id);
          if (m.error) {
            const e = new Error(m.error.message || 'ACP error');
            e.code = m.error.code; e.data = m.error.data;
            p.rej(e);
          } else p.res(m.result || {});
        } else if (m.method && m.id != null) {
          handleServerRequest(m).catch((e) => replyError(m.id, -32603, String(e?.message || e)));
        } else if (m.method === 'session/update') {
          handleUpdate(m.params?.update);
        }
      }
    });
    proc.on('close', (code) => finish({
      status: 'ERROR', response: response || '', conversation_id: sessionId,
      error: `agy acp berhenti (code ${code ?? '?'})`, closed: true,
    }));
    proc.on('error', (e) => finish({ status: 'ERROR', response: response || String(e.message || e), conversation_id: sessionId, error: String(e) }));
    signal?.addEventListener('abort', onSignalAbort, { once: true });

    (async () => {
      try {
        await request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
          clientInfo: { name: 'antigpt', version: '1.0.0' },
        });
        if (conversationId) {
          try {
            // resume (bukan load): tidak me-replay riwayat percakapan
            await request('session/resume', { sessionId: conversationId, cwd, mcpServers: [] });
            sessionId = conversationId;
          } catch (e) {
            log(`session/resume ${conversationId} gagal (${e.message}) → buat sesi baru`);
          }
        }
        if (!sessionId) {
          const s = await request('session/new', { cwd, mcpServers: [] });
          sessionId = s.sessionId;
          if (!sessionId) throw new Error('session/new tidak mengembalikan sessionId');
        }
        onEvent({ kind: 'session', id: sessionId });
        if (model) {
          try { await request('session/set_model', { sessionId, modelId: model }); }
          catch (e) { throw new Error(`Model "${model}" tidak bisa dipakai: ${e.message}`); }
        }
        // Catat jumlah baris transkrip sebelum giliran ini dimulai (hanya cek aktivitas giliran ini)
        const pre = readTranscript(brainDir, sessionId);
        const baseline = pre ? pre.steps.length : 0;

        prompting = true;
        const r = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

        // Jika giliran ini meluncurkan subagent atau background task, tunggu sampai benar-benar selesai
        // sebelum menutup `agy acp` (kalau tidak, subagent seperti image-generator langsung terbunuh).
        if (r.stopReason !== 'cancelled' && !signal?.aborted && !settled) {
          const initBg = brainDir
            ? inspectBackgroundState(brainDir, sessionId, baseline, Date.now(), { subFirstSeen: new Map(), subDoneAt: new Map() })
            : { busy: false };
          if (hasRunningTools() || sawAsyncTool || initBg.busy) {
            lastUpdateAt = Date.now();
            onEvent({ kind: 'status', text: 'Menunggu proses latar belakang…' });
            await waitForBackgroundIdle(baseline);
          }
        }

        finish({
          status: (r.stopReason === 'cancelled' || signal?.aborted) ? 'CANCELLED' : 'SUCCESS',
          stopReason: r.stopReason,
          response,
          conversation_id: sessionId,
          usage: mapUsage(r.usage),
        });
      } catch (e) {
        const detail = e.data ? ` ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}` : '';
        finish({ status: 'ERROR', response: response || `${e.message}${detail}`, conversation_id: sessionId, error: `${e.message}${detail}` });
      }
    })();
  });
}
