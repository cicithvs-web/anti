import { useRef, useState, useCallback } from 'react';

/**
 * Tombol dengan efek ripple ala Material Design.
 * Pakai CSS class .btn-base (App.css) untuk transisi & active squish.
 */
export default function RippleButton({ className = '', children, onClick, onPointerDown, ...props }) {
  const ref = useRef(null);
  const [ripples, setRipples] = useState([]);
  const idRef = useRef(0);

  const spawnRipple = useCallback((e) => {
    const btn = ref.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const x = (e.clientX || rect.left + rect.width / 2) - rect.left;
    const y = (e.clientY || rect.top + rect.height / 2) - rect.top;
    const size = Math.max(rect.width, rect.height) * 2;
    const id = ++idRef.current;
    setRipples(r => [...r, { id, x, y, size }]);
    // bersihkan ripple setelah animasinya selesai
    setTimeout(() => setRipples(r => r.filter(rp => rp.id !== id)), 650);
  }, []);

  return (
    <button
      ref={ref}
      className={'btn-base ' + className}
      onPointerDown={(e) => { spawnRipple(e); onPointerDown?.(e); }}
      onClick={(e) => { onClick?.(e); }}
      {...props}
    >
      {children}
      {ripples.map(r => (
        <span
          key={r.id}
          className="ripple"
          style={{ left: r.x - r.size / 2, top: r.y - r.size / 2, width: r.size, height: r.size }}
        />
      ))}
    </button>
  );
}
