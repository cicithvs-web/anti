import { Children, isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, MoreVertical, Copy, Check, Download, Code2, Eye, Loader, AlertTriangle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { common, createLowlight } from 'lowlight';
import RippleButton from './RippleButton.jsx';
import MermaidDiagram from './MermaidDiagram.jsx';
import { preprocessLatex, REMARK_PLUGINS, REHYPE_PLUGINS } from '../utils/markdownPlugins';
import { chatFileUrl, chatMediaUrl, getChatFilePreview } from '../services/ai';

const lowlight = createLowlight(common);

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', jsonl: 'json', ndjson: 'json',
  md: 'markdown', markdown: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
  ini: 'ini', toml: 'ini', conf: 'ini', cfg: 'ini', env: 'ini',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', lua: 'lua', swift: 'swift', r: 'r',
  graphql: 'graphql',
};

const PDF_EXT_RE = /\.pdf$/i;
const MD_EXT_RE = /\.(?:md|markdown)$/i;
const CSV_EXT_RE = /\.(?:csv|tsv)$/i;

function useBackToClose(open, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const marker = `fprev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    history.pushState({ ...(history.state || {}), overlay: marker }, '');
    let popped = false;
    const onPop = () => { popped = true; closeRef.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!popped && history.state?.overlay === marker) history.back();
    };
  }, [open]);
}

async function copyPlainText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

// Konversi tree HAST dari lowlight menjadi elemen React secara aman (zero dangerouslySetInnerHTML)
function hastToReact(node, key = 0) {
  if (!node) return null;
  if (node.type === 'text') return node.value;
  if (node.type === 'root') {
    return (node.children || []).map((c, i) => hastToReact(c, i));
  }
  if (node.type === 'element') {
    const cls = Array.isArray(node.properties?.className)
      ? node.properties.className.join(' ')
      : (node.properties?.className || undefined);
    const Tag = node.tagName || 'span';
    return (
      <Tag key={key} className={cls}>
        {(node.children || []).map((c, i) => hastToReact(c, i))}
      </Tag>
    );
  }
  return null;
}

function parseDelimited(text, delimiter = ',', maxRows = 500) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"' && !field) {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
      if (rows.length >= maxRows + 1) break;
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.some(cell => cell !== '')) rows.push(row);
  }
  const hasMore = rows.length > maxRows;
  return { rows: hasMore ? rows.slice(0, maxRows) : rows, hasMore };
}

function extractText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText(node.props?.children);
  return '';
}

function PreviewCodeBlock({ children }) {
  const [copied, setCopied] = useState(false);
  let lang = '';
  for (const child of Children.toArray(children)) {
    if (isValidElement(child)) {
      const m = /(?:^|\s)language-([a-zA-Z0-9_+-]+)/.exec(String(child.props?.className || ''));
      if (m) { lang = m[1].toLowerCase(); break; }
    }
  }
  const plain = extractText(children).replace(/\n$/, '');
  if (lang === 'mermaid') return <MermaidDiagram code={plain} />;

  const doCopy = async () => {
    try {
      if (await copyPlainText(plain)) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }
    } catch {}
  };
  return (
    <div className="md-code-wrap">
      <div className="md-code-toolbar">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className="md-code-copy" onClick={doCopy} aria-label="Salin kode">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? 'Tersalin' : 'Salin'}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const previewMdComponents = {
  table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div>,
  pre: ({ children }) => <PreviewCodeBlock>{children}</PreviewCodeBlock>,
  a: ({ href = '', children }) => (
    /^https?:\/\//i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span className="md-filelink">{children}</span>
  ),
};

// ---------- PDF Viewer berbasis pdfjs-dist (lazy-loaded, aman di Android WebView / APK) ----------
let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((mod) => {
      const lib = mod.default || mod;
      try {
        lib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      } catch {}
      return lib;
    });
  }
  return pdfjsPromise;
}

const MAX_INITIAL_PDF_PAGES = 25;

function PdfPageCanvas({ pdf, pageNumber, targetWidth }) {
  const canvasRef = useRef(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let renderTask = null;
    (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const cssScale = Math.max(0.5, targetWidth / baseViewport.width);
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const viewport = page.getViewport({ scale: cssScale * dpr });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(baseViewport.width * cssScale)}px`;
        canvas.style.height = `${Math.floor(baseViewport.height * cssScale)}px`;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;
        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
        if (!cancelled) setRendered(true);
      } catch {}
    })();
    return () => {
      cancelled = true;
      try { renderTask?.cancel(); } catch {}
    };
  }, [pdf, pageNumber, targetWidth]);

  return (
    <div className="fprev-pdf-page-wrap">
      <div className={'fprev-pdf-page' + (rendered ? ' ready' : '')}>
        <canvas ref={canvasRef} />
      </div>
      <div className="fprev-pdf-page-num">Halaman {pageNumber}</div>
    </div>
  );
}

