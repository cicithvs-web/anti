import { useEffect, useState } from 'react';

const KEY = 'chats_v1';
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function useChats() {
  const [chats, setChats] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
      return saved.map(chat => ({
        ...chat,
        messages: (chat.messages || []).map(message => message.streaming
          ? {
              ...message,
              streaming: false,
              status: 'Proses terputus',
              content: message.content || 'Proses sebelumnya terputus. Kirim ulang pesan untuk melanjutkan.',
            }
          : message),
      }));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(chats));
  }, [chats]);

  const update = (id, fn) => setChats(cs => cs.map(c => (c.id === id ? fn(c) : c)));

  const createChat = (firstMsg) => {
    const chat = { id: newId(), title: firstMsg.slice(0, 40), pinned: false, messages: [], updatedAt: Date.now() };
    setChats(cs => [chat, ...cs]);
    return chat.id;
  };
  const addMessage = (id, msg) =>
    update(id, c => ({ ...c, messages: [...c.messages, msg], updatedAt: Date.now() }));
  // ubah pesan terakhir (dipakai saat streaming jawaban AI)
  const updateLastMessage = (id, fn) =>
    update(id, c => {
      if (!c.messages.length) return c;
      const ms = c.messages.slice();
      ms[ms.length - 1] = fn(ms[ms.length - 1]);
      return { ...c, messages: ms, updatedAt: Date.now() };
    });
  const togglePin = (id) => update(id, c => ({ ...c, pinned: !c.pinned }));
  const renameChat = (id, title) => update(id, c => ({ ...c, title }));
  const deleteChat = (id) => setChats(cs => cs.filter(c => c.id !== id));

  return { chats, createChat, addMessage, updateLastMessage, togglePin, renameChat, deleteChat };
}
