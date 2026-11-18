import { Check } from 'lucide-react';
import BottomSheet from './BottomSheet';
import { useEffect } from 'react';
import RippleButton from './RippleButton.jsx';

// Daftar model dipegang App (di-cache di sessionStorage); onOpen hanya memicu refresh kalau cache kadaluarsa.
export default function ModelSheet({ open, onClose, model, list, onOpen, onChangeModel }) {
  useEffect(() => { if (open) onOpen?.(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <BottomSheet open={open} title="Model" onClose={onClose}>
      <div className="card-list">
        {list.map(m => (
          <RippleButton key={m.id} className="model-row" onClick={() => { onChangeModel(m.id); onClose(); }}>
            <div>
              <div className="model-name">
                {m.name}
                {m.badge && <span className="badge">{m.badge}</span>}
              </div>
              <div className="model-desc">{m.desc}</div>
            </div>
            {m.id === model && <Check size={18} />}
          </RippleButton>
        ))}
      </div>
    </BottomSheet>
  );
}
