import { Children, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Check, Clock, Copy, ChevronRight, Download, File, ImageOff } from 'lucide-react';
import ProcessSheet, { fmtDur } from './ProcessSheet';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { chatFileUrl, chatImageUrl } from '../services/ai';

// Link file:// (path lokal server) nggak bisa dibuka di HP -> tampilkan sebagai teks biasa
const mdComponents = {
  table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
  return (
    <a className="md-file-card" href={chatFileUrl(chatId, filename)} download={filename} aria-label={`Unduh ${filename}`}>
      <span className="md-file-card-icon">{isZip ? <Archive size={22} /> : <File size={22} />}</span>
      <span className="md-file-card-info"><strong>{filename}</strong><small>{extension}</small></span>
      <span className="md-file-card-action"><Download size={20} /></span>
    </a>
  );
}

function CodeBlock({ children }) {
  const [status, setStatus] = useState('idle');
  const code = Children.toArray(children).map(child => {
    if (typeof child === 'string') return child;
    return typeof child?.props?.children === 'string' ? child.props.children : '';
  }).join('');

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(code);
        } catch {
          // Gunakan fallback untuk browser yang menolak Clipboard API.
          const textarea = document.createElement('textarea');
          textarea.value = code;
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
        textarea.value = code;
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
        <button type="button" className="md-code-copy" onClick={handleCopy} aria-label="Salin kode">
          {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          <span>{status === 'copied' ? 'Tersalin' : status === 'error' ? 'Gagal' : 'Salin'}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function Markdown({ text, chatId }) {
  const components = useMemo(() => ({
    ...mdComponents,
    a: ({ href = '', children }) => {
      if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      const filename = resolveLocalFilename(href);
      return filename && chatId
        ? <ChatFileCard filename={filename} chatId={chatId} />
        : <span className="md-filelink">{children}</span>;
    },
    img: ({ src = '', alt = '' }) => <ChatImage src={src} alt={alt} chatId={chatId} />,
  }), [chatId]);
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeMarkdownUrl}>{text}</ReactMarkdown>;
}

// Baris ringkas di atas jawaban AI: "🕒 <status/langkah terakhir> >" — tap untuk buka Ringkasan
function ProcessRow({ m, onOpen }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!m.streaming) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [m.streaming]);

  const tools = (m.steps || []).filter(s => s.kind !== 'think');
  let label;
  if (m.streaming) {
    const secs = m.startedAt ? Math.round((now - m.startedAt) / 1000) : 0;
    label = `${m.status || 'Berpikir…'} ${secs ? '· ' + secs + ' dtk' : ''}`;
  } else {
    const last = tools[tools.length - 1];
    label = last ? `${last.label}${tools.length > 1 ? ` (+${tools.length - 1} langkah)` : ''}`
      : `Berpikir${m.durationSec != null ? ' selama ' + fmtDur(m.durationSec) : ''}`;
  }
  return (
    <button className={'proc-row' + (m.streaming ? ' live' : '')} onClick={onOpen}>
      <Clock size={16} className={m.streaming ? 'spin-slow' : ''} />
      <span className={'proc-row-text' + (m.streaming ? ' shimmer' : '')}>{label}</span>
      <ChevronRight size={16} />
    </button>
  );
}

export default function ChatView({ messages, chatId }) {
  const endRef = useRef(null);
  const [openIdx, setOpenIdx] = useState(null);

  useEffect(() => {
    // Scroll HANYA container chat (bukan seluruh halaman)
    const box = endRef.current?.closest('.content');
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    if (window.scrollY) window.scrollTo(0, 0);
  }, [messages]);

  return (
    <div className="chat-view">
      {messages.map((m, i) => (
        <div key={i} className={'msg ' + (m.role === 'user' ? 'msg-user' : 'msg-ai')}>
          {m.attachments?.length > 0 && (
            <div className="attach-row">
              {m.attachments.map((f, j) => <span key={j} className="chip">{f.name}</span>)}
            </div>
          )}
          {m.role === 'assistant' && m.steps && <ProcessRow m={m} onOpen={() => setOpenIdx(i)} />}
          {(m.content || m.role === 'user') && (
            m.role === 'user'
              ? <div className="bubble">{m.content}</div>
              : <div className="bubble md"><Markdown text={m.content} chatId={chatId} />{m.streaming && m.content ? <span className="caret" /> : null}</div>
          )}
        </div>
      ))}
      <div ref={endRef} />
      <ProcessSheet open={openIdx != null} msg={openIdx != null ? messages[openIdx] : null} onClose={() => setOpenIdx(null)} />
    </div>
  );
}
