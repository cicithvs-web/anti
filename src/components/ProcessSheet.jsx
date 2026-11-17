import { useState, useEffect } from 'react';
import { X, Terminal, FileText, FilePen, Globe, Wrench, Sparkles, Loader, CircleCheck } from 'lucide-react';

const ICON = { terminal: Terminal, read: FileText, edit: FilePen, web: Globe, tool: Wrench };
export const fmtDur = (s) => (s == null ? '' : s < 60 ? `${Math.round(s)} dtk` : `${Math.floor(s / 60)} mnt ${Math.round(s % 60)} dtk`);

// Pop-up "Ringkasan" — timeline proses agy (mirip Claude)
export default function ProcessSheet({ open, onClose, msg }) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    if (open) {
      setMounted(true); setExpanded(null);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted || !msg) return null;
  const steps = msg.steps || [];

  return (
    <>
      <div className={'settings-overlay' + (visible ? ' open' : '')} onClick={onClose} />
      <div className={'settings-sheet' + (visible ? ' open' : '')}>
        <div className="settings-page">
          <div className="settings-handle" />
          <div className="settings-head">
            <button className="icon-btn" onClick={onClose} aria-label="Tutup"><X size={22} /></button>
            <span className="settings-title">Ringkasan</span>
            <span style={{ width: 36 }} />
          </div>

          <div className="proc-list">
            {steps.length === 0 && (
              <div className="proc-item">
                <span className="proc-dot" />
                <div className="proc-thought">{msg.streaming ? 'Sedang berpikir…' : 'Langsung menjawab tanpa langkah tambahan.'}</div>
              </div>
            )}
            {steps.map((s) => {
              if (s.kind === 'think') {
                return (
                  <div key={s.id} className="proc-item">
                    <span className="proc-dot" />
                    <div className="proc-thought">
                      Berpikir{s.duration != null ? ` selama ${fmtDur(s.duration)}` : ''}
                      {s.thinkingTokens ? <span className="proc-meta"> · {s.thinkingTokens} token</span> : null}
                    </div>
                  </div>
                );
              }
              const Ico = ICON[s.kind] || Wrench;
              const isOpen = expanded === s.id;
              return (
                <div key={s.id} className="proc-item">
                  <span className="proc-icon">
                    {s.status === 'running' ? <Loader size={15} className="spin" /> : <Ico size={15} />}
                  </span>
                  <div className="proc-body">
                    <button className="proc-label" onClick={() => setExpanded(isOpen ? null : s.id)} disabled={!s.output}>
                      {s.label}
                    </button>
                    <div className="proc-meta">
                      {s.status === 'running' ? 'berjalan…' : fmtDur(s.duration)}
                    </div>
                    {isOpen && s.output && <pre className="proc-output">{s.output}</pre>}
                  </div>
                </div>
              );
            })}
            {!msg.streaming && (
              <div className="proc-item">
                <span className="proc-icon done"><CircleCheck size={15} /></span>
                <div className="proc-body"><div className="proc-label static">Selesai{msg.durationSec != null ? ` dalam ${fmtDur(msg.durationSec)}` : ''}</div></div>
              </div>
            )}
            {msg.streaming && (
              <div className="proc-item">
                <span className="proc-icon"><Sparkles size={15} className="pulse" /></span>
                <div className="proc-body"><div className="proc-label static shimmer">{msg.status || 'Berpikir…'}</div></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
