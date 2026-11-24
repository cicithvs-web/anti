import { X } from 'lucide-react';
import RippleButton from './RippleButton.jsx';

export default function BottomSheet({ open, title, onClose, headerAction, children }) {
  return (
    <div className={'sheet-overlay' + (open ? ' open' : '')} onClick={onClose}>
      <div className={'sheet' + (open ? ' open' : '')} onClick={e => e.stopPropagation()}>
        <div className="sheet-top">
          <div className="sheet-handle" />
          <div className="sheet-header">
            <h3>{title}</h3>
            <div className="sheet-header-actions">
              {headerAction}
              <RippleButton className="icon-btn" onClick={onClose} aria-label="Tutup">
                <X size={20} />
              </RippleButton>
            </div>
          </div>
        </div>
        <div className="sheet-body">
          {children}
        </div>
      </div>
    </div>
  );
}
