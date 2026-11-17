import { useEffect, useRef, useState } from 'react';
import { Pencil, Trash2, X } from 'lucide-react';
import RippleButton from './RippleButton.jsx';

export default function ChatActionDialog({ action, onClose, onRename, onDelete }) {
  const [title, setTitle] = useState(action?.chat?.title || '');
  const inputRef = useRef(null);
  const isRename = action?.type === 'rename';

  useEffect(() => {
    if (isRename) {
      setTitle(action.chat.title || '');
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [action, isRename]);

  if (!action) return null;

  const submitRename = (event) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (nextTitle) onRename(action.chat.id, nextTitle);
  };

  return (
    <div className="app-dialog-overlay" onClick={onClose} role="presentation">
      <section className="app-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="chat-dialog-title">
        <div className="app-dialog-handle" />
        <div className="app-dialog-head">
          <div className={'app-dialog-icon' + (isRename ? '' : ' danger')}>
            {isRename ? <Pencil size={20} /> : <Trash2 size={20} />}
          </div>
          <button className="app-dialog-close" type="button" onClick={onClose} aria-label="Tutup"><X size={18} /></button>
        </div>
        <h2 id="chat-dialog-title">{isRename ? 'Ganti nama obrolan' : 'Hapus obrolan?'}</h2>
        {isRename ? (
          <form onSubmit={submitRename}>
            <label className="app-dialog-label" htmlFor="chat-title-input">Nama obrolan</label>
            <input
              ref={inputRef}
              id="chat-title-input"
              className="app-dialog-input"
              value={title}
              onChange={event => setTitle(event.target.value)}
              maxLength={120}
              autoComplete="off"
            />
            <div className="app-dialog-actions">
              <RippleButton className="app-dialog-btn secondary" type="button" onClick={onClose}>Batal</RippleButton>
              <RippleButton className="app-dialog-btn primary" type="submit" disabled={!title.trim()}>Simpan</RippleButton>
            </div>
          </form>
        ) : (
          <>
            <p className="app-dialog-message">Obrolan “{action.chat.title}” akan dihapus dan tidak bisa dipulihkan.</p>
            <div className="app-dialog-actions">
              <RippleButton className="app-dialog-btn secondary" type="button" onClick={onClose}>Batal</RippleButton>
              <RippleButton className="app-dialog-btn danger" type="button" onClick={() => onDelete(action.chat.id)}>Hapus</RippleButton>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
