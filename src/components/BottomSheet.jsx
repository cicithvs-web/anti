import { X } from 'lucide-react';
import RippleButton from './RippleButton.jsx';

export default function BottomSheet({ open, title, onClose, children }) {
  return (
    <div className={'sheet-overlay' + (open ? ' open' : '')} onClick={onClose}>
      <div className={'sheet' + (open ? ' open' : '')} onClick={e => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <h3>{title}</h3>
          <RippleButton className="icon-btn" onClick={onClose} aria-label="Tutup">
            <X size={20} />
          </RippleButton>
        </div>
        {children}
      </div>
    </div>
  );
}
