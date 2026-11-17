import { Menu, SquarePen } from 'lucide-react';
import RippleButton from './RippleButton.jsx';

export default function Header({ title, onMenu, onNewChat }) {
  return (
    <header className="header">
      <RippleButton className="icon-btn" onClick={onMenu} aria-label="Menu">
        <Menu size={24} />
      </RippleButton>
      <span className="header-title">{title}</span>
      <RippleButton className="icon-btn" onClick={onNewChat} aria-label="Chat baru">
        <SquarePen size={22} />
      </RippleButton>
    </header>
  );
}