function PdfViewer({ url, downloadUrl, filename }) {
  const wrapRef = useRef(null);
  const [pdf, setPdf] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [visiblePages, setVisiblePages] = useState(MAX_INITIAL_PDF_PAGES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(() => Math.min(Math.max((window.innerWidth || 380) - 32, 260), 780));

  useEffect(() => {
    const updateW = () => {
      const el = wrapRef.current;
      const w = el ? el.clientWidth - 28 : (window.innerWidth || 380) - 32;
      setWidth(Math.min(Math.max(w, 260), 780));
    };
    updateW();
    window.addEventListener('resize', updateW);
    return () => window.removeEventListener('resize', updateW);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let doc = null;
    const ac = new AbortController();
    setLoading(true);
    setError('');
    setPdf(null);
    setNumPages(0);
    setVisiblePages(MAX_INITIAL_PDF_PAGES);

    (async () => {
      try {
        const res = await fetch(url, { credentials: 'include', signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const pdfjsLib = await loadPdfJs();
        if (cancelled) return;
        const task = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
        doc = await task.promise;
        if (cancelled) { doc.destroy(); return; }
        setPdf(doc);
        setNumPages(doc.numPages || 0);
      } catch (e) {
        if (!cancelled && e?.name !== 'AbortError') {
          setError(e?.message || 'Gagal memuat dokumen PDF.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      try { doc?.destroy(); } catch {}
    };
  }, [url]);

  const count = Math.min(numPages, visiblePages);

  return (
    <div className="fprev-pdf-stage" ref={wrapRef}>
      {loading && (
        <div className="fprev-state">
          <Loader size={20} className="spin" />
          <span>Memuat dokumen PDF…</span>
        </div>
      )}
      {!loading && error && (
        <div className="fprev-state fprev-error">
          <AlertTriangle size={20} />
          <span>{error}</span>
          <a className="fprev-retry-btn" href={downloadUrl} download={filename} target="_blank" rel="noopener noreferrer">
            <Download size={15} /> Unduh PDF
          </a>
        </div>
      )}
      {!loading && !error && pdf && (
        <>
          {Array.from({ length: count }, (_, i) => (
            <PdfPageCanvas key={i + 1} pdf={pdf} pageNumber={i + 1} targetWidth={width} />
          ))}
          {numPages > count && (
            <button
              type="button"
              className="fprev-more-btn"
              onClick={() => setVisiblePages(v => v + 25)}
            >
              Muat halaman berikutnya ({count}/{numPages})
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ---------- Komponen utama Modal Pratinjau File (gaya Claude APK) ----------
export default function FilePreviewModal({ file, onClose }) {
  const open = !!file;
  const chatId = file?.chatId || '';
  const filename = file?.filename || '';
  const displayName = file?.displayName || filename.split('/').pop() || filename;
  const isPdf = PDF_EXT_RE.test(displayName);
  const isMd = MD_EXT_RE.test(displayName);
  const isCsv = CSV_EXT_RE.test(displayName);
  const ext = (displayName.split('.').pop() || '').toLowerCase();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [content, setContent] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');

  useBackToClose(open, onClose);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (menuOpen) setMenuOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, menuOpen, onClose]);

  useEffect(() => {
    setRawMode(false);
    setMenuOpen(false);
    setToast('');
    setError('');
    setContent(null);
    setTruncated(false);
    if (!open || isPdf || !chatId || !filename) { setLoading(false); return; }

    let cancelled = false;
    setLoading(true);
    getChatFilePreview(chatId, filename)
      .then((r) => {
        if (cancelled) return;
        if (r?.ok) {
          setContent(r.content ?? '');
          setTruncated(!!r.truncated);
        } else {
          setError(r?.error || 'Gagal memuat isi file.');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e?.body?.error || e?.message || 'Gagal memuat isi file.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, isPdf, chatId, filename]);

  const highlighted = useMemo(() => {
    if (content == null || isPdf) return null;
    if ((isMd || isCsv) && !rawMode) return null;
    const lang = EXT_TO_LANG[ext];
    if (!lang || !lowlight.registered(lang)) return null;
    try {
      return hastToReact(lowlight.highlight(lang, content));
    } catch {
      return null;
    }
  }, [content, isPdf, isMd, isCsv, rawMode, ext]);

  const parsedCsv = useMemo(() => {
    if (!isCsv || rawMode || content == null) return null;
    return parseDelimited(content, ext === 'tsv' ? '\t' : ',');
  }, [isCsv, rawMode, content, ext]);

  const processedMd = useMemo(() => {
    if (!isMd || rawMode || content == null) return '';
    return preprocessLatex(content);
  }, [isMd, rawMode, content]);

  if (!open) return null;

  const downloadUrl = chatFileUrl(chatId, filename);
  const mediaUrl = chatMediaUrl(chatId, filename);
  const canCopy = !isPdf && content != null;
  const canToggleRaw = (isMd || isCsv) && content != null;

  const showToast = (msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(cur => (cur === msg ? '' : cur)), 1800);
  };

  const handleCopy = async () => {
    setMenuOpen(false);
    if (content == null) return;
    try {
      const ok = await copyPlainText(content);
      showToast(ok ? 'Isi file tersalin' : 'Gagal menyalin');
    } catch {
      showToast('Gagal menyalin');
    }
  };

  return createPortal(
    <div className="fprev-overlay" role="dialog" aria-modal="true" aria-label={displayName}>
      <header className="fprev-header">
        <RippleButton className="icon-btn" onClick={onClose} aria-label="Tutup">
          <X size={22} />
        </RippleButton>
        <span className="fprev-title" title={displayName}>{displayName}</span>
        <div className="fprev-menu-wrap">
          <RippleButton
            className="icon-btn"
            onClick={() => setMenuOpen(v => !v)}
            aria-label="Menu lainnya"
            aria-expanded={menuOpen}
          >
            <MoreVertical size={20} />
          </RippleButton>
          {menuOpen && (
            <>
              <div className="fprev-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="fprev-menu" role="menu">
                {canCopy && (
                  <button type="button" className="fprev-menu-item" role="menuitem" onClick={handleCopy}>
                    <Copy size={16} />
                    <span>Salin</span>
                  </button>
                )}
                {canToggleRaw && (
                  <button
                    type="button"
                    className="fprev-menu-item"
                    role="menuitem"
                    onClick={() => { setRawMode(v => !v); setMenuOpen(false); }}
                  >
                    {rawMode ? <Eye size={16} /> : <Code2 size={16} />}
                    <span>{rawMode ? 'Tampilan pratinjau' : 'Lihat kode mentah'}</span>
                  </button>
                )}
                <a
                  className="fprev-menu-item"
                  role="menuitem"
                  href={downloadUrl}
                  download={displayName}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMenuOpen(false)}
                >
                  <Download size={16} />
                  <span>Unduh</span>
                </a>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="fprev-body">
        {isPdf ? (
          <PdfViewer url={mediaUrl} downloadUrl={downloadUrl} filename={displayName} />
        ) : loading ? (
          <div className="fprev-state">
            <Loader size={20} className="spin" />
            <span>Memuat isi file…</span>
          </div>
        ) : error ? (
          <div className="fprev-state fprev-error">
            <AlertTriangle size={20} />
            <span>{error}</span>
            <a className="fprev-retry-btn" href={downloadUrl} download={displayName} target="_blank" rel="noopener noreferrer">
              <Download size={15} /> Unduh file
            </a>
          </div>
        ) : isMd && !rawMode ? (
          <div className="fprev-md md">
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={REHYPE_PLUGINS}
              components={previewMdComponents}
            >
              {processedMd}
            </ReactMarkdown>
          </div>
        ) : isCsv && !rawMode && parsedCsv ? (
          <div className="fprev-csv md">
            {parsedCsv.rows.length > 0 ? (
              <div className="md-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {parsedCsv.rows[0].map((cell, j) => <th key={j}>{cell}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {parsedCsv.rows.slice(1).map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => <td key={j}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="fprev-state">File kosong.</div>}
            {parsedCsv.hasMore && (
              <div className="fprev-note">Menampilkan 500 baris pertama — unduh untuk melihat seluruh tabel.</div>
            )}
          </div>
        ) : highlighted ? (
          <pre className="fprev-code"><code className="hljs">{highlighted}</code></pre>
        ) : (
          <pre className="fprev-plain"><code>{content}</code></pre>
        )}

        {truncated && (
          <div className="fprev-note">
            Menampilkan 1 MB pertama — unduh file untuk melihat seluruh isinya.
          </div>
        )}
      </div>

      {isPdf && (
        <div className="fprev-fab-wrap">
          <a className="fprev-fab" href={downloadUrl} download={displayName} target="_blank" rel="noopener noreferrer">
            <Download size={16} />
            <span>Unduh</span>
          </a>
        </div>
      )}

      {toast && (
        <div className="fprev-toast" role="status">
          <Check size={14} />
          <span>{toast}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
