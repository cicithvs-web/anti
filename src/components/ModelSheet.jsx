import { Check } from 'lucide-react';
import BottomSheet from './BottomSheet';
import { useEffect, useState } from 'react';
import { MODELS } from '../data/models';
import { getModels } from '../services/ai';
import RippleButton from './RippleButton.jsx';

export default function ModelSheet({ open, onClose, model, onChangeModel }) {
  const [list, setList] = useState(MODELS);
  useEffect(() => {
    if (!open) return;
    getModels().then(r => { if (r.models?.length) setList(r.models.map(m => ({ id: m.id, name: m.name, desc: m.id }))); }).catch(() => {});
  }, [open]);
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
