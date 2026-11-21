import { useEffect, useRef, useState } from 'react';

const KEY = 'chats_v1';
const SAVE_INTERVAL = 1000; // simpan paling sering 1x per detik (bukan tiap potongan teks stream)
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Kurangi ukuran sebelum disimpan: output tool (bisa 1.5KB per langkah) hanya dipertahankan
// untuk beberapa pesan terakhir per chat. Mode agresif (saat QuotaExceeded) juga memangkas teks berpikir lama.
function compact(chats, aggressive = false) {
  const KEEP = aggressive ? 0 : 6;
  return chats.map(chat => {
    const n = chat.messages?.length || 0;
    return {
      ...chat,
      messages: (chat.messages || []).map((m, i) => {
        if (!m.steps?.length || i >= n - KEEP) return m;
        return {
          ...m,
          steps: m.steps.map(s => {
            let next = s;
            if (next.output) next = { ...next, output: null };
            if (aggressive && next.text && next.text.length > 400) {
              next = { ...next, text: next.text.slice(0, 400) + '…' };
            }
            return next;
          }),
        };
      }),
    };
  });
}

function save(chats) {
  try {
    localStorage.setItem(KEY, JSON.stringify(compact(chats)));
  } catch {
    // QuotaExceededError → coba versi yang lebih ramping; jangan sampai bikin app crash
    try { localStorage.setItem(KEY, JSON.stringify(compact(chats, true))); }
    catch (e) { console.warn('[chats] gagal menyimpan ke localStorage:', e?.name || e); }
  }
}

export function useChats() {
  const [chats, setChats] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
      return saved.map(chat => ({
        ...chat,
        // pesan yang masih `streaming` dibiarkan: App akan mencoba menyambung ulang ke job di server
        messages: (chat.messages || []).map(m => (m.id ? m : { ...m, id: newId() })),
      }));
    } catch {
      return [];
    }
  });

  // ---- simpan ber-throttle ----
  const latest = useRef(chats);
  const timer = useRef(null);
  latest.current = chats;
  useEffect(() => {
    if (timer.current) return; // sudah ada jadwal simpan; nanti pakai state terbaru
    timer.current = setTimeout(() => { timer.current = null; save(latest.current); }, SAVE_INTERVAL);
  }, [chats]);
  useEffect(() => {
    const flush = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      save(latest.current);
    };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
      flush();
    };
  }, []);

  const update = (id, fn) => setChats(cs => cs.map(c => (c.id === id ? fn(c) : c)));

  const createChat = (firstMsg, model) => {
    const chat = { id: newId(), title: firstMsg.slice(0, 40) || 'Chat baru', pinned: false, model: model || null, messages: [], updatedAt: Date.now() };
    setChats(cs => [chat, ...cs]);
    return chat.id;
  };
  const addMessage = (id, msg) =>
    update(id, c => ({ ...c, messages: [...c.messages, { id: newId(), ...msg }], updatedAt: Date.now() }));
  // ubah pesan terakhir (dipakai saat streaming jawaban AI)
  const updateLastMessage = (id, fn) =>
    update(id, c => {
      if (!c.messages.length) return c;
      const ms = c.messages.slice();
      ms[ms.length - 1] = fn(ms[ms.length - 1]);
      return { ...c, messages: ms, updatedAt: Date.now() };
    });
  // ubah pesan user terakhir (dipakai untuk menempelkan info upload dari server)
  const updateLastUserMessage = (id, fn) =>
    update(id, c => {
      const k = c.messages.map(m => m.role).lastIndexOf('user');
      if (k < 0) return c;
      const ms = c.messages.slice();
      ms[k] = fn(ms[k]);
      return { ...c, messages: ms };
    });
  const togglePin = (id) => update(id, c => ({ ...c, pinned: !c.pinned }));
  const renameChat = (id, title) => update(id, c => ({ ...c, title }));
  const setChatModel = (id, model) => update(id, c => ({ ...c, model }));
  const deleteChat = (id) => setChats(cs => cs.filter(c => c.id !== id));

  return { chats, createChat, addMessage, updateLastMessage, updateLastUserMessage, togglePin, renameChat, setChatModel, deleteChat };
}
