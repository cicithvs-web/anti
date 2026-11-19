import { useState, useEffect, useRef, useCallback } from 'react';
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
import AuthGate from './components/AuthGate';
import ImageEditor from './components/ImageEditor';
import ImageLightbox from './components/ImageLightbox';
import { isEditableImage } from './services/imageEdit';
import { useChats } from './hooks/useChats';
import {
  apiStatus, authCheck, AUTH_EVENT, startChatStream, resumeChatStream, formatDone,
  stopChat as apiStopChat, deleteChatOnServer, cachedModels, loadModels,
} from './services/ai';
import { MODELS, DEFAULT_MODEL, DEFAULT_UPLOAD_LIMITS } from './data/models';

const USER_NAME = 'Xixi';
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

export default function App() {
  const { chats, createChat, addMessage, updateLastMessage, updateLastUserMessage, togglePin, renameChat, setChatModel, deleteChat } = useChats();
  const [authed, setAuthed] = useState(null); // null = cek, false = minta token, true = boleh
  const [activeId, setActiveId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheet, setSheet] = useState(null); // 'attach' | 'model' | null
  // model default untuk chat BARU (= model terakhir yang dipilih)
  const [model, setModel] = useState(() => localStorage.getItem('model') || DEFAULT_MODEL);
  const [models, setModels] = useState(() => cachedModels()?.list || MODELS);
  const [attachments, setAttachments] = useState([]);
  const [attachError, setAttachError] = useState('');
  // Foto yang sedang dibuka di editor: { item, index } — index null = foto baru, angka = lampiran yang diedit ulang
  const [editing, setEditing] = useState(null);
  // Lampiran gambar yang sedang dibuka di lightbox (objek lampiran, bukan index, supaya aman saat daftar berubah)
  const [preview, setPreview] = useState(null);
  // status proses per chat (bukan global), supaya tombol stop tidak ikut ke chat lain
  const [loadingIds, setLoadingIds] = useState(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [account, setAccount] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system');
  const [font, setFont] = useState(() => localStorage.getItem('font') || 'Default');
  const abortRef = useRef(new Map()); // chatId -> AbortController (koneksi stream di browser)
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const setChatLoading = (id, on) => setLoadingIds(prev => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  // ---- auth ----
  useEffect(() => {
    authCheck().then(r => setAuthed(!!r.authed)).catch(() => setAuthed(false));
    const onAuth = () => setAuthed(false);
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, []);

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
    if (authed) apiStatus().then(setAccount).catch(() => {});
  }, [accountOpen, authed]);

  // daftar model: dari cache sessionStorage, diambil ulang kalau kadaluarsa / akun berganti
  const refreshModels = useCallback((force = false) => {
    loadModels({ email: account?.email ?? undefined, force })
      .then(list => { if (list?.length) setModels(list); })
      .catch(() => {});
  }, [account?.email]);
  useEffect(() => { if (authed) refreshModels(); }, [authed, refreshModels]);

  const active = chats.find(c => c.id === activeId);
  const chatModel = active?.model || model; // model per chat
  const modelName = models.find(m => m.id === chatModel)?.name
    || MODELS.find(m => m.id === chatModel)?.name || chatModel;
  useEffect(() => { localStorage.setItem('model', model); }, [model]);

  const changeModel = (id) => {
    setModel(id);
    if (active) setChatModel(active.id, id);
  };

  // ---- stop: hentikan job di server + putus stream di browser ----
  const stopChat = (id) => {
    if (!id) return;
    apiStopChat(id).catch(() => {});
    abortRef.current.get(id)?.abort();
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      const id = activeIdRef.current;
      if (event.key === 'Escape' && id && abortRef.current.has(id)) {
        event.preventDefault();
        stopChat(id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const newChat = () => { setActiveId(null); setDrawerOpen(false); };

  // Ikuti job chat di server sampai `done`. Koneksi putus → sambung ulang otomatis (replay dari seq terakhir).
  // open(signal, onEvent) = request pertama (POST mulai job, atau GET resume).
  async function followJob(id, open, { resetOnFirstEvent = false } = {}) {
    setChatLoading(id, true);
    const controller = new AbortController();
    const { signal } = controller;
    abortRef.current.set(id, controller);
    const upd = (fn) => updateLastMessage(id, m => (m.role === 'assistant' ? { ...m, ...fn(m) } : m));
    const t0 = Date.now();
    let lastSeq = -1;
    let needReset = resetOnFirstEvent;

    const onEvent = (ev) => {
      if (typeof ev.seq === 'number') {
        if (ev.seq <= lastSeq) return; // event duplikat saat replay
        lastSeq = ev.seq;
      }
      if (needReset) { needReset = false; upd(() => ({ content: '', steps: [] })); }
      if (ev.type === 'uploads') {
        // tempel lokasi file di server ke lampiran pesan user (urutan sama dengan saat dikirim)
        updateLastUserMessage(id, m => {
          if (!m.attachments?.length || !Array.isArray(ev.files)) return m;
          // dicocokkan per urutan (nama dari server bisa beda encoding untuk nama non-ASCII)
          if (ev.files.length !== m.attachments.length) return m;
          return { ...m, attachments: m.attachments.map((a, k) => ({ ...a, stored: ev.files[k].stored })) };
        });
        return;
      }
      if (ev.type === 'queued') upd(() => ({ status: 'Menunggu antrean…' }));
      else if (ev.type === 'start') upd(() => ({ status: 'Berpikir…' }));
      else if (ev.type === 'step') upd(m => {
        const steps = (m.steps || []).slice();
        const k = steps.findIndex(s => s.id === ev.step.id);
        if (k >= 0) steps[k] = { ...steps[k], ...ev.step }; else steps.push(ev.step);
        const st = ev.step.status === 'running' ? ev.step.label : 'Berpikir…';
        return { steps, status: st };
      });
      else if (ev.type === 'delta') upd(m => ({ content: (m.content || '') + ev.text, status: 'Menulis jawaban…' }));
    };

    const markCancelled = () => upd(m => ({
      content: m.content ? m.content + '\n\n⏹️ Proses dibatalkan.' : '⏹️ Proses dibatalkan.',
      streaming: false, status: 'Dibatalkan', cancelled: true,
      durationSec: m.durationSec ?? Math.round((Date.now() - (m.startedAt || t0)) / 1000),
    }));

    try {
      let res = await open(signal, onEvent);
      let tries = 0;
      while (!res.done && !res.none) {
        if (++tries > 30) throw new Error('Koneksi terputus sebelum jawaban selesai');
        upd(() => ({ status: 'Menyambung ulang…' }));
        await sleep(Math.min(1000 * tries, 5000), signal);
        const before = lastSeq;
        try {
          res = await resumeChatStream({ chatId: id, since: lastSeq + 1, signal }, onEvent);
          // Selama stream masih hidup (termasuk ping), reset counter gagal reconnect
          if (res.alive || lastSeq > before) tries = 0;
        } catch (e) {
          if (e.name === 'AbortError' || e.status === 401) throw e;
          res = {};
        }
      }
      if (res.none) {
        upd(m => ({
          content: m.content || 'Proses sebelumnya terputus. Kirim ulang pesan untuk melanjutkan.',
          streaming: false, status: 'Proses terputus',
        }));
        return;
      }
      if (res.done.cancelled) { markCancelled(); return; }
      const reply = formatDone(res.done);
      upd(m => ({ content: reply.text, streaming: false, durationSec: reply.durationSec ?? Math.round((Date.now() - (m.startedAt || t0)) / 1000) }));
    } catch (err) {
      if (err.name === 'AbortError') markCancelled();
      else upd(m => ({ content: (m.content ? m.content + '\n\n' : '') + 'Error: ' + err.message, streaming: false, durationSec: Math.round((Date.now() - (m.startedAt || t0)) / 1000) }));
    } finally {
      if (abortRef.current.get(id) === controller) abortRef.current.delete(id);
      setChatLoading(id, false);
    }
  }

  // Setelah refresh: sambung ulang ke job yang masih berjalan di server
  const resumedRef = useRef(false);
  useEffect(() => {
    if (authed !== true || resumedRef.current) return;
    resumedRef.current = true;
    for (const c of chats) {
      const last = c.messages[c.messages.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        updateLastMessage(c.id, m => ({ ...m, status: 'Menyambung ulang…' }));
        followJob(c.id, (signal, onEvent) => resumeChatStream({ chatId: c.id, since: 0, signal }, onEvent), { resetOnFirstEvent: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  async function handleSend(input) {
    // ChatInput mengirim { text, files }; tetap dukung string biasa
    const text = typeof input === 'string' ? input : (input?.text ?? '');
    const files = input?.files || attachments;
    if ((!text.trim() && !files.length) || (activeId && loadingIds.has(activeId))) return;
    setAttachments([]);
    setAttachError('');
    const userMsg = { role: 'user', content: text, attachments: files.map(f => ({ name: f.name, type: f.type, size: f.size ?? f.file?.size })) };
    const useModel = active?.model || model;

    let id = activeId;
    if (!id) { id = createChat(text, useModel); setActiveId(id); }
    addMessage(id, userMsg);
    // placeholder jawaban AI: diisi bertahap oleh stream (langkah proses + teks)
    addMessage(id, { role: 'assistant', content: '', steps: [], streaming: true, status: 'Menyiapkan…', startedAt: Date.now() });
    await followJob(id, (signal, onEvent) => startChatStream({ chatId: id, model: useModel, text, files, signal }, onEvent));
  }

  const handleDelete = (id) => {
    abortRef.current.get(id)?.abort();
    deleteChat(id);
    if (id === activeId) setActiveId(null);
    // hapus container sandbox + folder sesi di server
    deleteChatOnServer(id).catch(() => {});
  };

  const uploadLimits = account?.limits || DEFAULT_UPLOAD_LIMITS;
  const pickAttachments = (picked) => {
    const maxFiles = uploadLimits.files || DEFAULT_UPLOAD_LIMITS.files;
    const maxMb = uploadLimits.fileSizeMb || DEFAULT_UPLOAD_LIMITS.fileSizeMb;
    const maxBytes = maxMb * 1024 * 1024;
    let totalBytes = attachments.reduce((sum, f) => sum + (f.size ?? f.file?.size ?? 0), 0);
    const accepted = [];
    const errors = [];
    for (const f of picked) {
      const sz = f.size ?? f.file?.size ?? 0;
      if (sz > maxBytes) {
        errors.push(`"${f.name}" melebihi ${maxMb} MB`);
        continue;
      }
      if (attachments.length + accepted.length >= maxFiles) {
        errors.push(`maksimal ${maxFiles} file per kirim`);
        break;
      }
      if (totalBytes + sz > maxBytes) {
        errors.push(`total ukuran melebihi ${maxMb} MB`);
        continue;
      }
      totalBytes += sz;
      accepted.push(f);
    }
    if (accepted.length) setAttachments(a => [...a, ...accepted]);
    if (errors.length) {
      const prefix = accepted.length ? 'Sebagian file dilewati: ' : 'File ditolak: ';
      setAttachError(prefix + [...new Set(errors)].join('; ') + '.');
    } else {
      setAttachError('');
    }
    return accepted.length;
  };

  // Foto tunggal dari kamera/galeri dibuka di editor dulu; selain itu langsung jadi lampiran.
  const handlePick = (picked, { source } = {}) => {
    if ((source === 'camera' || source === 'photo') && picked.length === 1 && isEditableImage(picked[0])) {
      setEditing({ item: picked[0], index: null });
    } else {
      pickAttachments(picked);
    }
  };

  const closePreview = useCallback(() => setPreview(null), []);

  const toAttachment = (file) => ({ name: file.name, type: file.type, size: file.size, file });

  const finishEdit = (file) => {
    const { index } = editing;
    setEditing(null);
    if (index === null) { pickAttachments([toAttachment(file)]); return; }
    const maxMb = uploadLimits.fileSizeMb || DEFAULT_UPLOAD_LIMITS.fileSizeMb;
    const others = attachments.reduce((sum, f, j) => (j === index ? sum : sum + (f.size ?? f.file?.size ?? 0)), 0);
    if (others + file.size > maxMb * 1024 * 1024) {
      setAttachError(`Hasil edit melebihi total ${maxMb} MB, lampiran tidak diubah.`);
      return;
    }
    setAttachments(a => a.map((f, j) => (j === index ? toAttachment(file) : f)));
    setAttachError('');
  };

  const failEdit = (msg) => {
    const { item, index } = editing;
    setEditing(null);
    if (index === null) {
      if (pickAttachments([item])) setAttachError(`${msg}, dikirim tanpa edit.`);
    } else {
      setAttachError(`${msg}.`);
    }
  };

  const loading = !!activeId && loadingIds.has(activeId);

  if (authed === null) return <div className="app" />;
  if (authed === false) return <AuthGate onSuccess={() => setAuthed(true)} />;

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
          attachError={attachError} onClearAttachError={() => setAttachError('')}
          onRemoveAttachment={(i) => { setAttachments(a => a.filter((_, j) => j !== i)); setAttachError(''); }}
          onPreviewAttachment={(i) => setPreview(attachments[i])}
          onSend={handleSend} onStop={() => stopChat(activeId)} disabled={loading}
          onOpenAttach={() => setSheet('attach')} onOpenModel={() => setSheet('model')}
        />
      </div>

      <Drawer
        open={drawerOpen} chats={chats} activeId={activeId} userName={USER_NAME}
        onClose={() => setDrawerOpen(false)}
        onSelect={id => { setActiveId(id); setDrawerOpen(false); }}
        onNewChat={newChat} onTogglePin={togglePin} onRename={renameChat}
        onDelete={handleDelete}
        onOpenSettings={() => { setDrawerOpen(false); setSettingsOpen(true); }}
        onOpenAccount={() => { setDrawerOpen(false); setAccountOpen(true); }}
        loggedIn={account?.loggedIn}
      />

      <AttachSheet open={sheet === 'attach'} onClose={() => setSheet(null)}
        limits={uploadLimits} onPick={handlePick} />

      <ImageLightbox item={preview} onClose={closePreview}
        onEdit={preview && isEditableImage(preview) ? () => {
          const index = attachments.indexOf(preview);
          setPreview(null);
          if (index >= 0) setEditing({ item: preview, index });
        } : undefined} />

      <ImageEditor item={editing?.item} onDone={finishEdit} onError={failEdit}
        onCancel={() => setEditing(null)} />

      <ModelSheet open={sheet === 'model'} onClose={() => setSheet(null)}
        model={chatModel} list={models} onOpen={() => refreshModels(false)} onChangeModel={changeModel} />

      <SettingsSheet
        open={settingsOpen} onClose={() => setSettingsOpen(false)}
        theme={theme} onChangeTheme={setTheme}
        font={font} onChangeFont={setFont}
      />

      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} onChanged={setAccount} />
    </div>
  );
}
