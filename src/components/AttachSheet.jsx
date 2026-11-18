import { useRef } from 'react';
import { Image, FileUp } from 'lucide-react';
import BottomSheet from './BottomSheet';
import RippleButton from './RippleButton.jsx';
import { DEFAULT_UPLOAD_LIMITS } from '../data/models';

export default function AttachSheet({ open, onClose, onPick, limits }) {
  const photoRef = useRef();
  const fileRef = useRef();
  const maxFiles = limits?.files || DEFAULT_UPLOAD_LIMITS.files;
  const maxMb = limits?.fileSizeMb || DEFAULT_UPLOAD_LIMITS.fileSizeMb;

  const handle = (e) => {
    const files = [...e.target.files].map(f => ({ name: f.name, type: f.type, size: f.size, file: f }));
    if (files.length) onPick(files);
    e.target.value = '';
    onClose();
  };

  return (
    <BottomSheet open={open} title="Lampirkan" onClose={onClose}>
      <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={handle} />
      <input ref={fileRef} type="file" multiple hidden onChange={handle} />
      <div className="attach-grid">
        <RippleButton className="attach-card" onClick={() => photoRef.current.click()}>
          <span className="attach-icon"><Image size={22} /></span>
          Foto
        </RippleButton>
        <RippleButton className="attach-card" onClick={() => fileRef.current.click()}>
          <span className="attach-icon"><FileUp size={22} /></span>
          File
        </RippleButton>
      </div>
      <div className="attach-hint">Maks {maxFiles} file · {maxMb} MB per kirim</div>
    </BottomSheet>
  );
}
