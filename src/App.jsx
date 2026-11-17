import { useState, useEffect, useRef } from 'react';
import './App.css';
import Header from './components/Header';
import Welcome from './components/Welcome';
import ChatView from './components/ChatView';
import ChatInput from './components/ChatInput';
import Drawer from './components/Drawer';
import AttachSheet from './components/AttachSheet';
import ModelSheet from './components/ModelSheet';
import SettingsSheet from './components/SettingsSheet';
import AccountSheet from './components/AccountSheet';
import { useChats } from './hooks/useChats';
import { sendToAIStream, apiStatus } from './services/ai';
import { MODELS, DEFAULT_MODEL } from './data/models';

const USER_NAME = 'Xixi';

export default function App() {
  const { chats, createChat, addMessage, updateLastMessage, togglePin, renameChat, deleteChat } = useChats();
  const [activeId, setActiveId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheet, setSheet] = useState(null); // 'attach' | 'model' | null
  const [model, setModel] = useState(() => localStorage.getItem('model') || DEFAULT_MODEL);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [account, setAccount] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system');
  const [font, setFont] = useState(() => localStorage.getItem('font') || 'Default');
  const abortRef = useRef(null);

  // Terapkan tema ke <html>
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Terapkan gaya font ke <body>
  useEffect(() => {
    const map = { Default: '', Serif: 'var(--font-serif)', Mono: 'var(--font-mono)', Rounded: 'var(--font-round)' };
    document.body.style.fontFamily = map[font] || '';
    localStorage.setItem('font', font);
  }, [font]);

  // status backend/akun agy
  useEffect(() => {
    apiStatus().then(setAccount).catch(() => {});
  }, [accountOpen]);

  const active = chats.find(c => c.id === activeId);
  const modelName = MODELS.find(m => m.id === model)?.name || model;
  useEffect(() => { localStorage.setItem('model', model); }, [model]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && abortRef.current) {
        event.preventDefault();
        abortRef.current.abort();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const newChat = () => { setActiveId(null); setDrawerOpen(false); };

  async function handleSend(input) {
    // ChatInput mengirim { text, files }; tetap dukung string biasa
    const text = typeof input === 'string' ? input : (input?.text ?? '');
    const files = input?.files || attachments;
    if ((!text.trim() && !files.length) || loading) return;
    setAttachments([]);
    const userMsg = { role: 'user', content: text, attachments: files.map(f => ({ name: f.name, type: f.type })) };
    const history = [...(active?.messages ?? []), userMsg];

    let id = activeId;
    if (!id) { id = createChat(text); setActiveId(id); }
    addMessage(id, userMsg);

    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // placeholder jawaban AI: diisi bertahap oleh stream (langkah proses + teks)
    addMessage(id, { role: 'assistant', content: '', steps: [], streaming: true, status: 'Menyiapkan…', startedAt: Date.now() });
    const upd = (fn) => updateLastMessage(id, m => (m.role === 'assistant' ? { ...m, ...fn(m) } : m));
    const t0 = Date.now();
    try {
      const reply = await sendToAIStream({ chatId: id, model, text, files, signal: controller.signal }, (ev) => {
        if (ev.type === 'queued') upd(() => ({ status: 'Menunggu antrean…' }));
        else if (ev.type === 'start') upd(() => ({ status: 'Berpikir…' }));
        else if (ev.type === 'step') upd(m => {
          const steps = m.steps.slice();
          const k = steps.findIndex(s => s.id === ev.step.id);
          if (k >= 0) steps[k] = { ...steps[k], ...ev.step }; else steps.push(ev.step);
          const st = ev.step.status === 'running' ? ev.step.label : 'Berpikir…';
          return { steps, status: st };
        });
        else if (ev.type === 'delta') upd(m => ({ content: m.content + ev.text, status: 'Menulis jawaban…' }));
      });
      upd(() => ({ content: reply.text, streaming: false, durationSec: reply.durationSec ?? Math.round((Date.now() - t0) / 1000) }));
    } catch (err) {
      if (err.name === 'AbortError') {
        upd(m => ({ content: m.content ? m.content + '\n\n⏹️ Proses dibatalkan.' : '⏹️ Proses dibatalkan.', streaming: false, status: 'Dibatalkan', cancelled: true, durationSec: Math.round((Date.now() - t0) / 1000) }));
      } else {
        upd(m => ({ content: (m.content ? m.content + '\n\n' : '') + 'Error: ' + err.message, streaming: false, durationSec: Math.round((Date.now() - t0) / 1000) }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
    }
  }

  const handleStop = () => abortRef.current?.abort();

  return (
    <div className="app">
      <Header
        title={active?.title ?? 'AntiGPT'}
        onMenu={() => setDrawerOpen(true)} onNewChat={newChat}
      />

      <main className="content">
        {active ? <ChatView messages={active.messages} chatId={active.id} /> : <Welcome name={USER_NAME} />}
      </main>

      <div className="input-wrap">
        <ChatInput
          isNewChat={!active}
          modelName={modelName} attachments={attachments}
          onRemoveAttachment={(i) => setAttachments(a => a.filter((_, j) => j !== i))}
          onSend={handleSend} onStop={handleStop} disabled={loading}
          onOpenAttach={() => setSheet('attach')} onOpenModel={() => setSheet('model')}
        />
      </div>

      <Drawer
        open={drawerOpen} chats={chats} activeId={activeId} userName={USER_NAME}
        onClose={() => setDrawerOpen(false)}
        onSelect={id => { setActiveId(id); setDrawerOpen(false); }}
        onNewChat={newChat} onTogglePin={togglePin} onRename={renameChat}
        onDelete={id => { deleteChat(id); if (id === activeId) setActiveId(null); }}
        onOpenSettings={() => { setDrawerOpen(false); setSettingsOpen(true); }}
        onOpenAccount={() => { setDrawerOpen(false); setAccountOpen(true); }}
        loggedIn={account?.loggedIn}
      />

      <AttachSheet open={sheet === 'attach'} onClose={() => setSheet(null)}
        onPick={files => setAttachments(a => [...a, ...files])} />

      <ModelSheet open={sheet === 'model'} onClose={() => setSheet(null)}
        model={model} onChangeModel={setModel} />

      <SettingsSheet
        open={settingsOpen} onClose={() => setSettingsOpen(false)}
        theme={theme} onChangeTheme={setTheme}
        font={font} onChangeFont={setFont}
      />

      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} onChanged={setAccount} />
    </div>
  );
}
