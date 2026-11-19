import { useRef } from 'react';
import { Camera, Image, FileUp } from 'lucide-react';
import BottomSheet from './BottomSheet';
import RippleButton from './RippleButton.jsx';
import { DEFAULT_UPLOAD_LIMITS } from '../data/models';
import { cameraFileName } from '../services/imageEdit';

// onPick(files, { source }) — source: 'camera' | 'photo' | 'file'
export default function AttachSheet({ open, onClose, onPick, limits }) {
  const cameraRef = useRef();
  const photoRef = useRef();
  const fileRef = useRef();
  const maxFiles = limits?.files || DEFAULT_UPLOAD_LIMITS.files;
  const maxMb = limits?.fileSizeMb || DEFAULT_UPLOAD_LIMITS.fileSizeMb;

  const handle = (source) => (e) => {
    const files = [...e.target.files].map(f => ({
      // nama dari kamera HP sering acak ("image.jpg", "1700000000.jpg") → beri nama yang jelas
      name: source === 'camera' ? cameraFileName() : f.name,
      type: f.type, size: f.size, file: f,
    }));
    if (files.length) onPick(files, { source });
    e.target.value = '';
    onClose();
  };

  return (
    <BottomSheet open={open} title="Lampirkan" onClose={onClose}>
      {/* capture: di HP langsung membuka kamera; di desktop jatuh ke pemilih file biasa */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={handle('camera')} />
      <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={handle('photo')} />
      <input ref={fileRef} type="file" multiple hidden onChange={handle('file')} />
      <div className="attach-grid">
        <RippleButton className="attach-card" onClick={() => cameraRef.current.click()}>
          <span className="attach-icon"><Camera size={22} /></span>
          Kamera
        </RippleButton>
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
