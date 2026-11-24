import { Children, createContext, isValidElement, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowDown, Check, Copy, Download, File, Film, ImageOff, Maximize2, Music,
  Info, Lightbulb, MessageSquareWarning, AlertTriangle, OctagonAlert,
} from 'lucide-react';
import ThinkingProcess from './ThinkingProcess';
import MermaidDiagram from './MermaidDiagram';
import FilePreviewModal from './FilePreviewModal';
import ReactMarkdown from 'react-markdown';
import 'katex/dist/katex.min.css';
import { preprocessLatex, REMARK_PLUGINS, REHYPE_PLUGINS } from '../utils/markdownPlugins';
import { splitTextWithLinks } from '../utils/linkify';
import { chatFileUrl, chatImageUrl, chatMediaUrl } from '../services/ai';
import { FileCard, ImageThumb, keyOf } from './AttachmentTray.jsx';
import ImageLightbox from './ImageLightbox.jsx';

const InTableContext = createContext(false);
const VIDEO_RE = /\.(?:mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_RE = /\.(?:mp3|wav|ogg|m4a|aac|flac)$/i;
const PDF_RE = /\.pdf$/i;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;
const PREVIEW_TEXT_RE = /\.(?:md|markdown|txt|log|csv|tsv|json|jsonl|ndjson|js|mjs|cjs|jsx|ts|tsx|py|sh|bash|zsh|html|htm|css|scss|less|sql|yaml|yml|toml|ini|conf|cfg|xml|env|go|rs|java|kt|c|h|cpp|hpp|cs|php|rb|lua|swift|dart|r|vue|svelte|graphql|prisma)$/i;

function isPreviewableFilename(name = '') {
  return PDF_RE.test(name) || PREVIEW_TEXT_RE.test(name);
}

function fileCategoryLabel(ext) {
  const e = String(ext || '').toUpperCase();
  if (e === 'PDF') return `Dokumen · ${e}`;
  if (e === 'MD' || e === 'MARKDOWN') return `Markdown · ${e}`;
  if (['CSV', 'TSV', 'JSON', 'JSONL', 'YAML', 'YML', 'XML'].includes(e)) return `Data · ${e}`;
  if (['TXT', 'LOG'].includes(e)) return `Teks · ${e}`;
  if (['JS', 'MJS', 'CJS', 'JSX', 'TS', 'TSX', 'PY', 'SH', 'BASH', 'HTML', 'CSS', 'SQL', 'GO', 'RS', 'JAVA', 'PHP', 'RB', 'C', 'CPP', 'CS'].includes(e)) {
    return `Kode · ${e}`;
  }
  return e || 'FILE';
}

const ALERT_META = {
  note: { label: 'Catatan', Icon: Info },
  tip: { label: 'Tips', Icon: Lightbulb },
  important: { label: 'Penting', Icon: MessageSquareWarning },
  warning: { label: 'Peringatan', Icon: AlertTriangle },
  caution: { label: 'Perhatian', Icon: OctagonAlert },
};

// Ekstrak teks polos secara rekursif (aman untuk anak <code> yang sudah di-highlight jadi banyak <span>)
function extractText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText(node.props?.children);
  return '';
}

function extractCodeMeta(children) {
  let lang = '';
  for (const child of Children.toArray(children)) {
    if (isValidElement(child)) {
      const cls = String(child.props?.className || '');
      const m = /(?:^|\s)language-([a-zA-Z0-9_+-]+)/.exec(cls);
      if (m) { lang = m[1].toLowerCase(); break; }
    }
  }
  const code = extractText(children).replace(/\n$/, '');
  return { lang, code };
}

function AlertBlockquote({ children, ...props }) {
  const kind = props['data-alert'];
  const meta = kind ? ALERT_META[kind] : null;
  if (!meta) return <blockquote>{children}</blockquote>;
  const { label, Icon } = meta;
  return (
    <div className={`md-alert md-alert-${kind}`} role="note">
      <div className="md-alert-title"><Icon size={15} /><span>{label}</span></div>
      <div className="md-alert-body">{children}</div>
    </div>
  );
}

