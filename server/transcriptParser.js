// transcriptParser.js — membaca ringkasan & riwayat pesan UI dari state.json + transcript.jsonl agy
// Dipakai oleh endpoint khusus admin agar riwayat semua sesi di VPS bisa dipantau & dilanjutkan.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_UPLOAD_INSTRUCTION = 'Analisis file terlampir secara detail dan jelaskan temuan utamanya.';
const MAX_TOOL_OUTPUT = 800;
const KEEP_TOOL_OUTPUT_TAIL = 25;

function parseArgValue(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"'))
    || (s.startsWith('{') && s.endsWith('}'))
    || (s.startsWith('[') && s.endsWith(']'))
    || s === 'true' || s === 'false' || s === 'null'
    || /^-?\d+(?:\.\d+)?$/.test(s)) {
    try { return JSON.parse(s); } catch {}
  }
  return v;
}

function parseToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) out[k] = parseArgValue(v);
  return out;
}

function cleanGenericOutput(raw) {
  let s = String(raw || '').replace(/\r\n/g, '\n');
  // Buang header boilerplate timestamp berulang dari transcript agy
  s = s.replace(/^(?:Created At:[^\n]*\n|Completed At:[^\n]*\n)+/g, '').trim();
  if (!s) return null;
  if (s.length > MAX_TOOL_OUTPUT) return s.slice(0, MAX_TOOL_OUTPUT) + '\n…';
  return s;
}

/**
 * Ekstrak teks prompt asli & daftar lampiran dari content USER_INPUT transcript agy.
 */
export function parseUserRequest(rawContent, sessionDir = '') {
  const raw = String(rawContent || '');
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(raw);
  const body = (m ? m[1] : raw).trim();
  const marker = '\n\n[ATTACHMENTS]\n';
  const idx = body.indexOf(marker);
  let text = idx >= 0 ? body.slice(0, idx).trim() : body;
  const attachments = [];

  if (idx >= 0) {
    const attBlock = body.slice(idx + marker.length);
    for (const line of attBlock.split('\n')) {
      const am = /^-\s+(.+?)\s+\(([^)]+)\):\s+(.+?)\s*$/.exec(line.trim());
      if (!am) continue;
      const [, name, type, sandboxPath] = am;
      const normalized = sandboxPath.replace(/\\/g, '/');
      const base = path.posix.basename(normalized);
      const isUpload = normalized.includes('/project/uploads/');
      const stored = isUpload && base ? `uploads/${base}` : null;
      let size;
      if (stored && sessionDir) {
        try {
          const st = fs.statSync(path.join(sessionDir, 'project', 'uploads', base));
          if (st.isFile()) size = st.size;
        } catch {}
      }
      attachments.push({ name, type: type === 'file' ? '' : type, ...(size != null ? { size } : {}), ...(stored ? { stored } : {}) });
    }
    if (attachments.length && text === DEFAULT_UPLOAD_INSTRUCTION) text = '';
  }

  return { text, attachments };
}

function transcriptPath(brainDir, conversationId, full = false) {
  const id = String(conversationId || '').trim();
  if (!brainDir || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) return null;
  return path.join(brainDir, id, '.system_generated', 'logs', full ? 'transcript_full.jsonl' : 'transcript.jsonl');
}

function hydrateTruncatedSteps(steps, brainDir, conversationId) {
  const need = new Set();
  for (const st of steps) {
    if (st.type !== 'USER_INPUT' && st.type !== 'PLANNER_RESPONSE' && st.type !== 'ERROR_MESSAGE') continue;
    const hasTruncFlag = Array.isArray(st.truncated_fields) && st.truncated_fields.length > 0;
    const hasTruncText = typeof st.content === 'string' && st.content.includes('<truncated ');
    if ((hasTruncFlag || hasTruncText) && st.step_index != null) {
      need.add(st.step_index);
    }
  }
  if (!need.size) return steps;

  const fullFile = transcriptPath(brainDir, conversationId, true);
  if (!fullFile) return steps;
  let fullRaw;
  try { fullRaw = fs.readFileSync(fullFile, 'utf8'); } catch { return steps; }

  const fullByIndex = new Map();
  for (const line of fullRaw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let st;
    try { st = JSON.parse(s); } catch { continue; }
    if (st.step_index != null && need.has(st.step_index)) {
      fullByIndex.set(st.step_index, st);
      if (fullByIndex.size === need.size) break;
    }
  }
  if (!fullByIndex.size) return steps;

  return steps.map((st) => {
    const full = st.step_index != null ? fullByIndex.get(st.step_index) : null;
    if (!full) return st;
    return {
      ...st,
      ...(full.content !== undefined ? { content: full.content } : {}),
      ...(full.thinking !== undefined ? { thinking: full.thinking } : {}),
      ...(full.tool_calls !== undefined ? { tool_calls: full.tool_calls } : {}),
    };
  });
}

/**
 * Baca cepat prompt pertama dari awal file transcript.jsonl (tanpa memuat seluruh file).
 */
