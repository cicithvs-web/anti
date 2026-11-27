// libraryScanner.js — pengumpul & anti-duplikat untuk halaman Artefak (buatan AI) dan Droply (kiriman User).
// Anti-duplikat berlapis:
//   1. realPath fisik yang sama (mis. AI menyebut [video.mp4] di pesan 1 lalu menyebut lagi di pesan 2) -> 1 item
//   2. Sidik jari konten (size + SHA-256) identik (mis. file di-copy dengan nama berbeda / upload ulang) -> 1 item
//   3. URL dinormalisasi agar link kembar tidak muncul berulang.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitTextWithLinks } from '../src/utils/linkify.js';
import { parseUserRequest } from './transcriptParser.js';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const PREVIEW_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.bash', '.zsh',
  '.html', '.htm', '.css', '.scss', '.less', '.sql', '.yaml', '.yml', '.toml',
  '.ini', '.conf', '.cfg', '.xml', '.env', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.lua', '.swift', '.dart',
  '.r', '.vue', '.svelte', '.graphql', '.prisma',
]);

// Cache sidik jari konten di memori berdasarkan realPath:size:mtimeMs supaya buka ulang <2ms
const hashCache = new Map();
const MAX_HASH_CACHE = 5000;
const FULL_HASH_MAX_BYTES = 32 * 1024 * 1024; // <= 32 MB di-hash penuh; > 32 MB pakai sampel cepat head+mid+tail
const SAMPLE_CHUNK = 64 * 1024;

