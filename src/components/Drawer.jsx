import { useEffect, useState } from 'react';
import { Plus, MessageCircle, Settings, UserRound, RefreshCw, Loader, Shield, Layers, Inbox } from 'lucide-react';
import { useLongPress } from '../hooks/useLongPress';
import ChatContextMenu from './ChatContextMenu';
import ChatActionDialog from './ChatActionDialog';
import RippleButton from './RippleButton.jsx';

function DrawerItem({ chat, active, running, onSelect, onLongPress }) {
  const handlers = useLongPress(pos => onLongPress(chat, pos.y), () => onSelect(chat.id));
  const sub = running ? (chat.jobDetail || (chat.jobStatus === 'queued' ? 'Menunggu antrean…' : 'Sedang berjalan…')) : null;
  const containerUp = !running && chat.containerState === 'running';
  return (
    <div className={'drawer-item' + (active ? ' active' : '') + (running ? ' live' : '')} {...handlers}>
      <span className="drawer-item-ico">
        {running ? <Loader size={16} className="spin" /> : <MessageCircle size={16} />}
      </span>
      <span className="drawer-item-body">
        <span className="drawer-item-title">{chat.title}</span>
        {sub && <span className="drawer-item-sub">{sub}</span>}
      </span>
      {containerUp && <span className="drawer-container-dot" title={chat.containerStatus || 'Sandbox aktif'} />}
    </div>
  );
}

export default function Drawer({
  open, chats, activeId, activeSection = 'chat', isAdmin = false, loadingIds, onRefresh, refreshing = false,
  onClose, onSelect, onOpenSection, onNewChat, onTogglePin, onRename, onDelete, onSleepSandbox, onStopChat,
  onOpenSettings, onOpenAccount, loggedIn,
}) {
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);

  useEffect(() => {
    if (!menu && !dialog) return;
    const onBack = (e) => {
      if (dialog) { setDialog(null); e.preventDefault(); }
      else if (menu) { setMenu(null); e.preventDefault(); }
    };
    window.addEventListener('antigpt:back', onBack);
    return () => window.removeEventListener('antigpt:back', onBack);
  }, [menu, dialog]);

  const isRunningChat = (c) => !!c.jobStatus || !!loadingIds?.has(c.id);
  const runningList = isAdmin
    ? chats.filter(isRunningChat).sort((a, b) => (b.jobStartedAt || b.updatedAt || 0) - (a.jobStartedAt || a.updatedAt || 0))
    : [];
  const rest = isAdmin ? chats.filter(c => !isRunningChat(c)) : chats;
  const pinned = rest.filter(c => c.pinned).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const recent = rest.filter(c => !c.pinned).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const renderItem = (c, running = false) => (
    <DrawerItem
      key={c.id}
      chat={c}
      active={activeSection === 'chat' && c.id === activeId}
      running={running}
      onSelect={onSelect}
      onLongPress={(chat, y) => setMenu({ chat, y })}
    />
  );

  return (
    <div>
      <div className={'overlay' + (open ? ' show' : '')} onClick={onClose} />
      <aside className={'drawer' + (open ? ' open' : '')}>
        <div className="drawer-head">
          <div className="drawer-title">AntiGPT</div>
          {isAdmin && (
            <div className="drawer-admin-tools">
              <span className="drawer-admin-badge"><Shield size={11} /> Admin</span>
              {onRefresh && (
                <button
                  type="button"
                  className="drawer-refresh-btn"
                  onClick={onRefresh}
                  disabled={refreshing}
                  aria-label="Segarkan daftar obrolan"
                  title="Segarkan daftar obrolan"
                >
                  <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
                </button>
              )}
            </div>
          )}
        </div>
        {onOpenSection && (
          <div className="drawer-nav">
            <RippleButton
              className={'drawer-nav-item' + (activeSection === 'artifacts' ? ' active' : '')}
              onClick={() => onOpenSection('artifacts')}
            >
              <span className="drawer-nav-ico"><Layers size={19} strokeWidth={1.85} /></span>
              <span className="drawer-nav-label">Artefak</span>
            </RippleButton>
            <RippleButton
              className={'drawer-nav-item' + (activeSection === 'droply' ? ' active' : '')}
              onClick={() => onOpenSection('droply')}
            >
              <span className="drawer-nav-ico"><Inbox size={19} strokeWidth={1.85} /></span>
              <span className="drawer-nav-label">Droply</span>
            </RippleButton>
          </div>
        )}
        <hr className="divider" />
        <div className="drawer-list">
          {isAdmin && runningList.length > 0 && (
            <>
              <div className="section-label section-label-live">
                <span className="drawer-live-dot" />
                <span>Sedang berjalan</span>
                <span className="section-count">{runningList.length}</span>
              </div>
              {runningList.map(c => renderItem(c, true))}
            </>
          )}
          {pinned.length > 0 && (
            <>
              <div className="section-label">Disematkan</div>
              {pinned.map(c => renderItem(c, false))}
            </>
          )}
          <div className="section-label">
            {isAdmin ? `Semua obrolan${recent.length ? ` (${recent.length})` : ''}` : 'Terbaru'}
          </div>
          {recent.length
            ? recent.map(c => renderItem(c, false))
            : (!runningList.length && !pinned.length ? <div className="empty">Belum ada obrolan</div> : null)}
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
          onSleepSandbox={isAdmin ? onSleepSandbox : undefined}
          onStopChat={isAdmin ? onStopChat : undefined}
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
