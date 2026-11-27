import { Menu, SquarePen, ArrowLeft, RefreshCw } from 'lucide-react';
import RippleButton from './RippleButton.jsx';

export default function Header({ title, onMenu, onNewChat, onBack, onRefresh }) {
  return (
    <header className="header">
      <RippleButton className="icon-btn" onClick={onMenu} aria-label="Menu">
        <Menu size={24} />
      </RippleButton>
      <span className="header-title">{title}</span>
      {onRefresh && (
        <RippleButton className="icon-btn" onClick={onRefresh} aria-label="Segarkan" title="Segarkan">
          <RefreshCw size={19} />
        </RippleButton>
      )}
      {onBack ? (
        <RippleButton className="icon-btn" onClick={onBack} aria-label="Kembali ke obrolan" title="Kembali ke obrolan">
          <ArrowLeft size={21} />
        </RippleButton>
      ) : (
        <RippleButton className="icon-btn" onClick={onNewChat} aria-label="Chat baru">
          <SquarePen size={22} />
        </RippleButton>
      )}
    </header>
  );
}
