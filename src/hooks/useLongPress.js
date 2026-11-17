import { useRef } from 'react';

export function useLongPress(onLongPress, onClick, ms = 500) {
  const timer = useRef();
  const fired = useRef(false);

  const start = (e) => {
    fired.current = false;
    const t = e.touches?.[0] ?? e;
    const pos = { x: t.clientX, y: t.clientY };
    timer.current = setTimeout(() => {
      fired.current = true;
      onLongPress(pos);
    }, ms);
  };
  const clear = () => clearTimeout(timer.current);

  return {
    onTouchStart: start,
    onTouchMove: clear,
    onTouchEnd: (e) => { clear(); if (fired.current) e.preventDefault(); },
    onMouseDown: start,
    onMouseUp: clear,
    onMouseLeave: clear,
    onClick: () => { if (!fired.current) onClick?.(); },
    onContextMenu: (e) => e.preventDefault(),
  };
}
