import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Crop, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import RippleButton from './RippleButton.jsx';
import { useObjectUrl } from './AttachmentTray.jsx';

const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i;

function isVideoItem(it) {
  if (!it) return false;
  if (it.kind === 'video') return true;
  if (it.type?.startsWith('video/')) return true;
  return VIDEO_EXT_RE.test(it.name || '') || VIDEO_EXT_RE.test(it.url || '');
}

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
 * Lightbox gambar & video dengan dukungan galeri multi-media (◀ / ▶, swipe HP, tombol Unduh).
 * item:
 *   - tunggal: { name, file?, url?, kind?, downloadUrl? }
 *   - galeri : { items: [...], index: number }
 */
export default function ImageLightbox({ item, onClose, onEdit, onNavigate }) {
  const isGallery = !!item && Array.isArray(item.items) && item.items.length > 0;
  const items = isGallery ? item.items : (item ? [item] : []);
  const index = isGallery ? Math.max(0, Math.min(item.index || 0, items.length - 1)) : 0;
  const current = items[index] || null;

  const objectUrl = useObjectUrl(current?.url ? null : current?.file);
  const url = current?.url || objectUrl;
  const isVideo = isVideoItem(current);
  const canPrev = isGallery && index > 0 && !!onNavigate;
  const canNext = isGallery && index < items.length - 1 && !!onNavigate;
  const touchXRef = useRef(null);

  useBackToClose(!!current, onClose);

  useEffect(() => {
    if (!current) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && canPrev) onNavigate(index - 1);
      else if (e.key === 'ArrowRight' && canNext) onNavigate(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, onClose, onNavigate, canPrev, canNext, index]);

  if (!current) return null;

  const onTouchStart = (e) => {
    if (!isGallery || items.length < 2 || isVideo) return;
    touchXRef.current = e.touches?.[0]?.clientX ?? null;
  };
  const onTouchEnd = (e) => {
    if (touchXRef.current == null) return;
    const dx = (e.changedTouches?.[0]?.clientX ?? touchXRef.current) - touchXRef.current;
    touchXRef.current = null;
    if (dx > 50 && canPrev) onNavigate(index - 1);
    else if (dx < -50 && canNext) onNavigate(index + 1);
  };

  // Portal ke body: pesan chat punya animasi transform yang membuat position: fixed ikut bergeser.
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={current.name || 'Pratinjau media'} onClick={onClose}>
      <div className="lightbox-top" onClick={(e) => e.stopPropagation()}>
        <RippleButton className="icon-btn" onClick={onClose} aria-label="Tutup">
          <X size={22} />
        </RippleButton>
        <span className="lightbox-name">
          {current.name}
          {items.length > 1 ? ` (${index + 1}/${items.length})` : ''}
        </span>
        {current.downloadUrl && (
          <a
            className="lightbox-edit"
            href={current.downloadUrl}
            download={current.name || undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Unduh ${current.name || 'media'}`}
          >
            <Download size={16} />
            Unduh
          </a>
        )}
        {onEdit && !isVideo && (
          <RippleButton className="lightbox-edit" onClick={onEdit}>
            <Crop size={16} />
            Edit
          </RippleButton>
        )}
      </div>
      <div className="lightbox-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {canPrev && (
          <button
            type="button"
            className="lightbox-nav lightbox-nav-prev"
            aria-label="Sebelumnya"
            onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
          >
            <ChevronLeft size={24} />
          </button>
        )}
        {isVideo ? (
          <video
            key={url}
            className="lightbox-video"
            src={url}
            controls
            playsInline
            autoPlay
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <img src={url} alt={current.name} draggable={false} onClick={(e) => e.stopPropagation()} />
        )}
        {canNext && (
          <button
            type="button"
            className="lightbox-nav lightbox-nav-next"
            aria-label="Berikutnya"
            onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
          >
            <ChevronRight size={24} />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
