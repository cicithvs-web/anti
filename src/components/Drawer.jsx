import { useState } from 'react';
import { Plus, MessageCircle, Settings, UserRound } from 'lucide-react';
import { useLongPress } from '../hooks/useLongPress';
import ChatContextMenu from './ChatContextMenu';
import ChatActionDialog from './ChatActionDialog';
import RippleButton from './RippleButton.jsx';

function DrawerItem({ chat, active, onSelect, onLongPress }) {
  const handlers = useLongPress(pos => onLongPress(chat, pos.y), () => onSelect(chat.id));
  return (
    <div className={'drawer-item' + (active ? ' active' : '')} {...handlers}>
      <MessageCircle size={16} />
      <span>{chat.title}</span>
    </div>
  );
}

export default function Drawer({ open, chats, activeId, userName, onClose, onSelect, onNewChat, onTogglePin, onRename, onDelete, onOpenSettings, onOpenAccount, loggedIn }) {
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const pinned = chats.filter(c => c.pinned);
  const recent = chats.filter(c => !c.pinned).sort((a, b) => b.updatedAt - a.updatedAt);

  const renderItem = (c) => (
    <DrawerItem
      key={c.id}
      chat={c}
      active={c.id === activeId}
      onSelect={onSelect}
      onLongPress={(chat, y) => setMenu({ chat, y })}
    />
  );

  return (
    <div>
      <div className={'overlay' + (open ? ' show' : '')} onClick={onClose} />
      <aside className={'drawer' + (open ? ' open' : '')}>
        <div className="drawer-title">AntiGPT</div>
        <hr className="divider" />
        <div className="drawer-list">
          {pinned.length > 0 && (
            <>
              <div className="section-label">Disematkan</div>
              {pinned.map(renderItem)}
            </>
          )}
          <div className="section-label">Terbaru</div>
          {recent.length ? recent.map(renderItem) : <div className="empty">Belum ada obrolan</div>}
        </div>
        <div className="drawer-footer">
          <div className="footer-btns">
            <RippleButton className="avatar account-trigger" aria-label="Akun" onClick={onOpenAccount}>
              {loggedIn ? <UserRound size={22} /> : <UserRound size={22} strokeWidth={1.6} style={{ opacity: 0.75 }} />}
            </RippleButton>
            <RippleButton className="avatar settings-trigger" aria-label="Pengaturan" onClick={onOpenSettings}>
              <Settings size={22} />
            </RippleButton>
          </div>
          <RippleButton className="new-chat-btn" onClick={onNewChat}>
            <Plus size={16} /> Chat baru
          </RippleButton>
        </div>
      </aside>

      {menu && (
        <ChatContextMenu
          chat={menu.chat} y={menu.y} onClose={() => setMenu(null)}
          onTogglePin={onTogglePin}
          onRenameRequest={chat => setDialog({ type: 'rename', chat })}
          onDeleteRequest={chat => setDialog({ type: 'delete', chat })}
        />
      )}
      <ChatActionDialog
        action={dialog}
        onClose={() => setDialog(null)}
        onRename={(id, title) => { onRename(id, title); setDialog(null); }}
        onDelete={id => { onDelete(id); setDialog(null); }}
      />
    </div>
  );
}