function contentFingerprint(realPath, stat) {
  const cacheKey = `${realPath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  const hit = hashCache.get(cacheKey);
  if (hit) return hit;

  let digest = '';
  let fd;
  try {
    const h = crypto.createHash('sha256');
    h.update(`sz:${stat.size}:`);
    fd = fs.openSync(realPath, 'r');
    if (stat.size <= FULL_HASH_MAX_BYTES) {
      const buf = Buffer.allocUnsafe(Math.min(stat.size || 1, 256 * 1024));
      let pos = 0;
      while (pos < stat.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, stat.size - pos), pos);
        if (n <= 0) break;
        h.update(buf.subarray(0, n));
        pos += n;
      }
    } else {
      const buf = Buffer.allocUnsafe(SAMPLE_CHUNK);
      const offsets = [
        0,
        Math.max(0, Math.floor(stat.size / 2) - Math.floor(SAMPLE_CHUNK / 2)),
        Math.max(0, stat.size - SAMPLE_CHUNK),
      ];
      for (const off of offsets) {
        const n = fs.readSync(fd, buf, 0, SAMPLE_CHUNK, off);
        if (n > 0) h.update(buf.subarray(0, n));
      }
    }
    digest = `${stat.size}:${h.digest('hex')}`;
  } catch {
    digest = `${stat.size}:${realPath}`;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  if (hashCache.size >= MAX_HASH_CACHE) {
    const firstKey = hashCache.keys().next().value;
    if (firstKey !== undefined) hashCache.delete(firstKey);
  }
  hashCache.set(cacheKey, digest);
  return digest;
}

function normalizeUrlKey(rawHref) {
  try {
    const u = new URL(rawHref);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Abaikan link internal file/media endpoint AntiGPT sendiri
    if (/^\/api\/chats\//i.test(u.pathname)) return null;
    u.hash = '';
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const cleanPath = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
    return `${host}${cleanPath}${u.search}`;
  } catch {
    return null;
  }
}

function extractDomain(rawHref) {
  try {
    return new URL(rawHref).hostname.replace(/^www\./i, '');
  } catch {
    return rawHref;
  }
}

function stripCodeBlocks(md) {
  return String(md || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, ' ');
}

function extractLocalPathCandidate(rawTarget) {
  let s = String(rawTarget || '').trim();
  if (!s) return null;
  // Tangkap URL internal /api/chats/:chatId/(images|media|files)/<nama>
  const apiMatch = /\/api\/chats\/[^/]+\/(?:images|media|files)\/([^?#]+)/i.exec(s);
  if (apiMatch) {
    try { return decodeURIComponent(apiMatch[1]); } catch { return apiMatch[1]; }
  }
  if (/^(?:https?:|mailto:|tel:|javascript:|data:|blob:)/i.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, '');
  }
  s = s.split(/[?#]/, 1)[0].replace(/\\/g, '/').trim();
  // Jika AI menulis path sandbox /home/AntiGPT/project/...
  s = s.replace(/^\/home\/antigpt\/(?:project\/)?/i, '');
  s = s.replace(/^\.\/(?:project\/)?/i, '');
  try { s = decodeURIComponent(s); } catch {}
  const base = path.posix.basename(s);
  if (!base || base.startsWith('.') || !/\.[a-z0-9]{1,12}$/i.test(base)) return null;
  return s;
}

export function extractAssistantCandidates(markdownText) {
  const clean = stripCodeBlocks(markdownText);
  const refs = [];
  const links = [];
  const mdSpans = [];

  const mdRe = /(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = mdRe.exec(clean)) !== null) {
    mdSpans.push([m.index, m.index + m[0].length]);
    const isBang = m[1] === '!';
    const label = (m[2] || '').trim();
    const rawUrl = (m[3] || m[4] || '').trim();
    if (!rawUrl) continue;

    if (/^https?:\/\//i.test(rawUrl) && !/\/api\/chats\//i.test(rawUrl)) {
      if (!isBang) links.push({ href: rawUrl, text: label || rawUrl });
      continue;
    }
    const local = extractLocalPathCandidate(rawUrl);
    if (local) {
      refs.push({ path: local, label });
    }
  }

  // Ambil sisa teks di luar [label](url) untuk mencari bare URL / https:// polos
  let stripped = '';
  let last = 0;
  for (const [a, b] of mdSpans) {
    if (a > last) stripped += clean.slice(last, a) + ' ';
    last = b;
  }
  if (last < clean.length) stripped += clean.slice(last);

  for (const seg of splitTextWithLinks(stripped)) {
    if (seg.type === 'link') {
      links.push({ href: seg.href, text: seg.text });
    }
  }

  return { refs, links };
}

export function extractUserLinks(text) {
  const links = [];
  for (const seg of splitTextWithLinks(String(text || ''))) {
    if (seg.type === 'link') {
      links.push({ href: seg.href, text: seg.text });
    }
  }
  return links;
}

const transcriptCache = new Map();
const MAX_TRANSCRIPT_CACHE = 500;

function getTranscriptExtracts(brainBaseDir, conversationId) {
  const id = String(conversationId || '').trim();
  if (!brainBaseDir || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
    return { assistantRefs: [], assistantLinks: [], userLinks: [] };
  }
  const fullFile = path.join(brainBaseDir, id, '.system_generated', 'logs', 'transcript_full.jsonl');
  const compactFile = path.join(brainBaseDir, id, '.system_generated', 'logs', 'transcript.jsonl');
  const target = fs.existsSync(fullFile) ? fullFile : compactFile;
  let stat;
  try { stat = fs.statSync(target); } catch {
    return { assistantRefs: [], assistantLinks: [], userLinks: [] };
  }
  const cacheKey = `${target}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  const cached = transcriptCache.get(cacheKey);
  if (cached) return cached;

  const assistantRefs = [];
  const assistantLinks = [];
  const userLinks = [];
  try {
    const raw = fs.readFileSync(target, 'utf8');
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim();
      if (!s) continue;
      if (!s.includes('PLANNER_RESPONSE') && !s.includes('USER_INPUT')) continue;
      let st;
      try { st = JSON.parse(s); } catch { continue; }
      if (st?.type === 'PLANNER_RESPONSE' && st.content) {
        const ex = extractAssistantCandidates(st.content);
        assistantRefs.push(...ex.refs);
        assistantLinks.push(...ex.links);
      } else if (st?.type === 'USER_INPUT' && st.content) {
        const { text } = parseUserRequest(st.content);
        userLinks.push(...extractUserLinks(text));
      }
    }
  } catch {}

  const val = { assistantRefs, assistantLinks, userLinks };
  if (transcriptCache.size >= MAX_TRANSCRIPT_CACHE) {
    const firstKey = transcriptCache.keys().next().value;
    if (firstKey !== undefined) transcriptCache.delete(firstKey);
  }
  transcriptCache.set(cacheKey, val);
  return val;
}

function stripMulterUploadPrefix(filename) {
  // Format upload multer: <timestamp>-<8hex>-<safeName>
  const m = /^(\d{10,})-[a-zA-Z0-9]{6,12}-(.+)$/.exec(filename);
  if (m) return { uploadedAt: Number(m[1]) || 0, displayName: m[2] };
  return { uploadedAt: 0, displayName: filename };
}