// Link file:// (path lokal server) nggak bisa dibuka di HP -> tampilkan sebagai teks biasa
const baseMdComponents = {
  table: ({ children }) => (
    <InTableContext.Provider value={true}>
      <div className="md-table-wrap"><table>{children}</table></div>
    </InTableContext.Provider>
  ),
  blockquote: AlertBlockquote,
  p: ({ children }) => {
    const arr = Children.toArray(children).filter(c => !(typeof c === 'string' && !c.trim()));
    const allImages = arr.length >= 2 && arr.every(c => {
      if (!isValidElement(c)) return false;
      const isImgNode = c.type === 'img' || c.props?.node?.tagName === 'img';
      if (!isImgNode) return false;
      const src = String(c.props?.src || c.props?.node?.properties?.src || '');
      const local = resolveLocalFilename(src);
      return !(local && (VIDEO_RE.test(local) || AUDIO_RE.test(local) || PDF_RE.test(local)));
    });
    if (allImages) return <div className="md-image-grid">{arr}</div>;
    return <p>{children}</p>;
  },
};

function resolveLocalFilename(href) {
  if (!href || /^(https?:)?\/\//i.test(href)) return null;
  let filename = href.split(/[?#]/, 1)[0].replace(/\\/g, '/').split('/').pop() || '';
  try { filename = decodeURIComponent(filename); } catch {}
  if (!filename || filename.startsWith('.') || !/\.[a-z0-9]{1,12}$/i.test(filename)) return null;
  return filename;
}

function resolveImageSrc(src, chatId) {
  if (/^(https?:)?\/\//i.test(src) || /^blob:/i.test(src)
    || /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(src)) return src;
  if (/^\/api\/chats\//i.test(src)) return src;
  if (!chatId) return null;

  let filename = src.split(/[?#]/, 1)[0].replace(/\\/g, '/').split('/').pop() || '';
  try { filename = decodeURIComponent(filename); } catch {}
  if (!/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(filename) || filename === '.' || filename === '..') return null;
  return chatImageUrl(chatId, filename);
}

// Kumpulkan seluruh gambar di 1 pesan Markdown agar Lightbox mendukung navigasi galeri ◀ / ▶
function extractMarkdownImages(text, chatId) {
  const clean = String(text || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, '');
  const list = [];
  const seen = new Set();
  const re = /!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const alt = (m[1] || '').trim();
    const rawSrc = (m[2] || m[3] || '').trim();
    const url = resolveImageSrc(rawSrc, chatId);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const localName = resolveLocalFilename(rawSrc);
    list.push({
      name: alt || localName || 'Gambar',
      url,
      kind: 'image',
      downloadUrl: localName && chatId ? chatFileUrl(chatId, localName) : null,
    });
  }
  return list;
}

function safeMarkdownUrl(url) {
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const allowedScheme = /^(?:https?:|file:|blob:|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i.test(url);
  return hasScheme && !allowedScheme ? '' : url;
}

function ChatImage({ src, alt, chatId, gallery, onOpenMedia }) {
  const imageSrc = resolveImageSrc(src, chatId);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageSrc]);

  if (!imageSrc || failed) {
    return (
      <div className="md-image-fallback" role="img" aria-label={alt || 'Gambar tidak tersedia'}>
        <ImageOff size={20} />
        <span><strong>{alt || 'Gambar'}</strong><small>Gambar tidak dapat dimuat dari workspace chat.</small></span>
      </div>
    );
  }

  const open = () => {
    if (!onOpenMedia) return;
    const localName = resolveLocalFilename(src);
    if (Array.isArray(gallery) && gallery.length > 1) {
      const idx = gallery.findIndex(g => g.url === imageSrc);
      if (idx >= 0) {
        onOpenMedia({ items: gallery, index: idx });
        return;
      }
    }
    onOpenMedia({
      name: alt || localName || 'Gambar',
      url: imageSrc,
      kind: 'image',
      downloadUrl: localName && chatId ? chatFileUrl(chatId, localName) : null,
    });
  };

  return (
    <button type="button" className="md-image-btn" onClick={open} aria-label={`Lihat penuh ${alt || 'gambar'}`}>
      <img className="md-image" src={imageSrc} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </button>
  );
}

function ChatFileCard({ filename, chatId, onPreviewFile, onOpenMedia }) {
  const inTable = useContext(InTableContext);
  const extension = filename.split('.').pop()?.toUpperCase() || 'FILE';
  const isZip = extension === 'ZIP';
  const url = chatFileUrl(chatId, filename);
  const canPreviewTextOrPdf = isPreviewableFilename(filename) && !!onPreviewFile;
  const canPreviewImg = IMAGE_EXT_RE.test(filename) && !!onOpenMedia;
  const canPreview = canPreviewTextOrPdf || canPreviewImg;

  const openPreview = () => {
    if (canPreviewTextOrPdf) onPreviewFile({ chatId, filename });
    else if (canPreviewImg) {
      onOpenMedia({ name: filename, url: chatImageUrl(chatId, filename), kind: 'image', downloadUrl: url });
    }
  };

  // Di dalam tabel: chip 1 baris klik langsung buka pratinjau (atau unduh jika file biner)
  if (inTable && canPreview) {
    return (
      <button type="button" className="md-file-card" onClick={openPreview} aria-label={`Pratinjau ${filename}`}>
        <span className="md-file-card-icon"><File size={22} /></span>
        <span className="md-file-card-info"><strong>{filename}</strong><small>{extension}</small></span>
      </button>
    );
  }

  // Di luar tabel untuk file yang bisa dipratinjau: tap badan kartu = pratinjau penuh, ikon kanan = unduh
  if (canPreview) {
    return (
      <span className="md-file-card md-file-card-split">
        <button
          type="button"
          className="md-file-card-main"
          onClick={openPreview}
          aria-label={`Pratinjau ${filename}`}
        >
          <span className="md-file-card-icon"><File size={22} /></span>
          <span className="md-file-card-info">
            <strong>{filename}</strong>
            <small>{fileCategoryLabel(extension)}</small>
          </span>
        </button>
        <a
          className="md-file-card-action md-file-card-dl"
          href={url}
          download={filename}
          target="_blank"
          rel="noopener noreferrer"
          title="Unduh"
          aria-label={`Unduh ${filename}`}
        >
          <Download size={19} />
        </a>
      </span>
    );
  }

  return (
    <a
      className="md-file-card"
      href={url}
      download={filename}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Unduh ${filename}`}
    >
      <span className="md-file-card-icon">{isZip ? <Archive size={22} /> : <File size={22} />}</span>
      <span className="md-file-card-info"><strong>{filename}</strong><small>{extension}</small></span>
      <span className="md-file-card-action"><Download size={20} /></span>
    </a>
  );
}

function ChatVideoCard({ filename, chatId, onOpenMedia }) {
  const [failed, setFailed] = useState(false);
  const mediaUrl = chatMediaUrl(chatId, filename);
  const downloadUrl = chatFileUrl(chatId, filename);
  useEffect(() => setFailed(false), [mediaUrl]);

  if (failed) return <ChatFileCard filename={filename} chatId={chatId} />;

  return (
    <span className="md-media-card md-video-card">
      <video
        className="md-video"
        src={mediaUrl}
        controls
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
      />
      <span className="md-media-bar">
        <span className="md-media-name" title={filename}>
          <Film size={15} />
          <span>{filename}</span>
        </span>
        <span className="md-media-actions">
          {onOpenMedia && (
            <button
              type="button"
              className="md-media-btn"
              onClick={() => onOpenMedia({ name: filename, url: mediaUrl, kind: 'video', downloadUrl })}
              aria-label={`Layar penuh ${filename}`}
              title="Layar penuh"
            >
              <Maximize2 size={14} />
            </button>
          )}
          <a
            className="md-media-btn"
            href={downloadUrl}
            download={filename}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Unduh ${filename}`}
            title="Unduh"
          >
            <Download size={15} />
            <span>Unduh</span>
          </a>
        </span>
      </span>
    </span>
  );
}

function ChatAudioCard({ filename, chatId }) {
  const [failed, setFailed] = useState(false);
  const mediaUrl = chatMediaUrl(chatId, filename);
  const downloadUrl = chatFileUrl(chatId, filename);
  useEffect(() => setFailed(false), [mediaUrl]);

  if (failed) return <ChatFileCard filename={filename} chatId={chatId} />;

  return (
    <span className="md-media-card md-audio-card">
      <span className="md-media-bar">
        <span className="md-media-name" title={filename}>
          <Music size={15} />
          <span>{filename}</span>
        </span>
        <a
          className="md-media-btn"
          href={downloadUrl}
          download={filename}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Unduh ${filename}`}
          title="Unduh"
        >
          <Download size={15} />
          <span>Unduh</span>
        </a>
      </span>
      <audio
        className="md-audio"
        src={mediaUrl}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

// Tautan Markdown tanpa `!` ([file.ext](file.ext)): kartu file (tap = pratinjau langsung untuk file teks/kode/PDF, ikon kanan = unduh).
function MarkdownLink({ href = '', children, chatId, onPreviewFile, onOpenMedia }) {
  if (/^https?:\/\//i.test(href)) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  }
  const filename = resolveLocalFilename(href);
  if (!filename || !chatId) return <span className="md-filelink">{children}</span>;
  return <ChatFileCard filename={filename} chatId={chatId} onPreviewFile={onPreviewFile} onOpenMedia={onOpenMedia} />;
}

// Sintaks media dengan `!` (![Deskripsi](file.ext)): inisiatif AI menampilkan/memutar langsung di chat.
function MarkdownMedia({ src = '', alt = '', chatId, gallery, onOpenMedia, onPreviewFile }) {
  const inTable = useContext(InTableContext);
  const localName = resolveLocalFilename(src);
  if (localName && chatId) {
    if (VIDEO_RE.test(localName)) {
      return inTable
        ? <ChatFileCard filename={localName} chatId={chatId} onPreviewFile={onPreviewFile} onOpenMedia={onOpenMedia} />
        : <ChatVideoCard filename={localName} chatId={chatId} onOpenMedia={onOpenMedia} />;
    }
    if (AUDIO_RE.test(localName)) {
      return inTable
        ? <ChatFileCard filename={localName} chatId={chatId} onPreviewFile={onPreviewFile} onOpenMedia={onOpenMedia} />
        : <ChatAudioCard filename={localName} chatId={chatId} />;
    }
    if (PDF_RE.test(localName)) {
      return <ChatFileCard filename={localName} chatId={chatId} onPreviewFile={onPreviewFile} onOpenMedia={onOpenMedia} />;
    }
  }
  return <ChatImage src={src} alt={alt} chatId={chatId} gallery={gallery} onOpenMedia={onOpenMedia} />;
}

function CodeBlock({ children, lang = '', code = '' }) {
  const [status, setStatus] = useState('idle');
  const plainCode = code || extractText(children);

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(plainCode);
        } catch {
          // Gunakan fallback untuk browser yang menolak Clipboard API.
          const textarea = document.createElement('textarea');
          textarea.value = plainCode;
          textarea.setAttribute('readonly', '');
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          const copied = document.execCommand('copy');
          textarea.remove();
          if (!copied) throw new Error('Clipboard tidak tersedia');
        }
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = plainCode;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('Clipboard tidak tersedia');
      }
      setStatus('copied');
    } catch {
      setStatus('error');
    }
    window.setTimeout(() => setStatus('idle'), 1800);
  }

  return (
    <div className="md-code-wrap">
      <div className="md-code-toolbar">
        <span className="md-code-lang">{lang || ''}</span>
        <button type="button" className="md-code-copy" onClick={handleCopy} aria-label="Salin kode">
          {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          <span>{status === 'copied' ? 'Tersalin' : status === 'error' ? 'Gagal' : 'Salin'}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function Markdown({ text, chatId, streaming = false, onOpenMedia, onPreviewFile }) {
  const processed = useMemo(() => preprocessLatex(text), [text]);
  const gallery = useMemo(() => extractMarkdownImages(text, chatId), [text, chatId]);
  const components = useMemo(() => ({
    ...baseMdComponents,
    pre: ({ children }) => {
      const { lang, code } = extractCodeMeta(children);
      if (lang === 'mermaid') return <MermaidDiagram code={code} streaming={streaming} />;
      return <CodeBlock lang={lang} code={code}>{children}</CodeBlock>;
    },
    a: ({ href = '', children }) => (
      <MarkdownLink href={href} chatId={chatId} onPreviewFile={onPreviewFile} onOpenMedia={onOpenMedia}>{children}</MarkdownLink>
    ),
    img: ({ src = '', alt = '' }) => (
      <MarkdownMedia src={src} alt={alt} chatId={chatId} gallery={gallery} onOpenMedia={onOpenMedia} onPreviewFile={onPreviewFile} />
    ),
  }), [chatId, streaming, gallery, onOpenMedia, onPreviewFile]);
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
      urlTransform={safeMarkdownUrl}
    >
      {processed}
    </ReactMarkdown>
  );
}

// Lampiran pesan terkirim: gambar → thumbnail (tap = lightbox), video → kartu play (tap = putar di lightbox),
// file teks/kode/PDF → tap buka pratinjau, selain itu → kartu file.
function SentAttachments({ items, chatId, onOpenImage, onPreviewFile }) {
  const [broken, setBroken] = useState(() => new Set());
  const gallery = useMemo(() => {
    const out = [];
    items.forEach((f, j) => {
      if (!f.stored || !chatId) return;
      if (f.type?.startsWith('image/') && !broken.has(j)) {
        out.push({
          idx: j,
          name: f.name,
          url: chatImageUrl(chatId, f.stored),
          kind: 'image',
          downloadUrl: chatFileUrl(chatId, f.stored),
        });
      } else if (f.type?.startsWith('video/') || VIDEO_RE.test(f.name || '')) {
        out.push({
          idx: j,
          name: f.name,
          url: chatMediaUrl(chatId, f.stored),
          kind: 'video',
          downloadUrl: chatFileUrl(chatId, f.stored),
        });
      }
    });
    return out;
  }, [items, chatId, broken]);

  const openAt = (j, fallbackItem) => {
    const gIdx = gallery.findIndex(g => g.idx === j);
    if (gIdx >= 0 && gallery.length > 1) {
      onOpenImage({ items: gallery, index: gIdx });
    } else if (gIdx >= 0) {
      onOpenImage(gallery[gIdx]);
    } else if (fallbackItem) {
      onOpenImage(fallbackItem);
    }
  };

  return (
    <div className="att-tray att-tray-sent">
      {items.map((f, j) => {
        const imgSrc = f.stored && f.type?.startsWith('image/') && !broken.has(j) ? chatImageUrl(chatId, f.stored) : null;
        if (imgSrc) {
          return (
            <ImageThumb key={keyOf(f)} f={f} src={imgSrc} className="att-thumb-sent"
              onOpen={() => openAt(j, { name: f.name, url: imgSrc, kind: 'image', downloadUrl: chatFileUrl(chatId, f.stored) })}
              onBroken={() => setBroken(s => new Set(s).add(j))} />
          );
        }
        const isVideo = !!f.stored && !!chatId && (f.type?.startsWith('video/') || VIDEO_RE.test(f.name || ''));
        if (isVideo) {
          return (
            <FileCard
              key={keyOf(f)}
              f={f}
              playable
              onOpen={() => openAt(j, { name: f.name, url: chatMediaUrl(chatId, f.stored), kind: 'video', downloadUrl: chatFileUrl(chatId, f.stored) })}
            />
          );
        }
        const canPreview = !!f.stored && !!chatId && !!onPreviewFile && isPreviewableFilename(f.name || f.stored);
        if (canPreview) {
          return (
            <FileCard
              key={keyOf(f)}
              f={f}
              onOpen={() => onPreviewFile({ chatId, filename: f.stored, displayName: f.name })}
            />
          );
        }
        return <FileCard key={keyOf(f)} f={f} />;
      })}
    </div>
  );
}

function UserBubbleText({ text }) {
  const segs = useMemo(() => splitTextWithLinks(text), [text]);
  if (!segs.some(s => s.type === 'link')) return text;
  return segs.map((seg, i) => (
    seg.type === 'link'
      ? <a key={i} className="user-link" href={seg.href} target="_blank" rel="noopener noreferrer">{seg.text}</a>
      : seg.value
  ));
}

// Satu pesan. Di-memo: saat streaming hanya pesan terakhir (objeknya berubah) yang dirender ulang,
// pesan lama tidak di-parse ulang oleh react-markdown.
const MessageItem = memo(function MessageItem({ m, chatId, hasPendingQuestion, onOpenQuestion, onOpenImage, onPreviewFile }) {
  return (
    <div className={'msg ' + (m.role === 'user' ? 'msg-user' : 'msg-ai')}>
      {m.attachments?.length > 0 && (
        <SentAttachments items={m.attachments} chatId={chatId} onOpenImage={onOpenImage} onPreviewFile={onPreviewFile} />
      )}
      {m.role === 'assistant' && (m.steps || m.streaming) && (
        <ThinkingProcess msg={m} hasPendingQuestion={hasPendingQuestion} onOpenQuestion={onOpenQuestion} />
      )}
      {(m.content || m.role === 'user') && (
        m.role === 'user'
          ? <div className="bubble"><UserBubbleText text={m.content} /></div>
          : <div className="bubble md"><Markdown text={m.content} chatId={chatId} streaming={!!m.streaming} onOpenMedia={onOpenImage} onPreviewFile={onPreviewFile} />{m.streaming && m.content ? <span className="caret" /> : null}</div>
      )}
    </div>
  );
});

const NEAR_BOTTOM_PX = 80;

export default function ChatView({ messages, chatId, hasPendingQuestion, onOpenQuestion }) {
  const boxRef = useRef(null);
  const viewRef = useRef(null);
  const stickRef = useRef(true);     // auto-scroll hanya kalau user memang di (dekat) bawah
  const prevLenRef = useRef(messages.length);
  const [atBottom, setAtBottom] = useState(true);
  const [lightbox, setLightbox] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const closePreviewFile = useCallback(() => setPreviewFile(null), []);

  useEffect(() => {
    const box = boxRef.current;
    const view = viewRef.current;
    if (!box) return;
    const checkNear = () => box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
    const onScroll = () => {
      const near = checkNear();
      stickRef.current = near;
      setAtBottom(near);
    };
    const onResize = () => {
      if (stickRef.current) {
        box.scrollTop = box.scrollHeight;
        setAtBottom(true);
        return;
      }
      const near = checkNear();
      if (near) stickRef.current = true;
      setAtBottom(near);
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(box);
      if (view) ro.observe(view);
    }
    return () => {
      box.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, []);

  // Pindah chat → selalu mulai dari bawah
  useLayoutEffect(() => {
    const box = boxRef.current;
    stickRef.current = true;
    setAtBottom(true);
    setLightbox(null);
    setPreviewFile(null);
    if (box) box.scrollTop = box.scrollHeight;
  }, [chatId]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    // pesan baru dari user → paksa ikut ke bawah
    const added = messages.slice(prevLenRef.current);
    prevLenRef.current = messages.length;
    if (added.some(m => m.role === 'user')) stickRef.current = true;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight; // instan (tanpa smooth) supaya tidak patah-patah
    if (box) setAtBottom(box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX);
    if (window.scrollY) window.scrollTo(0, 0);
  }, [messages]);

  const scrollToBottom = () => {
    const box = boxRef.current;
    if (!box) return;
    stickRef.current = true;
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="chat-shell">
      <div className="chat-scroll" ref={boxRef}>
        <div className="chat-view" ref={viewRef}>
          {messages.map((m, i) => (
            <MessageItem
              key={m.id ?? i}
              m={m}
              chatId={chatId}
              hasPendingQuestion={hasPendingQuestion && i === messages.length - 1}
              onOpenQuestion={onOpenQuestion}
              onOpenImage={setLightbox}
              onPreviewFile={setPreviewFile}
            />
          ))}
        </div>
      </div>
      {!atBottom && (
        <div className="scroll-bottom-wrap">
          <button type="button" className="scroll-bottom" onClick={scrollToBottom} aria-label="Ke pesan terbaru">
            <ArrowDown size={18} />
          </button>
        </div>
      )}
      <ImageLightbox
        item={lightbox}
        onClose={closeLightbox}
        onNavigate={(nextIdx) => setLightbox(prev => (prev?.items ? { ...prev, index: nextIdx } : prev))}
      />
      <FilePreviewModal file={previewFile} onClose={closePreviewFile} />
    </div>
  );
}
