import { useRef, useState, useEffect } from 'react';
import { Plus, Mic, ArrowUp, Square, X } from 'lucide-react';
import RippleButton from './RippleButton.jsx';
import useSpeechRecorder from '../hooks/useSpeechRecorder.js';
import AttachmentTray from './AttachmentTray.jsx';

// Perintah lokal: tidak dikirim ke agy, langsung toggle rekam suara
const RECORD_CMD = /^\/(record|voice)$/i;

export default function ChatInput({
  isNewChat, modelName, attachments, attachError, onClearAttachError,
  onRemoveAttachment, onPreviewAttachment, onSend, onStop, onOpenAttach, onOpenModel, disabled,
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(!!isNewChat);
  const taRef = useRef(null);
  const boxRef = useRef(null);

  // ---- rekam suara (/record atau tombol mic) ----
  const baseTextRef = useRef('');
  const autoResize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const imeTotal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ime-total')) || 0;
    const avail = Math.max(120, window.innerHeight - imeTotal);
    const maxH = Math.min(window.innerHeight * 0.4, Math.max(96, avail - 180));
    const next = Math.max(40, Math.min(ta.scrollHeight, maxH));
    ta.style.height = next + 'px';
  };
  const mic = useSpeechRecorder({
    onTranscript: (t) => {
      const base = baseTextRef.current;
      setText(base && t ? base.replace(/\s*$/, ' ') + t : base + t);
      requestAnimationFrame(autoResize);
    },
  });

  const hasText = !!text.trim();
  const hasFiles = attachments?.length > 0 || !!attachError;
  const stateRef = useRef({});
  stateRef.current = { isNewChat: !!isNewChat, hasText, hasFiles, recording: !!mic.recording };

  // Re-evaluasi mode saat pindah chat / new chat (layar welcome tetap expanded seperti semula)
  useEffect(() => {
    const s = stateRef.current;
    const shouldExpand = s.isNewChat || s.hasText || s.hasFiles || s.recording;
    setExpanded(shouldExpand);
    if (!s.hasText && taRef.current) taRef.current.style.height = '';
  }, [isNewChat]);

  // Saat file dilampirkan, ada error upload, atau sedang merekam -> otomatis buka input box
  useEffect(() => {
    if (hasFiles || mic.recording) {
      setExpanded(true);
    } else if (!isNewChat && !hasText && document.activeElement !== taRef.current) {
      setExpanded(false);
      if (taRef.current) taRef.current.style.height = '';
    }
  }, [hasFiles, mic.recording, isNewChat, hasText]);

  // Deteksi keyboard HP ditutup lewat tombol Back (browser mobile/WebView sering tidak memicu blur otomatis)
  useEffect(() => {
    const getVH = () => {
      const vv = window.visualViewport?.height;
      return vv ? Math.min(window.innerHeight, vv) : window.innerHeight;
    };
    let maxH = getVH();
    let lastW = window.innerWidth;
    let kbOpen = false;

    const onViewportResize = () => {
      const w = window.innerWidth;
      const h = getVH();
      if (Math.abs(w - lastW) > 40) {
        lastW = w;
        maxH = h;
        kbOpen = false;
        return;
      }
      if (h > maxH) maxH = h;
      const drop = maxH - h;

      if (drop > 120 && document.activeElement === taRef.current) {
        kbOpen = true;
        return;
      }

      if (kbOpen && drop < 60) {
        kbOpen = false;
        const s = stateRef.current;
        if (document.activeElement === taRef.current) {
          taRef.current?.blur();
        }
        if (!s.isNewChat && !s.hasText && !s.hasFiles && !s.recording) {
          setExpanded(false);
          if (taRef.current) taRef.current.style.height = '';
        }
      }
    };

    const onNativeImeHide = () => {
      kbOpen = false;
      const s = stateRef.current;
      if (document.activeElement === taRef.current) {
        taRef.current?.blur();
      }
      if (!s.isNewChat && !s.hasText && !s.hasFiles && !s.recording) {
        setExpanded(false);
        if (taRef.current) taRef.current.style.height = '';
      }
    };

    window.visualViewport?.addEventListener('resize', onViewportResize);
    window.addEventListener('resize', onViewportResize);
    window.addEventListener('antigpt:ime-hide', onNativeImeHide);
    return () => {
      window.visualViewport?.removeEventListener('resize', onViewportResize);
      window.removeEventListener('resize', onViewportResize);
      window.removeEventListener('antigpt:ime-hide', onNativeImeHide);
    };
  }, []);

  // Saat textarea kehilangan fokus & kosong di layar chat -> kembali ke mode ringkas secara halus
  const handleBlur = (e) => {
    setFocused(false);
    // Fokus pindah ke tombol di dalam input-box (mis. pilih model) -> jangan collapse dulu
    if (boxRef.current && e?.relatedTarget && boxRef.current.contains(e.relatedTarget)) return;
    if (!isNewChat && !hasText && !hasFiles && !mic.recording) {
      setExpanded(false);
      if (taRef.current) taRef.current.style.height = '';
    }
  };

  const handleBoxClick = (e) => {
    if (!expanded && !e.target.closest('button')) {
      taRef.current?.focus();
    }
  };

  const toggleRecord = (currentText = text) => {
    if (!mic.recording) { baseTextRef.current = currentText; setExpanded(true); }
    mic.toggle();
  };

  const submit = () => {
    if (RECORD_CMD.test(text.trim())) {
      setText('');
      if (taRef.current) taRef.current.style.height = '';
      toggleRecord('');
      return;
    }
    if ((!text.trim() && !attachments?.length) || disabled) return;
    if (mic.recording) mic.abort();
    onSend({ text: text.trim(), files: attachments });
    setText('');
    if (taRef.current) taRef.current.style.height = '';
    taRef.current?.blur();
    // Setelah kirim: di layar chat -> kembali ke kapsul 1 baris secara halus; di welcome tetap expanded
    setExpanded(!!isNewChat);
  };

  const showMic = !hasText || mic.recording;
  const canSend = (hasText || attachments?.length > 0) && !disabled;

  return (
    <div
      ref={boxRef}
      onClick={handleBoxClick}
      className={
        'input-box'
        + (expanded ? ' expanded' : '')
        + (focused ? ' focused' : '')
        + (hasText ? ' has-text' : '')
      }
    >
      <div className={'input-files-collapse' + (expanded && hasFiles ? ' open' : '')}>
        <div className="input-files-inner">
          {attachments?.length > 0 && (
            <AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} onOpen={onPreviewAttachment} />
          )}
          {attachError && (
            <div className="attach-error" role="alert">
              <span>{attachError}</span>
              <button type="button" onClick={onClearAttachError} aria-label="Tutup peringatan">
                <X size={13} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="input-ta-slot">
        <textarea
          ref={taRef}
          className="ta"
          rows={1}
          placeholder={mic.error || (mic.recording ? 'Mendengarkan… (tap mic untuk berhenti)' : 'Tanya apa saja...')}
          value={text}
          onFocus={() => { setFocused(true); setExpanded(true); }}
          onBlur={handleBlur}
          onChange={(e) => { setText(e.target.value); autoResize(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
      </div>

      <div className="input-toolbar">
        <div className="left-tools">
          <RippleButton className="circle-btn plus" onClick={onOpenAttach} aria-label="Lampirkan">
            <Plus size={22} />
          </RippleButton>
          <div className="model-pill-slot" aria-hidden={!expanded}>
            <RippleButton
              className="model-pill"
              tabIndex={expanded ? 0 : -1}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onOpenModel(); taRef.current?.blur(); }}
            >
              <span className="model-pill-text">{modelName}</span>
            </RippleButton>
          </div>
        </div>

        <div className="right-tools">
          <div className={'mic-slot' + (showMic ? '' : ' hidden')} aria-hidden={!showMic}>
            <RippleButton
              className={'circle-btn mic' + (mic.recording ? ' recording' : '') + (mic.error ? ' mic-error' : '')}
              tabIndex={showMic ? 0 : -1}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => toggleRecord()}
              aria-label={mic.recording ? 'Berhenti merekam' : 'Rekam suara'}
              aria-pressed={mic.recording}
              title={mic.error || (mic.recording ? 'Berhenti merekam' : 'Rekam suara (/record)')}
            >
              <Mic size={20} />
            </RippleButton>
          </div>
          <RippleButton
            className={'send-btn' + (disabled ? ' stop' : canSend ? ' ready' : ' dim')}
            onClick={disabled ? onStop : submit}
            aria-label={disabled ? 'Hentikan proses' : 'Kirim'}
          >
            {disabled ? <Square size={17} fill="currentColor" /> : <ArrowUp size={22} />}
          </RippleButton>
        </div>
      </div>
    </div>
  );
}
