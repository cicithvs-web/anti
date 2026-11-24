import { Pin, PinOff, Pencil, Trash2, Moon, Square } from 'lucide-react';
import RippleButton from './RippleButton.jsx';

export default function ChatContextMenu({
  chat, y, onClose, onTogglePin, onRenameRequest, onDeleteRequest, onSleepSandbox, onStopChat,
}) {
  const canStop = !!onStopChat && !!chat.jobStatus;
  const canSleep = !!onSleepSandbox && chat.containerState === 'running' && !chat.jobStatus;
  const extraHeight = (canStop ? 48 : 0) + (canSleep ? 48 : 0);
  const top = Math.max(56, Math.min(y, window.innerHeight - (200 + extraHeight) - 16));
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
        {canStop && (
          <RippleButton className="danger" onClick={act(() => onStopChat(chat.id))}>
            <Square size={16} /> Hentikan proses
          </RippleButton>
        )}
        {canSleep && (
          <RippleButton onClick={act(() => onSleepSandbox(chat.id))}>
            <Moon size={16} /> Tidurkan sandbox
          </RippleButton>
        )}
        <RippleButton className="danger" onClick={act(() => onDeleteRequest(chat))}>
          <Trash2 size={16} /> Hapus
        </RippleButton>
      </div>
    </div>
  );
}