function classifyFileKind(ext) {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e)) return { bucket: 'media', mediaKind: 'image', previewable: true };
  if (VIDEO_EXTS.has(e)) return { bucket: 'media', mediaKind: 'video', previewable: true };
  if (AUDIO_EXTS.has(e)) return { bucket: 'files', fileKind: 'audio', previewable: true };
  if (e === '.pdf') return { bucket: 'files', fileKind: 'pdf', previewable: true };
  if (PREVIEW_TEXT_EXTS.has(e)) return { bucket: 'files', fileKind: 'text', previewable: true };
  return { bucket: 'files', fileKind: 'binary', previewable: false };
}

/**
 * Kumpulkan item Media, Berkas, & Tautan tanpa duplikat.
 * @param {object} params
 * @param {'artifacts'|'droply'} params.scope
 * @param {Array<{id:string, title?:string, updatedAt?:number, refs?:Array, links?:Array}>} params.chats
 * @param {object} params.agy  modul server/agy.js
 * @param {string} params.brainBaseDir  path ke antigravity-cli/brain
 * @param {(chatId:string, reqPath:string)=>string|null} params.resolveChatFile
 */
export function scanLibrary({ scope, chats, agy, brainBaseDir, resolveChatFile }) {
  const seenRealPaths = new Set();
  const seenContentHashes = new Map(); // contentHash -> item
  const seenLinks = new Map();         // normUrl -> linkItem
  const media = [];
  const files = [];

  // Urutkan chat dari yang terbaru ke terlama supaya nama/konteks terbaru yang dipakai saat dedupe
  const orderedChats = [...(chats || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  for (const chat of orderedChats) {
    const rawId = String(chat?.id || '').trim();
    if (!rawId) continue;
    const slug = agy.slugify(rawId);
    if (!slug || slug === 'default') continue;

    const sessionRoot = path.resolve(agy.BASE, slug);
    const hasSessionDir = sessionRoot.startsWith(path.resolve(agy.BASE) + path.sep) && fs.existsSync(sessionRoot);
    const state = hasSessionDir ? agy.readState(slug) : {};
    const chatTitle = String(chat.title || state.title || slug).trim();
    const baseTime = Number(chat.updatedAt) || 0;

    if (scope === 'artifacts') {
      let refs = Array.isArray(chat.refs) ? chat.refs : null;
      let linkList = Array.isArray(chat.links) ? chat.links : null;

      // Fallback dari transcript server (mis. mode Admin atau chat belum di-hydrate di memori klien)
      if ((!refs || !linkList) && state?.conversation_id) {
        const ex = getTranscriptExtracts(brainBaseDir, state.conversation_id);
        if (!refs) refs = ex.assistantRefs;
        if (!linkList) linkList = ex.assistantLinks;
      }

      const projectDir = path.join(sessionRoot, 'project');
      const uploadsDir = path.join(projectDir, 'uploads');
      const uploadsPrefix = uploadsDir + path.sep;
      let realProj = '';
      let realUploadsPrefix = uploadsPrefix;
      if (hasSessionDir) {
        try { if (fs.existsSync(projectDir)) realProj = fs.realpathSync(projectDir); } catch {}
        try { if (fs.existsSync(uploadsDir)) realUploadsPrefix = fs.realpathSync(uploadsDir) + path.sep; } catch {}
      }
      const seenReqPathsInChat = new Set();

      for (const ref of (refs || [])) {
        const reqPath = typeof ref === 'string' ? ref : ref?.path;
        if (!reqPath || !hasSessionDir || seenReqPathsInChat.has(reqPath)) continue;
        seenReqPathsInChat.add(reqPath);
        const realPath = resolveChatFile(rawId, reqPath);
        if (!realPath) continue;

        // Jangan masukkan file upload kiriman user ke Artefak buatan AI!
        if (realPath.startsWith(uploadsPrefix) || realPath.startsWith(realUploadsPrefix)) continue;

        if (seenRealPaths.has(realPath)) continue;
        seenRealPaths.add(realPath);

        let stat;
        try { stat = fs.statSync(realPath); } catch { continue; }
        if (!stat.isFile() || stat.size <= 0) continue;

        const hash = contentFingerprint(realPath, stat);
        if (seenContentHashes.has(hash)) continue;

        const actualName = path.basename(realPath);
        const ext = path.extname(actualName).toLowerCase();
        const kind = classifyFileKind(ext);
        // Hitung path relatif terhadap project/ bila berada di subfolder supaya resolveChatFile akurat
        let serveName = actualName;
        if (realProj && realPath.startsWith(realProj + path.sep)) {
          serveName = path.relative(realProj, realPath).split(path.sep).join('/');
        }

        const item = {
          id: `${rawId}:${serveName}`,
          name: actualName,
          label: (ref?.label && ref.label !== actualName) ? ref.label : '',
          serveName,
          ext: ext.slice(1).toUpperCase() || 'FILE',
          size: stat.size,
          at: Math.round(stat.mtimeMs) || baseTime,
          chatId: rawId,
          chatTitle,
          previewable: kind.previewable,
          ...(kind.bucket === 'media' ? { mediaKind: kind.mediaKind } : { fileKind: kind.fileKind }),
        };
        seenContentHashes.set(hash, item);
        if (kind.bucket === 'media') media.push(item);
        else files.push(item);
      }

      for (const lnk of (linkList || [])) {
        if (!lnk?.href) continue;
        const key = normalizeUrlKey(lnk.href);
        if (!key || seenLinks.has(key)) continue;
        seenLinks.set(key, {
          id: `lnk:${key}`,
          href: lnk.href,
          title: (lnk.text && lnk.text !== lnk.href) ? lnk.text : extractDomain(lnk.href),
          domain: extractDomain(lnk.href),
          chatId: rawId,
          chatTitle,
          at: baseTime,
        });
      }
    } else if (scope === 'droply') {
      // 1. Semua file & media yang pernah di-upload user di chat ini (folder ./project/uploads/)
      if (hasSessionDir) {
        const uploadsDir = path.join(sessionRoot, 'project', 'uploads');
        if (fs.existsSync(uploadsDir)) {
          let entries = [];
          try { entries = fs.readdirSync(uploadsDir, { withFileTypes: true }); } catch {}
          // Urutkan file terbaru dulu
          const fileEntries = [];
          for (const ent of entries) {
            if (!ent.isFile() || ent.name.startsWith('.')) continue;
            const full = path.join(uploadsDir, ent.name);
            let realPath, stat;
            try {
              realPath = fs.realpathSync(full);
              stat = fs.statSync(realPath);
            } catch { continue; }
            if (!stat.isFile() || stat.size <= 0) continue;
            const { uploadedAt, displayName } = stripMulterUploadPrefix(ent.name);
            fileEntries.push({
              entName: ent.name,
              realPath,
              stat,
              displayName,
              at: uploadedAt || Math.round(stat.mtimeMs) || baseTime,
            });
          }
          fileEntries.sort((a, b) => b.at - a.at);

          for (const fe of fileEntries) {
            if (seenRealPaths.has(fe.realPath)) continue;
            seenRealPaths.add(fe.realPath);

            const hash = contentFingerprint(fe.realPath, fe.stat);
            if (seenContentHashes.has(hash)) continue;

            const ext = path.extname(fe.displayName).toLowerCase();
            const kind = classifyFileKind(ext);
            const serveName = `uploads/${fe.entName}`;
            const item = {
              id: `${rawId}:${serveName}`,
              name: fe.displayName,
              label: '',
              serveName,
              ext: ext.slice(1).toUpperCase() || 'FILE',
              size: fe.stat.size,
              at: fe.at,
              chatId: rawId,
              chatTitle,
              previewable: kind.previewable,
              ...(kind.bucket === 'media' ? { mediaKind: kind.mediaKind } : { fileKind: kind.fileKind }),
            };
            seenContentHashes.set(hash, item);
            if (kind.bucket === 'media') media.push(item);
            else files.push(item);
          }
        }
      }

      // 2. Semua tautan yang pernah dikirim user di chat ini
      let linkList = Array.isArray(chat.links) ? chat.links : null;
      if (!linkList && state?.conversation_id) {
        linkList = getTranscriptExtracts(brainBaseDir, state.conversation_id).userLinks;
      }

      for (const lnk of (linkList || [])) {
        if (!lnk?.href) continue;
        const key = normalizeUrlKey(lnk.href);
        if (!key || seenLinks.has(key)) continue;
        seenLinks.set(key, {
          id: `lnk:${key}`,
          href: lnk.href,
          title: (lnk.text && lnk.text !== lnk.href) ? lnk.text : extractDomain(lnk.href),
          domain: extractDomain(lnk.href),
          chatId: rawId,
          chatTitle,
          at: baseTime,
        });
      }
    }
  }

  media.sort((a, b) => (b.at || 0) - (a.at || 0));
  files.sort((a, b) => (b.at || 0) - (a.at || 0));
  const links = [...seenLinks.values()].sort((a, b) => (b.at || 0) - (a.at || 0));

  return { media, files, links };
}
