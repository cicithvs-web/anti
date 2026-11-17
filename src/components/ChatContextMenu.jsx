import { Pin, PinOff, Pencil, Trash2 } from 'lucide-react';
import RippleButton from './RippleButton.jsx';

export default function ChatContextMenu({ chat, y, onClose, onTogglePin, onRenameRequest, onDeleteRequest }) {
  const top = Math.min(y, window.innerHeight - 200);
  const act = (fn) => () => { fn(); onClose(); };

  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="context-menu" style={{ top }}>
        <RippleButton onClick={act(() => onTogglePin(chat.id))}>
          {chat.pinned ? <PinOff size={16} /> : <Pin size={16} />}
          {chat.pinned ? 'Lepas sematan' : 'Sematkan'}
        </RippleButton>
        <RippleButton onClick={act(() => onRenameRequest(chat))}>
          <Pencil size={16} /> Ganti nama
        </RippleButton>
        <RippleButton className="danger" onClick={act(() => onDeleteRequest(chat))}>
          <Trash2 size={16} /> Hapus
        </RippleButton>
      </div>
    </div>
  );
}
