import { useRef, useState, useEffect } from 'react';
import { Plus, Mic, ArrowUp, Square, X } from 'lucide-react';
import RippleButton from './RippleButton.jsx';

export default function ChatInput({
  isNewChat, modelName, attachments,
  onRemoveAttachment, onSend, onStop, onOpenAttach, onOpenModel, disabled,
}) {
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(isNewChat);
  const taRef = useRef(null);

  // Re-evaluasi mode saat pindah chat / new chat
  useEffect(() => {
    // Pindah ke layar welcome -> selalu expanded; pindah ke chat tanpa fokus -> collapsed
    setExpanded(!!isNewChat);
    if (taRef.current) taRef.current.style.height = 'auto';
  }, [isNewChat]);

  // Saat textarea kehilangan fokus & kosong di layar chat -> kembali ke mode ringkas
  const handleBlur = () => {
    if (!isNewChat && !text.trim() && attachments?.length === 0) {
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

  const submit = () => {
    if ((!text.trim() && !attachments?.length) || disabled) return;
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
    <div className={'input-box' + (expanded ? ' expanded' : '') + (hasText ? ' has-text' : '')}>
      {expanded && attachments?.length > 0 && (
        <div className="files attach-row">
          {attachments.map((f, i) => (
            <span key={i} className="chip">
              {f.name}
              <button onClick={() => onRemoveAttachment(i)} aria-label="Hapus lampiran">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        className="ta"
        rows={1}
        placeholder="Tanya apa saja..."
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
        {(expanded || !isNewChat) && (
          <RippleButton className={'model-pill' + (!expanded ? ' compact' : '')} onClick={onOpenModel}>
            {modelName}
          </RippleButton>
        )}
      </div>
      <div className="right-tools">
        {!hasText && (
          <RippleButton className="circle-btn mic" aria-label="Mic">
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
