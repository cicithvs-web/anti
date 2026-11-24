import { useEffect, useRef, useState } from 'react';
import {
  Terminal, FileText, FilePen, Globe, Wrench, Sparkles, Loader,
  ChevronDown, ChevronRight, MessageCircleQuestion,
} from 'lucide-react';

const ICON = {
  terminal: Terminal,
  read: FileText,
  edit: FilePen,
  web: Globe,
  question: MessageCircleQuestion,
  tool: Wrench,
};

export const fmtDur = (s) => (s == null ? '' : s < 60 ? `${Math.round(s)} dtk` : `${Math.floor(s / 60)} mnt ${Math.round(s % 60)} dtk`);

const cleanThought = (t) => String(t || '').replace(/\n{3,}/g, '\n\n').trim();

// Timeline proses berpikir & pemakaian tool — terbuka saat AI memproses,
// lalu otomatis menutup rapi begitu AI mulai menulis jawaban atau selesai (pilihan manual user tetap dihormati).
export default function ThinkingProcess({ msg, hasPendingQuestion, onOpenQuestion }) {
  const hasContent = Boolean(msg?.content && String(msg.content).trim());
  const streaming = Boolean(msg?.streaming);
  const [collapsed, setCollapsed] = useState(() => !streaming || hasContent);
  const [expandedTool, setExpandedTool] = useState(null);
  const userToggledRef = useRef(false);
  const prevRef = useRef({ streaming, hasContent });

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { streaming, hasContent };
    if (userToggledRef.current) return;
    // Tutup otomatis begitu jawaban mulai ditulis atau saat giliran selesai
    if ((!prev.hasContent && hasContent) || (prev.streaming && !streaming)) {
      setCollapsed(true);
    }
  }, [streaming, hasContent]);

  if (!msg) return null;
  const steps = msg.steps || [];

  // Tidak ada langkah sama sekali
  if (steps.length === 0) {
    if (!streaming || msg.content) return null;
    return (
      <div className="proc-live-only">
        <Sparkles size={15} className="pulse" />
        <span className="shimmer">{msg.status || 'Berpikir…'}</span>
      </div>
    );
  }

  const hasThoughtText = steps.some((s) => s.kind === 'think' && cleanThought(s.text));
  const toolCount = steps.filter((s) => s.kind !== 'think').length;
  const doneLabel = toolCount > 0
    ? `${hasThoughtText ? 'Proses berpikir' : 'Proses'} · ${toolCount} langkah`
    : (hasThoughtText ? 'Proses berpikir' : 'Proses');
  const lastStep = steps[steps.length - 1];
  const lastRunning = lastStep && lastStep.kind !== 'think' && lastStep.status === 'running';

  return (
    <div className="proc-inline">
      <button
        type="button"
        className={'proc-head' + (streaming ? ' live' : '')}
        onClick={() => {
          userToggledRef.current = true;
          setCollapsed((c) => !c);
        }}
        aria-expanded={!collapsed}
      >
        <Sparkles size={14} className={streaming ? 'pulse' : ''} />
        <span className={'proc-head-text' + (streaming ? ' shimmer' : '')}>
          {streaming ? (msg.status || 'Berpikir…') : doneLabel}
        </span>
        <ChevronDown size={15} className={'proc-chev' + (collapsed ? ' closed' : '')} />
      </button>

      {!collapsed && (
        <div className="proc-timeline">
          {steps.map((s) => {
            if (s.kind === 'think') {
              const text = cleanThought(s.text);
              return (
                <div key={s.id} className="proc-step proc-step-think">
                  <div className="proc-thought-full">
                    {text || (
                      <>
                        Berpikir{s.duration != null ? ` · ${fmtDur(s.duration)}` : ''}
                        {s.thinkingTokens ? ` · ${s.thinkingTokens} token` : ''}
                      </>
                    )}
                  </div>
                </div>
              );
            }

            const Ico = ICON[s.kind] || Wrench;
            const waitingQ = s.tool === 'ask_question' && s.status === 'running' && hasPendingQuestion;
            const isOpen = expandedTool === s.id;
            const canClick = waitingQ || !!s.output;

            return (
              <div key={s.id} className="proc-step proc-step-tool">
                <button
                  type="button"
                  className={'proc-tool-btn' + (waitingQ ? ' waiting' : '')}
                  disabled={!canClick}
                  onClick={() => {
                    if (waitingQ) onOpenQuestion?.();
                    else if (s.output) setExpandedTool(isOpen ? null : s.id);
                  }}
                >
                  <span className="proc-tool-ico">
                    {s.status === 'running' ? <Loader size={14} className="spin" /> : <Ico size={14} />}
                  </span>
                  <span className="proc-tool-label">{s.label}</span>
                  <span className="proc-tool-meta">
                    {waitingQ ? 'Jawab' : s.status === 'running' ? 'berjalan…' : fmtDur(s.duration)}
                  </span>
                  {s.output && !waitingQ && (
                    <ChevronRight size={14} className={'proc-tool-chev' + (isOpen ? ' open' : '')} />
                  )}
                </button>
                {isOpen && s.output && <pre className="proc-output">{s.output}</pre>}
              </div>
            );
          })}

          {msg.streaming && !msg.content && !lastRunning && (
            <div className="proc-step proc-live">
              <Sparkles size={13} className="pulse" />
              <span className="shimmer">{msg.status || 'Berpikir…'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
