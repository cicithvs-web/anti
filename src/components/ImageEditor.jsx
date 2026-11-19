import { useEffect, useMemo, useState } from 'react';
import Cropper from 'react-easy-crop';
import { X, RotateCcw, RotateCw, Check, Loader2 } from 'lucide-react';
import RippleButton from './RippleButton.jsx';
import { renderEditedImage, loadImage } from '../services/imageEdit';

const ASPECTS = [
  { id: 'orig', label: 'Asli' },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '4:3', label: '4:3', value: 4 / 3 },
  { id: '3:4', label: '3:4', value: 3 / 4 },
  { id: '16:9', label: '16:9', value: 16 / 9 },
];

/**
 * Editor foto layar penuh: crop (geser + cubit/zoom) dan putar 90°.
 * item: { name, type, file } — onDone(File) saat disimpan, onCancel() saat batal.
 * onError(pesan) dipanggil kalau gambar tidak bisa dibuka/diproses.
 */
export default function ImageEditor({ item, onDone, onCancel, onError }) {
  const src = useMemo(() => (item ? URL.createObjectURL(item.file) : null), [item]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [aspectId, setAspectId] = useState('orig');
  const [natural, setNatural] = useState(null);
  const [cropPx, setCropPx] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCrop({ x: 0, y: 0 }); setZoom(1); setRotation(0);
    setAspectId('orig'); setNatural(null); setCropPx(null); setSaving(false);
  }, [item]);

  // Format yang tidak bisa dibuka browser (mis. HEIC di Chrome) → laporkan ke pemanggil.
  useEffect(() => {
    if (!src) return;
    let alive = true;
    loadImage(src).catch(() => { if (alive) onError?.('Foto ini tidak bisa diedit di browser'); });
    return () => { alive = false; };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!item) return;
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, onCancel]);

  if (!item) return null;

  const sideways = rotation % 180 !== 0;
  const origAspect = natural
    ? (sideways ? natural.height / natural.width : natural.width / natural.height)
    : 4 / 3;
  const aspect = ASPECTS.find((a) => a.id === aspectId)?.value ?? origAspect;

  const rotate = (deg) => {
    setRotation((r) => (r + deg + 360) % 360);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  };

  const save = async () => {
    if (!cropPx || saving) return;
    setSaving(true);
    try {
      const file = await renderEditedImage({ src, cropPx, rotation, name: item.name, type: item.type });
      onDone(file);
    } catch (e) {
      setSaving(false);
      onError?.(e.message || 'Gagal memproses gambar');
    }
  };

  return (
    <div className="img-editor" role="dialog" aria-modal="true" aria-label="Edit foto">
      <div className="img-editor-top">
        <RippleButton className="icon-btn" onClick={onCancel} aria-label="Batal">
          <X size={22} />
        </RippleButton>
        <span className="img-editor-title">Edit foto</span>
        <RippleButton className="img-editor-done" onClick={save} disabled={!cropPx || saving}>
          {saving ? <Loader2 size={18} className="spin" /> : <Check size={18} />}
          Selesai
        </RippleButton>
      </div>

      <div className="img-editor-stage">
        <Cropper
          image={src}
          crop={crop}
          zoom={zoom}
          rotation={rotation}
          aspect={aspect}
          minZoom={1}
          maxZoom={5}
          zoomSpeed={0.5}
          showGrid
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(_, px) => setCropPx(px)}
          onMediaLoaded={(m) => setNatural({ width: m.naturalWidth, height: m.naturalHeight })}
        />
      </div>

      <div className="img-editor-bottom">
        <div className="img-editor-aspects">
          {ASPECTS.map((a) => (
            <button key={a.id} type="button"
              className={'img-editor-chip' + (a.id === aspectId ? ' active' : '')}
              onClick={() => setAspectId(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
        <div className="img-editor-tools">
          <RippleButton className="img-editor-tool" onClick={() => rotate(-90)} aria-label="Putar ke kiri">
            <RotateCcw size={20} />
          </RippleButton>
          <input className="img-editor-zoom" type="range" min={1} max={5} step={0.01}
            value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
          <RippleButton className="img-editor-tool" onClick={() => rotate(90)} aria-label="Putar ke kanan">
            <RotateCw size={20} />
          </RippleButton>
        </div>
      </div>
    </div>
  );
}
