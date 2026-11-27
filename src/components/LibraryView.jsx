import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Play, Download, ExternalLink, Copy, Check, Search, X, Loader,
  File, FileArchive, FileText, FileCode, FileJson, FileSpreadsheet,
  FileAudio, FileCog, Globe, ArrowUpRight, Layers, Inbox, ImageOff,
} from 'lucide-react';
import { chatFileUrl, chatImageUrl, chatMediaUrl, getLibraryItems } from '../services/ai';
import { splitTextWithLinks } from '../utils/linkify';
import { fileExt, formatSize } from './AttachmentTray.jsx';
import ImageLightbox from './ImageLightbox.jsx';
import FilePreviewModal from './FilePreviewModal.jsx';

const TABS = [
  { id: 'media', label: 'Media' },
  { id: 'files', label: 'Berkas' },
  { id: 'links', label: 'Tautan' },
];

const EXT_ICON_GROUPS = [
  [FileArchive, ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst']],
  [FileJson, ['json', 'jsonl', 'ndjson']],
  [FileCog, ['yml', 'yaml', 'toml', 'ini', 'env', 'conf', 'cfg', 'xml']],
  [FileCode, ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'rb', 'sh', 'bash', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'swift', 'dart', 'lua']],
  [FileSpreadsheet, ['csv', 'tsv', 'xls', 'xlsx', 'ods']],
  [FileText, ['pdf', 'txt', 'md', 'markdown', 'doc', 'docx', 'ppt', 'pptx', 'odt', 'rtf', 'log']],
  [FileAudio, ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']],
];

function iconForFilename(name = '') {
  const ext = fileExt(name);
  for (const [Icon, list] of EXT_ICON_GROUPS) {
    if (list.includes(ext)) return Icon;
  }
  return File;
}

function stripCodeForScan(md) {
  return String(md || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, ' ');
}

function extractClientLocalPath(rawUrl) {
  let s = String(rawUrl || '').trim();
  if (!s) return null;
  const apiMatch = /\/api\/chats\/[^/]+\/(?:images|media|files)\/([^?#]+)/i.exec(s);
  if (apiMatch) {
    try { return decodeURIComponent(apiMatch[1]); } catch { return apiMatch[1]; }
  }
  if (/^(?:https?:|mailto:|tel:|javascript:|data:|blob:)/i.test(s)) return null;
  if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\//i, '');
  s = s.split(/[?#]/, 1)[0].replace(/\\/g, '/').trim();
  s = s.replace(/^\/home\/antigpt\/(?:project\/)?/i, '');
  s = s.replace(/^\.\/(?:project\/)?/i, '');
  try { s = decodeURIComponent(s); } catch {}
  const base = s.split('/').pop() || '';
  if (!base || base.startsWith('.') || !/\.[a-z0-9]{1,12}$/i.test(base)) return null;
  return s;
}

function extractAssistantFromClientMessages(messages = []) {
  const refs = [];
  const links = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !m.content) continue;
    const clean = stripCodeForScan(m.content);
    const spans = [];
    const re = /(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = re.exec(clean)) !== null) {
      spans.push([match.index, match.index + match[0].length]);
      const isBang = match[1] === '!';
      const label = (match[2] || '').trim();
      const rawUrl = (match[3] || match[4] || '').trim();
      if (!rawUrl) continue;
      if (/^https?:\/\//i.test(rawUrl) && !/\/api\/chats\//i.test(rawUrl)) {
        if (!isBang) links.push({ href: rawUrl, text: label || rawUrl });
        continue;
      }
      const local = extractClientLocalPath(rawUrl);
      if (local) refs.push({ path: local, label });
    }
    let rest = '';
    let last = 0;
    for (const [a, b] of spans) {
      if (a > last) rest += clean.slice(last, a) + ' ';
      last = b;
    }
    if (last < clean.length) rest += clean.slice(last);
    for (const seg of splitTextWithLinks(rest)) {
      if (seg.type === 'link') links.push({ href: seg.href, text: seg.text });
    }
  }
  return { refs, links };
}

function extractUserLinksFromClientMessages(messages = []) {
  const links = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user' || !m.content) continue;
    for (const seg of splitTextWithLinks(m.content)) {
      if (seg.type === 'link') links.push({ href: seg.href, text: seg.text });
    }
  }
  return links;
}

function MediaCell({ item, onOpen }) {
  const [broken, setBroken] = useState(false);
  const isVideo = item.mediaKind === 'video';
  const src = isVideo
    ? `${chatMediaUrl(item.chatId, item.serveName)}#t=0.1`
    : chatImageUrl(item.chatId, item.serveName);

  return (
    <button
      type="button"
      className="lib-media-cell"
      onClick={onOpen}
      title={`${item.name} — ${item.chatTitle}`}
      aria-label={`Buka ${item.name}`}
    >
      {broken ? (
        <span className="lib-media-broken">
          <ImageOff size={20} />
          <small>{item.ext}</small>
        </span>
      ) : isVideo ? (
        <>
          <video
            src={src}
            preload="metadata"
            muted
            playsInline
            onError={() => setBroken(true)}
          />
          <span className="lib-video-badge">
            <Play size={11} fill="currentColor" />
            <span>{item.ext}</span>
          </span>
        </>
      ) : (
        <img
          src={src}
          alt={item.label || item.name}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      )}
    </button>
  );
}

export default function LibraryView({ scope, chats, isAdminView = false, refreshTick = 0, onOpenChat }) {
  const [tab, setTab] = useState('media');
  const [query, setQuery] = useState('');
  const [data, setData] = useState({ media: [], files: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [playingAudioId, setPlayingAudioId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    setQuery('');
    setPlayingAudioId(null);
  }, [scope]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let payloadChats = undefined;
      if (!isAdminView) {
        payloadChats = (chats || []).map((c) => {
          const msgs = Array.isArray(c.messages) ? c.messages : [];
          if (scope === 'artifacts') {
            const { refs, links } = extractAssistantFromClientMessages(msgs);
            return {
              id: c.id,
              title: c.title || '',
              updatedAt: c.updatedAt || 0,
              refs: msgs.length ? refs : undefined,
              links: msgs.length ? links : undefined,
            };
          }
          return {
            id: c.id,
            title: c.title || '',
            updatedAt: c.updatedAt || 0,
            links: msgs.length ? extractUserLinksFromClientMessages(msgs) : undefined,
          };
        });
      }
      const r = await getLibraryItems({
        scope,
        chats: payloadChats,
        allServer: isAdminView,
      });
      if (r?.ok) {
        setData({
          media: Array.isArray(r.media) ? r.media : [],
          files: Array.isArray(r.files) ? r.files : [],
          links: Array.isArray(r.links) ? r.links : [],
        });
      } else {
        setError(r?.error || 'Gagal memuat daftar.');
      }
    } catch (e) {
      setError(e?.body?.error || e?.message || 'Gagal memuat daftar.');
    } finally {
      setLoading(false);
    }
  }, [scope, chats, isAdminView]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems, refreshTick]);

  const q = query.trim().toLowerCase();

  const filteredMedia = useMemo(() => {
    if (!q) return data.media;
    return data.media.filter(it =>
      it.name.toLowerCase().includes(q)
      || (it.label || '').toLowerCase().includes(q)
      || (it.chatTitle || '').toLowerCase().includes(q)
    );
  }, [data.media, q]);

  const filteredFiles = useMemo(() => {
    if (!q) return data.files;
    return data.files.filter(it =>
      it.name.toLowerCase().includes(q)
      || (it.ext || '').toLowerCase().includes(q)
      || (it.chatTitle || '').toLowerCase().includes(q)
    );
  }, [data.files, q]);

  const filteredLinks = useMemo(() => {
    if (!q) return data.links;
    return data.links.filter(it =>
      (it.title || '').toLowerCase().includes(q)
      || (it.href || '').toLowerCase().includes(q)
      || (it.chatTitle || '').toLowerCase().includes(q)
    );
  }, [data.links, q]);

  const galleryItems = useMemo(() => filteredMedia.map((it) => ({
    name: `${it.label || it.name}${it.chatTitle ? ` · ${it.chatTitle}` : ''}`,
    url: it.mediaKind === 'video'
      ? chatMediaUrl(it.chatId, it.serveName)
      : chatImageUrl(it.chatId, it.serveName),
    kind: it.mediaKind === 'video' ? 'video' : 'image',
    downloadUrl: chatFileUrl(it.chatId, it.serveName),
  })), [filteredMedia]);

  const openMediaAt = (idx) => {
    if (!galleryItems[idx]) return;
    if (galleryItems.length > 1) {
      setLightbox({ items: galleryItems, index: idx });
    } else {
      setLightbox(galleryItems[0]);
    }
  };

  const handleOpenFile = (it) => {
    if (it.fileKind === 'audio') {
      setPlayingAudioId(cur => (cur === it.id ? null : it.id));
      return;
    }
    if (it.previewable && (it.fileKind === 'pdf' || it.fileKind === 'text')) {
      setPreviewFile({ chatId: it.chatId, filename: it.serveName, displayName: it.name });
      return;
    }
    // Biner / arsip -> unduh langsung
    const a = document.createElement('a');
    a.href = chatFileUrl(it.chatId, it.serveName);
    a.download = it.name;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleCopyLink = async (e, lnk) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(lnk.href);
      } else {
        const ta = document.createElement('textarea');
        ta.value = lnk.href;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopiedId(lnk.id);
      setTimeout(() => setCopiedId(cur => (cur === lnk.id ? null : cur)), 1600);
    } catch {}
  };

  const tabIndex = Math.max(0, TABS.findIndex(t => t.id === tab));
  const counts = {
    media: data.media.length,
    files: data.files.length,
    links: data.links.length,
  };
  const activeCount = counts[tab] || 0;
  const showSearch = activeCount > 3 || !!query;
  const isArtifactScope = scope === 'artifacts';
  const EmptyScopeIcon = isArtifactScope ? Layers : Inbox;

  return (
    <div className="lib-shell">
      {/* Tab kapsul melayang gaya Telegram (Media | Berkas | Tautan) */}
      <div className="lib-top-bar">
        <div className="lib-tabs-pill" role="tablist" aria-label={isArtifactScope ? 'Kategori Artefak' : 'Kategori Droply'}>
          <span
            className="lib-tab-slider"
            style={{ transform: `translateX(${tabIndex * 100}%)` }}
            aria-hidden="true"
          />
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={'lib-tab-btn' + (tab === t.id ? ' active' : '')}
              onClick={() => setTab(t.id)}
            >
              <span>{t.label}</span>
              {counts[t.id] > 0 && <small className="lib-tab-count">{counts[t.id]}</small>}
            </button>
          ))}
        </div>

        {showSearch && (
          <div className="lib-search-box">
            <Search size={15} className="lib-search-ico" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                tab === 'media'
                  ? 'Cari foto atau video…'
                  : tab === 'files'
                    ? 'Cari nama berkas atau obrolan…'
                    : 'Cari tautan atau domain…'
              }
            />
            {query && (
              <button type="button" className="lib-search-clear" onClick={() => setQuery('')} aria-label="Hapus pencarian">
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="lib-scroll">
        {loading ? (
          <div className="lib-empty-state">
            <Loader size={20} className="spin" />
            <span>Memuat {isArtifactScope ? 'artefak AI' : 'kiriman Droply'}…</span>
          </div>
        ) : error ? (
          <div className="lib-empty-state lib-err">{error}</div>
        ) : tab === 'media' ? (
          filteredMedia.length > 0 ? (
            <div className="lib-media-grid">
              {filteredMedia.map((it, idx) => (
                <MediaCell key={it.id} item={it} onOpen={() => openMediaAt(idx)} />
              ))}
            </div>
          ) : (
            <div className="lib-empty-state">
              <EmptyScopeIcon size={28} strokeWidth={1.6} />
              <strong>{q ? 'Media tidak ditemukan' : 'Belum ada media'}</strong>
              <small>
                {isArtifactScope
                  ? 'Semua gambar & video yang dibuat AI akan otomatis terkumpul rapi di sini tanpa duplikat.'
                  : 'Semua foto & video yang kamu kirim ke obrolan akan otomatis tersimpan di sini.'}
              </small>
            </div>
          )
        ) : tab === 'files' ? (
          filteredFiles.length > 0 ? (
            <div className="lib-list">
              {filteredFiles.map((it) => {
                const Icon = iconForFilename(it.name);
                const isAudio = it.fileKind === 'audio';
                const audioOpen = isAudio && playingAudioId === it.id;
                const dlUrl = chatFileUrl(it.chatId, it.serveName);
                return (
                  <div key={it.id} className="lib-card-wrap">
                    <div className="lib-card">
                      <button
                        type="button"
                        className="lib-card-main"
                        onClick={() => handleOpenFile(it)}
                        title={it.name}
                      >
                        <span className={'lib-card-icon' + (isAudio ? ' audio' : '')}>
                          {isAudio ? <Play size={18} fill="currentColor" /> : <Icon size={20} />}
                        </span>
                        <span className="lib-card-body">
                          <strong className="lib-card-title">{it.name}</strong>
                          <small className="lib-card-sub">
                            {[it.ext, formatSize(it.size), it.chatTitle].filter(Boolean).join(' · ')}
                          </small>
                        </span>
                      </button>
                      <div className="lib-card-actions">
                        {onOpenChat && (
                          <button
                            type="button"
                            className="lib-act-btn"
                            onClick={() => onOpenChat(it.chatId)}
                            title={`Buka chat: ${it.chatTitle}`}
                            aria-label="Buka obrolan asal"
                          >
                            <ArrowUpRight size={17} />
                          </button>
                        )}
                        <a
                          className="lib-act-btn"
                          href={dlUrl}
                          download={it.name}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Unduh berkas"
                          aria-label={`Unduh ${it.name}`}
                        >
                          <Download size={17} />
                        </a>
                      </div>
                    </div>
                    {audioOpen && (
                      <div className="lib-audio-row">
                        <audio controls autoPlay src={chatMediaUrl(it.chatId, it.serveName)} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="lib-empty-state">
              <EmptyScopeIcon size={28} strokeWidth={1.6} />
              <strong>{q ? 'Berkas tidak ditemukan' : 'Belum ada berkas'}</strong>
              <small>
                {isArtifactScope
                  ? 'PDF, script kode, dokumen Office, audio, atau ZIP hasil buatan AI akan muncul di sini.'
                  : 'Berkas dokumen, PDF, kode, atau ZIP yang kamu lampirkan di chat akan muncul di sini.'}
              </small>
            </div>
          )
        ) : filteredLinks.length > 0 ? (
          <div className="lib-list">
            {filteredLinks.map((lnk) => (
              <div key={lnk.id} className="lib-card">
                <a
                  className="lib-card-main lib-link-main"
                  href={lnk.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={lnk.href}
                >
                  <span className="lib-card-icon link">
                    <Globe size={19} />
                  </span>
                  <span className="lib-card-body">
                    <strong className="lib-card-title">{lnk.title || lnk.domain}</strong>
                    <span className="lib-link-url">{lnk.href}</span>
                    <small className="lib-card-sub">
                      {[lnk.domain, lnk.chatTitle].filter(Boolean).join(' · ')}
                    </small>
                  </span>
                </a>
                <div className="lib-card-actions">
                  <button
                    type="button"
                    className="lib-act-btn"
                    onClick={(e) => handleCopyLink(e, lnk)}
                    title="Salin tautan"
                    aria-label="Salin tautan"
                  >
                    {copiedId === lnk.id ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                  {onOpenChat && (
                    <button
                      type="button"
                      className="lib-act-btn"
                      onClick={() => onOpenChat(lnk.chatId)}
                      title={`Buka chat: ${lnk.chatTitle}`}
                      aria-label="Buka obrolan asal"
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="lib-empty-state">
            <ExternalLink size={28} strokeWidth={1.6} />
            <strong>{q ? 'Tautan tidak ditemukan' : 'Belum ada tautan'}</strong>
            <small>
              {isArtifactScope
                ? 'Tautan referensi web yang dibagikan AI di dalam jawabannya akan muncul di sini.'
                : 'Semua link web yang pernah kamu kirim di obrolan akan terekap otomatis di sini.'}
            </small>
          </div>
        )}
      </div>

      <ImageLightbox
        item={lightbox}
        onClose={() => setLightbox(null)}
        onNavigate={(nextIdx) => setLightbox(prev => (prev?.items ? { ...prev, index: nextIdx } : prev))}
      />
      <FilePreviewModal
        file={previewFile}
        onClose={() => setPreviewFile(null)}
      />
    </div>
  );
}
