import { useEffect, useId, useState } from 'react';
import { Check, Code2, Copy, Eye, Loader, AlertTriangle } from 'lucide-react';

let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default || m);
  }
  return mermaidPromise;
}

function getIsDark() {
  if (typeof document === 'undefined') return false;
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
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

export default function MermaidDiagram({ code, streaming = false }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [dark, setDark] = useState(getIsDark);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [copyState, setCopyState] = useState('idle');

  // Ikuti perubahan tema terang/gelap secara real-time
  useEffect(() => {
    const update = () => setDark(getIsDark());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', update);
    return () => {
      mo.disconnect();
      mq?.removeEventListener?.('change', update);
    };
  }, []);

  // Render diagram setelah streaming selesai (lazy-load modul mermaid)
  useEffect(() => {
    const src = String(code || '').trim();
    if (!src || streaming) return;
    let cancelled = false;
    setRendering(true);
    setError('');

    const renderId = `mmd-${reactId}-${Date.now().toString(36)}`;
    loadMermaid()
      .then(async (mermaid) => {
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        });
        const res = await mermaid.render(renderId, src);
        if (!cancelled) {
          setSvg(res?.svg || '');
          setError('');
        }
      })
      .catch((err) => {
        // Bersihkan elemen error sementara yang kadang disisipkan mermaid ke body
        try { document.getElementById(`d${renderId}`)?.remove(); } catch {}
        try { document.getElementById(renderId)?.remove(); } catch {}
        if (!cancelled) {
          setSvg('');
          setError(err?.message || 'Sintaks diagram tidak valid');
        }
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });

    return () => { cancelled = true; };
  }, [code, dark, streaming, reactId]);

  const handleCopy = async () => {
    try {
      const ok = await copyPlainText(code);
      setCopyState(ok ? 'copied' : 'error');
    } catch {
      setCopyState('error');
    }
    window.setTimeout(() => setCopyState('idle'), 1800);
  };

  return (
    <div className="md-code-wrap md-mermaid-wrap">
      <div className="md-code-toolbar">
        <span className="md-code-lang">mermaid</span>
        <div className="md-code-actions">
          {!streaming && !error && (
            <button
              type="button"
              className="md-code-copy"
              onClick={() => setShowCode(v => !v)}
              aria-label={showCode ? 'Tampilkan diagram' : 'Lihat kode mermaid'}
            >
              {showCode ? <Eye size={14} /> : <Code2 size={14} />}
              <span>{showCode ? 'Diagram' : 'Kode'}</span>
            </button>
          )}
          <button type="button" className="md-code-copy" onClick={handleCopy} aria-label="Salin kode mermaid">
            {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
            <span>{copyState === 'copied' ? 'Tersalin' : copyState === 'error' ? 'Gagal' : 'Salin'}</span>
          </button>
        </div>
      </div>

      {streaming ? (
        <div className="md-mermaid-status">
          <Loader size={15} className="spin" />
          <span>Menyiapkan diagram Mermaid…</span>
        </div>
      ) : showCode ? (
        <pre><code>{code}</code></pre>
      ) : rendering && !svg ? (
        <div className="md-mermaid-status">
          <Loader size={15} className="spin" />
          <span>Merender diagram…</span>
        </div>
      ) : error ? (
        <div className="md-mermaid-fallback">
          <div className="md-mermaid-err">
            <AlertTriangle size={14} />
            <span>Gagal merender diagram — menampilkan kode</span>
          </div>
          <pre><code>{code}</code></pre>
        </div>
      ) : (
        <div className="md-mermaid-stage" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </div>
  );
}
