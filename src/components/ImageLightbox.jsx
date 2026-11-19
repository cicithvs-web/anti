import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Crop } from 'lucide-react';
import RippleButton from './RippleButton.jsx';
import { useObjectUrl } from './AttachmentTray.jsx';

/**
 * Tombol Back (Android / browser) menutup overlay: saat dibuka, satu entri history ditambahkan;
 * Back memicu popstate → onClose. Kalau ditutup dengan cara lain, entri itu dibuang lagi.
 */
function useBackToClose(open, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const marker = `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    history.pushState({ ...(history.state || {}), overlay: marker }, '');
    let poppedByBack = false;
    const onPop = () => { poppedByBack = true; closeRef.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!poppedByBack && history.state?.overlay === marker) history.back();
    };
  }, [open]);
}

/**
 * Lightbox gambar lampiran: tampil utuh (object-fit: contain).
 * item: { name, file } (composer) atau { name, url } (pesan terkirim).
 * Tutup lewat tombol X, tap area gelap, Esc, atau tombol Back. onEdit opsional.
 */
export default function ImageLightbox({ item, onClose, onEdit }) {
  const objectUrl = useObjectUrl(item?.url ? null : item?.file);
  const url = item?.url || objectUrl;
  useBackToClose(!!item, onClose);

  useEffect(() => {
    if (!item) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, onClose]);

  if (!item) return null;

  // Portal ke body: pesan chat punya animasi transform yang membuat position: fixed ikut bergeser.
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={item.name} onClick={onClose}>
      <div className="lightbox-top" onClick={(e) => e.stopPropagation()}>
        <RippleButton className="icon-btn" onClick={onClose} aria-label="Tutup">
          <X size={22} />
        </RippleButton>
        <span className="lightbox-name">{item.name}</span>
        {onEdit && (
          <RippleButton className="lightbox-edit" onClick={onEdit}>
            <Crop size={16} />
            Edit
          </RippleButton>
        )}
      </div>
      <div className="lightbox-stage">
        <img src={url} alt={item.name} draggable={false} onClick={(e) => e.stopPropagation()} />
      </div>
    </div>,
    document.body,
  );
}