export function extractFirstUserPrompt(brainDir, conversationId, sessionDir = '') {
  const file = transcriptPath(brainDir, conversationId);
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const chunk = buf.slice(0, bytes).toString('utf8');
    for (const line of chunk.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let step;
      try { step = JSON.parse(s); } catch { continue; }
      if (step.type === 'USER_INPUT') {
        const { text, attachments } = parseUserRequest(step.content, sessionDir);
        const clean = text.replace(/\s+/g, ' ').trim();
        if (clean) return clean.slice(0, 80);
        if (attachments.length) return attachments[0].name.slice(0, 80);
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return null;
}

/**
 * Konversi transcript.jsonl menjadi daftar pesan siap tampil untuk ChatView.
 */
export function parseTranscriptMessages(brainDir, conversationId, sessionDir, { toolLabel, toolKind }) {
  const file = transcriptPath(brainDir, conversationId);
  if (!file) return { messages: [], lastStepTs: 0 };

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { messages: [], lastStepTs: 0 }; }

  const rawSteps = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rawSteps.push(JSON.parse(s)); } catch {}
  }
  const steps = hydrateTruncatedSteps(rawSteps, brainDir, conversationId);

  const messages = [];
  let currentAi = null;
  let pendingToolSteps = [];
  let lastStepTs = 0;

  const flushAi = () => {
    if (!currentAi) return;
    // Hemat payload untuk giliran yang punya puluhan/ratusan tool: pertahankan output untuk 25 tool terakhir
    const toolIndices = [];
    for (let i = 0; i < currentAi.steps.length; i++) {
      if (currentAi.steps[i].kind !== 'think') toolIndices.push(i);
    }
    if (toolIndices.length > KEEP_TOOL_OUTPUT_TAIL) {
      const dropUntil = toolIndices.length - KEEP_TOOL_OUTPUT_TAIL;
      for (let k = 0; k < dropUntil; k++) currentAi.steps[toolIndices[k]].output = null;
    }
    if (currentAi.content || currentAi.steps.length) {
      messages.push(currentAi);
    }
    currentAi = null;
    pendingToolSteps = [];
  };

  for (const step of steps) {

    const ts = step.created_at ? Date.parse(step.created_at) : 0;
    if (Number.isFinite(ts) && ts > lastStepTs) lastStepTs = ts;

    if (step.type === 'USER_INPUT') {
      flushAi();
      const { text, attachments } = parseUserRequest(step.content, sessionDir);
      messages.push({
        id: `u-${step.step_index ?? messages.length}`,
        role: 'user',
        content: text,
        ...(attachments.length ? { attachments } : {}),
        createdAt: ts || null,
      });
      currentAi = {
        id: `a-${step.step_index ?? messages.length}`,
        role: 'assistant',
        content: '',
        steps: [],
        fromHistory: true,
        createdAt: ts || null,
      };
      pendingToolSteps = [];
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      if (!currentAi) {
        currentAi = {
          id: `a-${step.step_index ?? messages.length}`,
          role: 'assistant',
          content: '',
          steps: [],
          fromHistory: true,
          createdAt: ts || null,
        };
      }
      if (step.thinking && String(step.thinking).trim()) {
        currentAi.steps.push({
          id: `think-${step.step_index}`,
          kind: 'think',
          label: 'Berpikir',
          text: String(step.thinking),
          status: 'done',
        });
      }
      if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
        step.tool_calls.forEach((tc, idx) => {
          const name = tc?.name || 'tool';
          const params = parseToolArgs(tc?.args);
          const item = {
            id: `tool-${step.step_index}-${idx}`,
            kind: toolKind(name),
            tool: name,
            label: toolLabel(name, params),
            status: 'done',
            duration: null,
            output: null,
          };
          currentAi.steps.push(item);
          pendingToolSteps.push(item);
        });
      }
      if (step.content && String(step.content).trim()) {
        const piece = String(step.content);
        if (currentAi.content && !currentAi.content.endsWith('\n\n') && !piece.startsWith('\n')) {
          currentAi.content += '\n\n' + piece;
        } else {
          currentAi.content += piece;
        }
      }
      continue;
    }

    if (step.type === 'GENERIC' && currentAi) {
      const target = pendingToolSteps.shift();
      if (target) {
        const out = cleanGenericOutput(step.content);
        if (out) target.output = out;
        if (step.status === 'RUNNING') target.status = 'running';
      }
      continue;
    }

    if (step.type === 'ERROR_MESSAGE' && step.content) {
      if (!currentAi) {
        currentAi = {
          id: `a-${step.step_index ?? messages.length}`,
          role: 'assistant',
          content: '',
          steps: [],
          fromHistory: true,
          createdAt: ts || null,
        };
      }
      const errText = `❌ ${String(step.content).trim()}`;
      currentAi.content = currentAi.content ? `${currentAi.content}\n\n${errText}` : errText;
    }
  }

  flushAi();
  return { messages, lastStepTs };
}

/**
 * Ringkas 1 folder sesi di server/sessions/<slug>.
 */
export function summarizeSession(slug, sessionRoot, brainDir) {
  let state = {};
  let stateMtime = 0;
  const statePath = path.join(sessionRoot, 'state.json');
  try {
    const stat = fs.statSync(statePath);
    stateMtime = stat.mtimeMs;
    state = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
  } catch {}

  let dirStat = null;
  try { dirStat = fs.statSync(sessionRoot); } catch {}

  const convId = state.conversation_id || null;
  let trMtime = 0;
  const trFile = transcriptPath(brainDir, convId);
  if (trFile) {
    try { trMtime = fs.statSync(trFile).mtimeMs; } catch {}
  }

  const title = (typeof state.title === 'string' && state.title.trim())
    || extractFirstUserPrompt(brainDir, convId, sessionRoot)
    || slug;

  const updatedAt = Math.max(
    Number(state.last_ts) || 0,
    stateMtime,
    trMtime,
    dirStat?.mtimeMs || 0,
  ) || Date.now();

  const createdAt = dirStat?.birthtimeMs || dirStat?.ctimeMs || updatedAt;

  return {
    id: slug,
    title: title.slice(0, 120),
    pinned: !!state.pinned,
    model: state.model || null,
    conversationId: convId,
    updatedAt,
    createdAt,
    usage: state.last_usage || null,
    serverChat: true,
  };
}
