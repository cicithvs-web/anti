import { Children, isValidElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowDown, Check, Copy, Download, File, ImageOff,
  Info, Lightbulb, MessageSquareWarning, AlertTriangle, OctagonAlert,
} from 'lucide-react';
import ThinkingProcess from './ThinkingProcess';
import MermaidDiagram from './MermaidDiagram';
import ReactMarkdown from 'react-markdown';
import 'katex/dist/katex.min.css';
import { preprocessLatex, REMARK_PLUGINS, REHYPE_PLUGINS } from '../utils/markdownPlugins';
import { chatFileUrl, chatImageUrl } from '../services/ai';
import { FileCard, ImageThumb, keyOf } from './AttachmentTray.jsx';
import ImageLightbox from './ImageLightbox.jsx';

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
  table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div>,
  blockquote: AlertBlockquote,
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
  if (!/\.(?:png|jpe?g|gif|webp|avif)$/i.test(filename) || filename === '.' || filename === '..') return null;
  return chatImageUrl(chatId, filename);
}

function safeMarkdownUrl(url) {
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const allowedScheme = /^(?:https?:|file:|blob:|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i.test(url);
  return hasScheme && !allowedScheme ? '' : url;
}

function ChatImage({ src, alt, chatId }) {
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
  return <img className="md-image" src={imageSrc} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function ChatFileCard({ filename, chatId }) {
  const extension = filename.split('.').pop()?.toUpperCase() || 'FILE';
  const isZip = extension === 'ZIP';
  const url = chatFileUrl(chatId, filename);
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

function Markdown({ text, chatId, streaming = false }) {
  const processed = useMemo(() => preprocessLatex(text), [text]);
  const components = useMemo(() => ({
    ...baseMdComponents,
    pre: ({ children }) => {
      const { lang, code } = extractCodeMeta(children);
      if (lang === 'mermaid') return <MermaidDiagram code={code} streaming={streaming} />;
      return <CodeBlock lang={lang} code={code}>{children}</CodeBlock>;
    },
    a: ({ href = '', children }) => {
      if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      const filename = resolveLocalFilename(href);
      return filename && chatId
        ? <ChatFileCard filename={filename} chatId={chatId} />
        : <span className="md-filelink">{children}</span>;
    },
    img: ({ src = '', alt = '' }) => <ChatImage src={src} alt={alt} chatId={chatId} />,
  }), [chatId, streaming]);
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

// Lampiran pesan terkirim: gambar yang tersimpan di server → thumbnail (tap = lightbox),
// selain itu (atau gambar lama tanpa info lokasi / file sudah terhapus) → kartu file.
function SentAttachments({ items, chatId, onOpenImage }) {
  const [broken, setBroken] = useState(() => new Set());
  return (
    <div className="att-tray att-tray-sent">
      {items.map((f, j) => {
        const src = f.stored && f.type?.startsWith('image/') && !broken.has(j) ? chatImageUrl(chatId, f.stored) : null;
        return src
          ? <ImageThumb key={keyOf(f)} f={f} src={src} className="att-thumb-sent"
              onOpen={() => onOpenImage({ name: f.name, url: src })}
              onBroken={() => setBroken(s => new Set(s).add(j))} />
          : <FileCard key={keyOf(f)} f={f} />;
      })}
    </div>
  );
}

// Satu pesan. Di-memo: saat streaming hanya pesan terakhir (objeknya berubah) yang dirender ulang,
// pesan lama tidak di-parse ulang oleh react-markdown.
const MessageItem = memo(function MessageItem({ m, chatId, hasPendingQuestion, onOpenQuestion, onOpenImage }) {
  return (
    <div className={'msg ' + (m.role === 'user' ? 'msg-user' : 'msg-ai')}>
      {m.attachments?.length > 0 && (
        <SentAttachments items={m.attachments} chatId={chatId} onOpenImage={onOpenImage} />
      )}
      {m.role === 'assistant' && (m.steps || m.streaming) && (
        <ThinkingProcess msg={m} hasPendingQuestion={hasPendingQuestion} onOpenQuestion={onOpenQuestion} />
      )}
      {(m.content || m.role === 'user') && (
        m.role === 'user'
          ? <div className="bubble">{m.content}</div>
          : <div className="bubble md"><Markdown text={m.content} chatId={chatId} streaming={!!m.streaming} />{m.streaming && m.content ? <span className="caret" /> : null}</div>
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
  const closeLightbox = useCallback(() => setLightbox(null), []);

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
      <ImageLightbox item={lightbox} onClose={closeLightbox} />
    </div>
  );
}
