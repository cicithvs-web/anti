import { Check, RefreshCw } from 'lucide-react';
import BottomSheet from './BottomSheet';
import { useEffect } from 'react';
import RippleButton from './RippleButton.jsx';

// Daftar model dipegang App (cache 10 menit di browser & server); tombol ↻ mengambil daftar terbaru realtime dari `agy models`.
export default function ModelSheet({ open, onClose, model, list, onOpen, onRefresh, refreshing, onChangeModel }) {
  useEffect(() => { if (open) onOpen?.(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <BottomSheet
      open={open}
      title="Model"
      onClose={onClose}
      headerAction={onRefresh && (
        <RippleButton
          className="icon-btn model-refresh-btn"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Perbarui daftar model"
          title="Perbarui daftar model"
        >
          <RefreshCw size={18} className={refreshing ? 'spin' : ''} />
        </RippleButton>
      )}
    >
      {refreshing && <div className="model-sync-status shimmer">Memperbarui daftar model…</div>}
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
