// Sinkronisasi animasi keyboard (IME) per-frame dari APK Android (WindowInsetsAnimationCompat)
// agar kotak input, welcome, riwayat chat, dan bottom sheet meluncur 60/120fps tanpa resize WebView.

export function installNativeImeBridge() {
  if (typeof window === 'undefined') return () => {};
  const root = document.documentElement;

  let settledCss = 0;
  let animActive = false;
  let chatState = null;

  const toCss = (rawPx) => {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(0, Math.round(((Number(rawPx) || 0) / dpr) * 100) / 100);
  };

  const setVars = (pad, y, total, animating) => {
    root.style.setProperty('--ime-pad', pad + 'px');
    root.style.setProperty('--ime-y', y + 'px');
    root.style.setProperty('--ime-total', total + 'px');
    if (animating) root.dataset.imeAnim = '1';
    else delete root.dataset.imeAnim;
  };

  const setElShift = (el, shiftPx) => {
    if (!el) return;
    if (shiftPx > 0.01) {
      el.style.transform = `translate3d(0, ${-shiftPx}px, 0)`;
    } else {
      el.style.transform = '';
    }
  };

  const findChatEls = () => {
    const box = document.querySelector('.chat-scroll');
    const view = box?.querySelector('.chat-view');
    const btn = document.querySelector('.scroll-bottom-wrap');
    return { box, view, btn };
  };

  const resetChatTransform = () => {
    if (chatState?.view) chatState.view.style.transform = '';
    if (chatState?.btn) chatState.btn.style.transform = '';
    chatState = null;
  };

  const applyChatFrame = (yCss) => {
    if (!chatState) return;
    const { view, btn, mode, emptyBelow, stick, startY, startShift } = chatState;
    let shift = 0;
    if (mode === 'open') {
      if (stick) shift = Math.max(0, yCss - emptyBelow);
    } else if (mode === 'close') {
      shift = startY > 0 ? startShift * (yCss / startY) : 0;
    }
    setElShift(view, shift);
    setElShift(btn, yCss);
  };

  const handler = (phase, rawPx, rawTargetPx) => {
    const px = toCss(rawPx);
    const target = toCss(rawTargetPx);

    if (phase === 'start') {
      const opening = target > px || (target === px && target > settledCss);

      // Mulai animasi collapse 2->1 baris serentak saat keyboard mulai turun (gaya Claude)
      if (!opening && target < 1) {
        window.dispatchEvent(new CustomEvent('antigpt:ime-hide'));
      }

      const { box, view, btn } = findChatEls();

      if (settledCss > 0) {
        // Lepas --ime-pad ke 0 & pindahkan ke --ime-y di 1 frame sinkron agar 0px loncat
        const prevScrollTop = box ? box.scrollTop : 0;
        const startY = px > 0 ? px : settledCss;
        settledCss = 0;
        animActive = true;
        setVars(0, startY, startY, true);

        if (box && view) {
          const newScrollTop = box.scrollTop;
          const actualShift = Math.max(0, prevScrollTop - newScrollTop);
          chatState = { box, view, btn, mode: 'close', startY, startShift: actualShift };
          applyChatFrame(startY);
        } else {
          resetChatTransform();
        }
      } else if (opening) {
        animActive = true;
        if (box && view) {
          const emptyBelow = Math.max(0, box.clientHeight - box.scrollHeight);
          const nearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
          chatState = { box, view, btn, mode: 'open', emptyBelow, stick: nearBottom };
        } else {
          resetChatTransform();
        }
        setVars(0, px, px, true);
        applyChatFrame(px);
      } else {
        // Interupsi saat animasi sedang berlangsung (mis. buka setengah lalu langsung tutup)
        animActive = true;
        setVars(0, px, px, true);
        applyChatFrame(px);
      }
      return;
    }

    if (phase === 'progress') {
      if (!animActive) animActive = true;
      setVars(0, px, px, true);
      applyChatFrame(px);
      return;
    }

    if (phase === 'end' || phase === 'settle') {
      const wasOpenStick = chatState?.mode === 'open' && chatState?.stick;
      const { box } = findChatEls();
      animActive = false;
      settledCss = px;
      resetChatTransform();
      setVars(px, 0, px, false);

      if (px > 0 && box && wasOpenStick) {
        box.scrollTop = box.scrollHeight;
      }
      if (px < 1) {
        window.dispatchEvent(new CustomEvent('antigpt:ime-hide'));
      }
    }
  };

  window.__antigptIme = handler;
  return () => {
    if (window.__antigptIme === handler) delete window.__antigptIme;
    resetChatTransform();
    setVars(0, 0, 0, false);
  };
}
