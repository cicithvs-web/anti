import { useRef, useState, useEffect } from 'react';
import { Plus, Mic, ArrowUp, Square, X } from 'lucide-react';
import RippleButton from './RippleButton.jsx';
import useSpeechRecorder from '../hooks/useSpeechRecorder.js';

// Perintah lokal: tidak dikirim ke agy, langsung toggle rekam suara
const RECORD_CMD = /^\/(record|voice)$/i;

export default function ChatInput({
  isNewChat, modelName, attachments, attachError, onClearAttachError,
  onRemoveAttachment, onSend, onStop, onOpenAttach, onOpenModel, disabled,
}) {
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(isNewChat);
  const taRef = useRef(null);
  const boxRef = useRef(null);

  // Re-evaluasi mode saat pindah chat / new chat
  useEffect(() => {
    // Pindah ke layar welcome -> selalu expanded; pindah ke chat tanpa fokus -> collapsed (kecuali ada lampiran)
    setExpanded(!!isNewChat || attachments?.length > 0 || !!attachError);
    if (taRef.current) taRef.current.style.height = 'auto';
  }, [isNewChat]);

  // Saat file dilampirkan atau ada peringatan upload, buka input box supaya chip/pesan langsung terlihat
  useEffect(() => {
    if (attachments?.length > 0 || attachError) setExpanded(true);
    else if (!isNewChat && !text.trim() && document.activeElement !== taRef.current) setExpanded(false);
  }, [attachments?.length, attachError, isNewChat, text]);

  // Saat textarea kehilangan fokus & kosong di layar chat -> kembali ke mode ringkas
  const handleBlur = (e) => {
    // Fokus pindah ke tombol di dalam input-box (mis. pilih model) -> jangan collapse dulu,
    // kalau tidak tombolnya keburu hilang sebelum event click sempat jalan.
    if (boxRef.current && e?.relatedTarget && boxRef.current.contains(e.relatedTarget)) return;
    if (!isNewChat && !text.trim() && attachments?.length === 0 && !attachError) {
      setExpanded(false);
      if (taRef.current) taRef.current.style.height = 'auto';
    }
  };

  const autoResize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  };

  // ---- rekam suara (/record atau tombol mic) ----
  const baseTextRef = useRef('');
  const mic = useSpeechRecorder({
    onTranscript: (t) => {
      const base = baseTextRef.current;
      setText(base && t ? base.replace(/\s*$/, ' ') + t : base + t);
      requestAnimationFrame(autoResize);
    },
  });
  const toggleRecord = (currentText = text) => {
    if (!mic.recording) { baseTextRef.current = currentText; setExpanded(true); }
    mic.toggle();
  };

  const submit = () => {
    if (RECORD_CMD.test(text.trim())) {
      setText('');
      if (taRef.current) taRef.current.style.height = 'auto';
      toggleRecord('');
      return;
    }
    if ((!text.trim() && !attachments?.length) || disabled) return;
    if (mic.recording) mic.abort();
    onSend({ text: text.trim(), files: attachments });
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
    taRef.current?.blur();
    // Setelah kirim: di layar chat ada bubble -> collapsed; di welcome tetap expanded
    setExpanded(!!isNewChat);
  };

  const hasText = !!text.trim();
  const canSend = (hasText || attachments?.length > 0) && !disabled;

  return (
    <div ref={boxRef} className={'input-box' + (expanded ? ' expanded' : '') + (hasText ? ' has-text' : '')}>
      {expanded && (attachments?.length > 0 || attachError) && (
        <div className="files">
          {attachments?.length > 0 && (
            <div className="attach-row">
              {attachments.map((f, i) => (
                <span key={i} className="chip">
                  <span className="chip-name">{f.name}</span>
                  <button type="button" onClick={() => onRemoveAttachment(i)} aria-label="Hapus lampiran">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
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
      )}
      <textarea
        ref={taRef}
        className="ta"
        rows={1}
        placeholder={mic.error || (mic.recording ? 'Mendengarkan… (tap mic untuk berhenti)' : 'Tanya apa saja...')}
        value={text}
        onFocus={() => setExpanded(true)}
        onBlur={handleBlur}
        onChange={(e) => { setText(e.target.value); autoResize(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }}
      />
      <div className="left-tools">
        <RippleButton className="circle-btn plus" onClick={onOpenAttach} aria-label="Lampirkan">
          <Plus size={22} />
        </RippleButton>
        {expanded && (
          <RippleButton
            className={'model-pill' + (!expanded ? ' compact' : '')}
            // cegah textarea blur di mousedown (blur -> collapse -> tombol hilang sebelum click)
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onOpenModel(); taRef.current?.blur(); }}
          >
            {modelName}
          </RippleButton>
        )}
      </div>
      <div className="right-tools">
        {(!hasText || mic.recording) && (
          <RippleButton
            className={'circle-btn mic' + (mic.recording ? ' recording' : '') + (mic.error ? ' mic-error' : '')}
            onClick={() => toggleRecord()}
            aria-label={mic.recording ? 'Berhenti merekam' : 'Rekam suara'}
            aria-pressed={mic.recording}
            title={mic.error || (mic.recording ? 'Berhenti merekam' : 'Rekam suara (/record)')}
          >
            <Mic size={20} />
          </RippleButton>
        )}
        <RippleButton
          className={'send-btn' + (disabled ? ' stop' : canSend ? ' ready' : ' dim')}
          onClick={disabled ? onStop : submit}
          aria-label={disabled ? 'Hentikan proses' : 'Kirim'}
        >
          {disabled ? <Square size={17} fill="currentColor" /> : <ArrowUp size={22} />}
        </RippleButton>
      </div>
    </div>
  );
}
