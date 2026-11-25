import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageCircleQuestion, Loader } from 'lucide-react';
import './App.css';
import Header from './components/Header';
import Welcome from './components/Welcome';
import ChatView from './components/ChatView';
import ChatInput from './components/ChatInput';
import Drawer from './components/Drawer';
import AttachSheet from './components/AttachSheet';
import ModelSheet from './components/ModelSheet';
import QuestionSheet from './components/QuestionSheet';
import SettingsSheet from './components/SettingsSheet';
import AccountSheet from './components/AccountSheet';
import AuthGate from './components/AuthGate';
import ImageEditor from './components/ImageEditor';
import ImageLightbox from './components/ImageLightbox';
import { isEditableImage } from './services/imageEdit';
import { installNativeImeBridge } from './utils/nativeIme';
import { useChats, newId } from './hooks/useChats';
import {
  apiStatus, authCheck, AUTH_EVENT, startChatStream, resumeChatStream, formatDone,
  stopChat as apiStopChat, answerQuestion as apiAnswerQuestion, deleteChatOnServer, cachedModels, loadModels,
  getAdminChats, getAdminChat, updateAdminChat, sleepAdminChat,
} from './services/ai';
import { MODELS, DEFAULT_MODEL, DEFAULT_UPLOAD_LIMITS } from './data/models';

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
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [attachError, setAttachError] = useState('');
  // Foto yang sedang dibuka di editor: { item, index } — index null = foto baru, angka = lampiran yang diedit ulang
  const [editing, setEditing] = useState(null);
  // Lampiran gambar yang sedang dibuka di lightbox (objek lampiran, bukan index, supaya aman saat daftar berubah)
  const [preview, setPreview] = useState(null);
  // status proses per chat (bukan global), supaya tombol stop tidak ikut ke chat lain
  const [loadingIds, setLoadingIds] = useState(() => new Set());
  // pertanyaan interaktif AI (ask_question) yang sedang menunggu jawaban per chat: { [chatId]: question }
  const [pendingQuestions, setPendingQuestions] = useState({});
  // ID pertanyaan yang sedang diminimize user agar bisa membaca chat sebelum menjawab
  const [dismissedQuestionId, setDismissedQuestionId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [account, setAccount] = useState(null);
  // Daftar chat dari VPS khusus mode admin (disimpan di memori saja, TIDAK pernah ditulis ke localStorage)
  const [adminChats, setAdminChats] = useState([]);
  const [adminRefreshing, setAdminRefreshing] = useState(false);
  const [loadingChatId, setLoadingChatId] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system');
  const [font, setFont] = useState(() => localStorage.getItem('font') || 'Default');
  const abortRef = useRef(new Map()); // chatId -> { controller, isServer }
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const localChatsRef = useRef(chats);
  localChatsRef.current = chats;
  const adminChatsRef = useRef(adminChats);
  adminChatsRef.current = adminChats;
  const isAdminView = !!account?.isAdmin && !!account?.adminEnabled;
  const isAdminViewRef = useRef(isAdminView);
  isAdminViewRef.current = isAdminView;
  const visibleChats = isAdminView ? adminChats : chats;
  const activeQuestion = activeId ? (pendingQuestions[activeId] || null) : null;
  const questionOpen = !!activeQuestion && dismissedQuestionId !== activeQuestion.id;
  const questionOpenRef = useRef({ open: false, id: null });
  questionOpenRef.current = { open: questionOpen, id: activeQuestion?.id || null };
  const setChatLoading = useCallback((id, on) => setLoadingIds(prev => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  }), []);
  const clearChatQuestion = useCallback((id, qid = null) => {
    setPendingQuestions(prev => {
      if (!prev[id]) return prev;
      if (qid && prev[id].id !== qid) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const updateAdminChatState = useCallback((id, fn) => {
    setAdminChats(cs => cs.map(c => (c.id === id ? fn(c) : c)));
  }, []);

  const storeAddMessage = useCallback((id, msg, isServer) => {
    if (isServer) {
      updateAdminChatState(id, c => ({
        ...c,
        messages: [...(c.messages || []), { id: newId(), ...msg }],
        updatedAt: Date.now(),
        loaded: true,
      }));
    } else {
      addMessage(id, msg);
    }
  }, [addMessage, updateAdminChatState]);

  const storeUpdateLastMessage = useCallback((id, fn, isServer) => {
    if (isServer) {
      updateAdminChatState(id, c => {
        const list = c.messages || [];
        if (!list.length) return c;
        const ms = list.slice();
        ms[ms.length - 1] = fn(ms[ms.length - 1]);
        return { ...c, messages: ms, updatedAt: Date.now() };
      });
    } else {
      updateLastMessage(id, fn);
    }
  }, [updateLastMessage, updateAdminChatState]);

  const storeUpdateLastUserMessage = useCallback((id, fn, isServer) => {
    if (isServer) {
      updateAdminChatState(id, c => {
        const list = c.messages || [];
        const k = list.map(m => m.role).lastIndexOf('user');
        if (k < 0) return c;
        const ms = list.slice();
        ms[k] = fn(ms[k]);
        return { ...c, messages: ms };
      });
    } else {
      updateLastUserMessage(id, fn);
    }
  }, [updateLastUserMessage, updateAdminChatState]);

  // ---- auth ----
  useEffect(() => {
    authCheck().then(r => setAuthed(!!r.authed)).catch(() => setAuthed(false));
    const onAuth = () => setAuthed(false);
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, []);

  // Terapkan tema ke <html>, sinkronkan <meta name="theme-color">, dan kabari APK Android (status/nav bar)
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const syncChrome = () => {
      const dark = theme === 'dark' || (theme === 'system' && !!mq?.matches);
      const bg = dark ? '#171614' : '#faf9f5';
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', bg);
      try { window.AntiGPTNative?.setTheme?.(bg, dark); } catch {}
    };
    syncChrome();
    if (theme === 'system' && mq?.addEventListener) {
      mq.addEventListener('change', syncChrome);
      return () => mq.removeEventListener('change', syncChrome);
    }
  }, [theme]);

  // Sinkronisasi animasi keyboard (IME) per-frame dari APK Android
  useEffect(() => installNativeImeBridge(), []);

  // Handler tombol Back Android (dipanggil oleh APK native sebelum keluar)
  const uiLayersRef = useRef({});
  uiLayersRef.current = { editing, preview, questionOpen, activeQuestionId: activeQuestion?.id || null, settingsOpen, accountOpen, sheet, drawerOpen };
  useEffect(() => {
    window.__antigptHandleBack = () => {
      const ev = new CustomEvent('antigpt:back', { cancelable: true });
      window.dispatchEvent(ev);
      if (ev.defaultPrevented) return true;
      const s = uiLayersRef.current;
      if (s.editing) { setEditing(null); return true; }
      if (s.preview) { setPreview(null); return true; }
      if (s.questionOpen && s.activeQuestionId) { setDismissedQuestionId(s.activeQuestionId); return true; }
      if (s.settingsOpen) { setSettingsOpen(false); return true; }
      if (s.accountOpen) { setAccountOpen(false); return true; }
      if (s.sheet) { setSheet(null); return true; }
      if (s.drawerOpen) { setDrawerOpen(false); return true; }
      return false;
    };
    return () => { delete window.__antigptHandleBack; };
  }, []);

  // Terapkan gaya font ke <body>
  useEffect(() => {
    const map = { Default: '', Serif: 'var(--font-serif)', Mono: 'var(--font-mono)', Rounded: 'var(--font-round)' };
    document.body.style.fontFamily = map[font] || '';
    localStorage.setItem('font', font);
  }, [font]);

  // status backend/akun agy
  useEffect(() => {
    if (authed) apiStatus().then(setAccount).catch(() => {});
    else setAccount(null);
  }, [accountOpen, authed]);

  const refreshAdminChats = useCallback(async ({ silent = false } = {}) => {
    if (!isAdminViewRef.current) return;
    if (!silent) setAdminRefreshing(true);
    try {
      const r = await getAdminChats();
      if (!isAdminViewRef.current) return;
      if (r?.ok && Array.isArray(r.chats)) {
        setAccount(prev => (prev ? { ...prev, running: r.running, queued: r.queued, maxParallel: r.maxParallel } : prev));
        setAdminChats(prev => {
          const prevMap = new Map(prev.map(c => [c.id, c]));
          const seen = new Set();
          const merged = r.chats.map(item => {
            seen.add(item.id);
            const old = prevMap.get(item.id);
            const streamingLocally = abortRef.current.has(item.id);
            const keepMessages = !!old && (streamingLocally || old.loaded);
            return {
              ...item,
              // Pertahankan status live lokal jika tab ini sendiri sedang mem-follow stream-nya
              jobStatus: item.jobStatus || (streamingLocally ? (old?.jobStatus || 'running') : null),
              jobDetail: item.jobDetail || (streamingLocally ? old?.jobDetail : null),
              messages: keepMessages ? (old.messages || []) : (old?.messages || []),
              loaded: keepMessages ? !!old.loaded : false,
            };
          });
          // Pertahankan chat baru yang baru saja dimulai admin di tab ini sebelum folder sesi selesai dibuat
          for (const old of prev) {
            if (!seen.has(old.id) && abortRef.current.has(old.id)) merged.unshift(old);
          }
          return merged;
        });
      }
    } catch (e) {
      if (e?.status === 403) setAdminChats([]);
    } finally {
      if (!silent) setAdminRefreshing(false);
    }
  }, []);

  // Bersihkan seluruh data chat server dari memori segera saat keluar/kunci kembali mode admin
  useEffect(() => {
    if (authed && isAdminView) {
      refreshAdminChats();
      return;
    }
    for (const [id, entry] of [...abortRef.current.entries()]) {
      if (entry?.isServer) {
        entry.controller.abort('detach');
        abortRef.current.delete(id);
      }
    }
    setAdminChats([]);
    setLoadingChatId(null);
    const localIds = new Set(localChatsRef.current.map(c => c.id));
    setActiveId(prev => (prev && localIds.has(prev) ? prev : null));
    setLoadingIds(prev => {
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (localIds.has(id)) next.add(id); else changed = true;
      }
      return changed ? next : prev;
    });
    setPendingQuestions(prev => {
      let changed = false;
      const next = {};
      for (const [id, q] of Object.entries(prev)) {
        if (localIds.has(id)) next[id] = q; else changed = true;
      }
      return changed ? next : prev;
    });
  }, [authed, isAdminView, refreshAdminChats]);

  // Segarkan daftar obrolan server secara berkala di mode admin (lebih cepat saat Drawer terbuka)
  useEffect(() => {
    if (!authed || !isAdminView) return;
    if (drawerOpen) refreshAdminChats({ silent: true });
    const ms = drawerOpen ? 8_000 : 25_000;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refreshAdminChats({ silent: true });
    }, ms);
    return () => clearInterval(t);
  }, [authed, isAdminView, drawerOpen, refreshAdminChats]);

  // daftar model: dari cache sessionStorage (TTL 10 menit), diambil ulang kalau kadaluarsa / akun berganti / klik refresh
  const refreshModels = useCallback((force = false) => {
    if (force) setModelsRefreshing(true);
    return loadModels({ email: account?.email ?? undefined, force })
      .then(list => {
        if (list?.length) {
          setModels(list);
          if (account?.loggedIn) {
            setModel(cur => (list.some(m => m.id === cur) ? cur : list[0].id));
          }
        }
      })
      .catch(() => {})
      .finally(() => { if (force) setModelsRefreshing(false); });
  }, [account?.email, account?.loggedIn]);
  useEffect(() => { if (authed) refreshModels(); }, [authed, refreshModels]);

  const active = visibleChats.find(c => c.id === activeId);
  const chatModel = active?.model || model; // model per chat
  const modelName = models.find(m => m.id === chatModel)?.name
    || MODELS.find(m => m.id === chatModel)?.name || chatModel;
  useEffect(() => { localStorage.setItem('model', model); }, [model]);

  const changeModel = (id) => {
    setModel(id);
    if (!active) return;
    if (isAdminView) {
      updateAdminChatState(active.id, c => ({ ...c, model: id }));
      updateAdminChat(active.id, { model: id }).catch(() => {});
    } else {
      setChatModel(active.id, id);
    }
  };

  // ---- stop: hentikan job di server + putus stream di browser ----
  const stopChat = (id) => {
    if (!id) return;
    try { window.AntiGPTNative?.unwatchJob?.(id); } catch {}
    apiStopChat(id).catch(() => {});
    abortRef.current.get(id)?.controller.abort();
    if (isAdminViewRef.current) {
      setTimeout(() => refreshAdminChats({ silent: true }), 600);
    }
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (questionOpenRef.current.open) {
        event.preventDefault();
        setDismissedQuestionId(questionOpenRef.current.id);
        return;
      }
      const id = activeIdRef.current;
      if (id && abortRef.current.has(id)) {
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
  async function followJob(id, open, { resetOnFirstEvent = false, isServer = false, title = '' } = {}) {
    setChatLoading(id, true);
    const controller = new AbortController();
    const { signal } = controller;
    abortRef.current.set(id, { controller, isServer });
    const jobTitle = title
      || (isServer ? adminChatsRef.current : localChatsRef.current).find(c => c.id === id)?.title
      || '';
    try { window.AntiGPTNative?.watchJob?.(id, jobTitle, -1); } catch {}
    const upd = (fn) => storeUpdateLastMessage(id, m => (m.role === 'assistant' ? { ...m, ...fn(m) } : m), isServer);
    const updMeta = (patch) => { if (isServer) updateAdminChatState(id, c => ({ ...c, ...patch })); };
    const t0 = Date.now();
    let lastSeq = -1;
    let needReset = resetOnFirstEvent;

    const onEvent = (ev) => {
      if (typeof ev.seq === 'number') {
        if (ev.seq <= lastSeq) return; // event duplikat saat replay
        lastSeq = ev.seq;
        try { window.AntiGPTNative?.updateJobSeq?.(id, lastSeq); } catch {}
      }
      if (needReset) { needReset = false; clearChatQuestion(id); upd(() => ({ content: '', steps: [] })); }
      if (ev.type === 'uploads') {
        // tempel lokasi file di server ke lampiran pesan user (urutan sama dengan saat dikirim)
        storeUpdateLastUserMessage(id, m => {
          if (!m.attachments?.length || !Array.isArray(ev.files)) return m;
          // dicocokkan per urutan (nama dari server bisa beda encoding untuk nama non-ASCII)
          if (ev.files.length !== m.attachments.length) return m;
          return { ...m, attachments: m.attachments.map((a, k) => ({ ...a, stored: ev.files[k].stored })) };
        }, isServer);
        return;
      }
      if (ev.type === 'queued') {
        upd(() => ({ status: 'Menunggu antrean…' }));
        updMeta({ jobStatus: 'queued', jobDetail: 'Menunggu antrean…' });
      } else if (ev.type === 'start') {
        upd(() => ({ status: 'Berpikir…' }));
        updMeta({ jobStatus: 'running', jobDetail: 'Berpikir…' });
      } else if (ev.type === 'status' && ev.text) {
        upd(() => ({ status: ev.text }));
        updMeta({ jobStatus: 'running', jobDetail: ev.text });
      } else if (ev.type === 'thought') upd(m => {
        const steps = (m.steps || []).slice();
        const k = steps.findIndex(s => s.id === ev.id);
        if (k >= 0) steps[k] = { ...steps[k], text: (steps[k].text || '') + ev.text };
        else steps.push({ id: ev.id, kind: 'think', label: 'Berpikir', text: ev.text, status: 'running' });
        return { steps, status: 'Berpikir…' };
      });
      else if (ev.type === 'step') {
        const st = ev.step.status === 'running' ? ev.step.label : 'Berpikir…';
        upd(m => {
          const steps = (m.steps || []).map(s => (s.kind === 'think' && s.status === 'running' ? { ...s, status: 'done' } : s));
          const k = steps.findIndex(s => s.id === ev.step.id);
          if (k >= 0) steps[k] = { ...steps[k], ...ev.step }; else steps.push(ev.step);
          return { steps, status: st };
        });
        updMeta({ jobStatus: 'running', jobDetail: st });
      } else if (ev.type === 'question' && ev.question) {
        setPendingQuestions(prev => ({ ...prev, [id]: ev.question }));
        setDismissedQuestionId(prev => (prev === ev.question.id ? null : prev));
        upd(() => ({ status: 'Menunggu jawabanmu…' }));
        updMeta({ jobStatus: 'question', jobDetail: 'Menunggu jawaban…' });
      } else if (ev.type === 'question_done') {
        clearChatQuestion(id, ev.id);
        upd(() => ({ status: 'Berpikir…' }));
        updMeta({ jobStatus: 'running', jobDetail: 'Berpikir…' });
      } else if (ev.type === 'delta') {
        upd(m => ({ content: (m.content || '') + ev.text, status: 'Menulis jawaban…' }));
        updMeta({ jobStatus: 'running', jobDetail: 'Menulis jawaban…' });
      }
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
      if (signal.aborted && signal.reason === 'detach') return;
      if (err.name === 'AbortError') markCancelled();
      else upd(m => ({ content: (m.content ? m.content + '\n\n' : '') + 'Error: ' + err.message, streaming: false, durationSec: Math.round((Date.now() - (m.startedAt || t0)) / 1000) }));
    } finally {
      if (abortRef.current.get(id)?.controller === controller) abortRef.current.delete(id);
      if (!(signal.aborted && signal.reason === 'detach')) {
        try { window.AntiGPTNative?.unwatchJob?.(id); } catch {}
        clearChatQuestion(id);
        setChatLoading(id, false);
        if (isServer && isAdminViewRef.current) {
          updateAdminChatState(id, c => ({ ...c, jobStatus: null, jobDetail: null }));
          refreshAdminChats({ silent: true });
        }
      }
    }
  }

  // Setelah refresh (mode user biasa): sambung ulang ke job yang masih berjalan di server
  const resumedRef = useRef(false);
  useEffect(() => {
    if (authed !== true || !account || isAdminView || resumedRef.current) return;
    resumedRef.current = true;
    for (const c of chats) {
      const last = c.messages[c.messages.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        updateLastMessage(c.id, m => ({ ...m, status: 'Menyambung ulang…' }));
        followJob(c.id, (signal, onEvent) => resumeChatStream({ chatId: c.id, since: 0, signal }, onEvent), { resetOnFirstEvent: true, isServer: false });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, account, isAdminView]);

  const loadAdminChat = useCallback(async (id) => {
    if (!id || !isAdminViewRef.current || abortRef.current.has(id)) return;
    const existing = adminChatsRef.current.find(c => c.id === id);
    if (!existing?.loaded) setLoadingChatId(id);
    try {
      const r = await getAdminChat(id);
      if (!isAdminViewRef.current || !r?.ok || !r.chat) return;
      if (abortRef.current.has(id)) return;
      setAdminChats(prev => {
        const exists = prev.some(c => c.id === id);
        const item = { ...r.chat, loaded: true };
        return exists ? prev.map(c => (c.id === id ? { ...c, ...item } : c)) : [item, ...prev];
      });
      if (r.chat.activeJob?.running && !abortRef.current.has(id)) {
        followJob(
          id,
          (signal, onEvent) => resumeChatStream({ chatId: id, since: 0, signal }, onEvent),
          { resetOnFirstEvent: true, isServer: true },
        );
      }
    } catch {}
    finally {
      setLoadingChatId(cur => (cur === id ? null : cur));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Jika user baru membuka kunci admin saat sedang melihat 1 chat, otomatis muat riwayatnya dari VPS
  useEffect(() => {
    if (!isAdminView || !activeId) return;
    const cur = adminChats.find(c => c.id === activeId);
    if (cur && !cur.loaded && loadingChatId !== activeId && !abortRef.current.has(activeId)) {
      loadAdminChat(activeId);
    }
  }, [isAdminView, activeId, adminChats, loadingChatId, loadAdminChat]);

  // Pilih obrolan di Drawer (di mode admin: muat riwayat dari VPS & sambung live jika sedang berjalan)
  const selectChat = (id) => {
    setActiveId(id);
    setDrawerOpen(false);
    if (isAdminViewRef.current) loadAdminChat(id);
  };

  // Saat user mengetuk notifikasi Android → buka langsung chat yang dimaksud & sambung/muat jawabannya
  const openChatFromNotification = useCallback((chatId) => {
    if (!chatId) return;
    setDrawerOpen(false);
    setSettingsOpen(false);
    setAccountOpen(false);
    setSheet(null);
    if (isAdminViewRef.current) {
      setActiveId(chatId);
      loadAdminChat(chatId);
      return;
    }
    const found = localChatsRef.current.find(c => c.id === chatId);
    if (!found) return;
    setActiveId(chatId);
    const last = found.messages?.[found.messages.length - 1];
    if (last?.role === 'assistant' && last.streaming && !abortRef.current.has(chatId)) {
      followJob(
        chatId,
        (signal, onEvent) => resumeChatStream({ chatId, since: 0, signal }, onEvent),
        { resetOnFirstEvent: true, isServer: false, title: found.title || '' },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAdminChat]);

  useEffect(() => {
    if (authed !== true) return;
    window.__antigptOpenChat = openChatFromNotification;
    try {
      const pending = window.AntiGPTNative?.consumePendingChatId?.();
      if (pending) openChatFromNotification(pending);
    } catch {}
    return () => {
      if (window.__antigptOpenChat === openChatFromNotification) delete window.__antigptOpenChat;
    };
  }, [authed, openChatFromNotification]);

  // Saat kembali dari background ke APK/tab → pastikan chat yang masih streaming segera tersambung ulang
  useEffect(() => {
    if (authed !== true) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (isAdminViewRef.current) {
        const aid = activeIdRef.current;
        if (aid && !abortRef.current.has(aid)) {
          const cur = adminChatsRef.current.find(c => c.id === aid);
          if (cur?.jobStatus) loadAdminChat(aid);
        }
        return;
      }
      for (const c of localChatsRef.current) {
        const last = c.messages?.[c.messages.length - 1];
        if (last?.role === 'assistant' && last.streaming && !abortRef.current.has(c.id)) {
          followJob(
            c.id,
            (signal, onEvent) => resumeChatStream({ chatId: c.id, since: 0, signal }, onEvent),
            { resetOnFirstEvent: true, isServer: false, title: c.title || '' },
          );
        }
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, loadAdminChat]);

  async function handleSend(input) {
    // ChatInput mengirim { text, files }; tetap dukung string biasa
    const text = typeof input === 'string' ? input : (input?.text ?? '');
    const files = input?.files || attachments;
    if ((!text.trim() && !files.length) || (activeId && loadingIds.has(activeId))) return;
    setAttachments([]);
    setAttachError('');
    const userMsg = { role: 'user', content: text, attachments: files.map(f => ({ name: f.name, type: f.type, size: f.size ?? f.file?.size })) };
    const useModel = active?.model || model;
    const isServer = isAdminView;

    let id = activeId;
    let chatTitle = active?.title || '';
    if (!id) {
      chatTitle = (text.replace(/\s+/g, ' ').trim() || files[0]?.name || 'Chat baru').slice(0, 60);
      if (isServer) {
        id = newId();
        setAdminChats(cs => [{
          id, title: chatTitle, pinned: false, model: useModel, messages: [], updatedAt: Date.now(),
          serverChat: true, loaded: true, jobStatus: 'running', jobDetail: 'Menyiapkan…', jobStartedAt: Date.now(),
        }, ...cs]);
      } else {
        id = createChat(text || files[0]?.name || 'Chat baru', useModel);
      }
      setActiveId(id);
    } else if (isServer) {
      updateAdminChatState(id, c => ({ ...c, jobStatus: 'running', jobDetail: 'Menyiapkan…', jobStartedAt: Date.now() }));
    }
    storeAddMessage(id, userMsg, isServer);
    // placeholder jawaban AI: diisi bertahap oleh stream (langkah proses + teks)
    storeAddMessage(id, { role: 'assistant', content: '', steps: [], streaming: true, status: 'Menyiapkan…', startedAt: Date.now() }, isServer);
    await followJob(id, (signal, onEvent) => startChatStream({ chatId: id, model: useModel, text, files, signal }, onEvent), { isServer, title: chatTitle });
  }

  const handleTogglePin = (id) => {
    if (isAdminView) {
      const cur = adminChatsRef.current.find(c => c.id === id);
      const next = !cur?.pinned;
      updateAdminChatState(id, c => ({ ...c, pinned: next }));
      updateAdminChat(id, { pinned: next }).catch(() => {});
    } else {
      togglePin(id);
    }
  };

  const handleRename = (id, title) => {
    if (isAdminView) {
      updateAdminChatState(id, c => ({ ...c, title }));
      updateAdminChat(id, { title }).catch(() => {});
    } else {
      renameChat(id, title);
    }
  };

  const handleSleepSandbox = async (id) => {
    try {
      await sleepAdminChat(id);
      refreshAdminChats({ silent: true });
    } catch {}
  };

  const handleDelete = (id) => {
    try { window.AntiGPTNative?.unwatchJob?.(id); } catch {}
    abortRef.current.get(id)?.controller.abort();
    clearChatQuestion(id);
    if (isAdminView) setAdminChats(cs => cs.filter(c => c.id !== id));
    deleteChat(id);
    if (id === activeId) setActiveId(null);
    // hapus container sandbox + folder sesi di server
    deleteChatOnServer(id).catch(() => {});
  };

  const handleAnswerQuestion = async (answers) => {
    if (!activeId || !activeQuestion) return;
    await apiAnswerQuestion({ chatId: activeId, questionId: activeQuestion.id, answers });
    clearChatQuestion(activeId, activeQuestion.id);
  };
  const handleSkipQuestion = async () => {
    if (!activeId || !activeQuestion) return;
    await apiAnswerQuestion({ chatId: activeId, questionId: activeQuestion.id, skip: true });
    clearChatQuestion(activeId, activeQuestion.id);
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
        {active ? (
          isAdminView && loadingChatId === active.id && !(active.messages?.length) ? (
            <div className="chat-loading-state">
              <Loader size={18} className="spin" />
              <span>Memuat riwayat obrolan…</span>
            </div>
          ) : (
            <ChatView
              messages={active.messages || []}
              chatId={active.id}
              hasPendingQuestion={!!activeQuestion}
              onOpenQuestion={() => setDismissedQuestionId(null)}
            />
          )
        ) : <Welcome />}
      </main>

      <div className="input-wrap">
        {activeQuestion && !questionOpen && (
          <button
            type="button"
            className="question-banner"
            onClick={() => setDismissedQuestionId(null)}
          >
            <MessageCircleQuestion size={18} />
            <span className="question-banner-text">
              <strong>AI menunggu jawabanmu</strong>
              <small>{activeQuestion.fields?.[0]?.title || activeQuestion.message || 'Ketuk untuk menjawab'}</small>
            </span>
            <span className="question-banner-cta">Jawab</span>
          </button>
        )}
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
        open={drawerOpen} chats={visibleChats} activeId={activeId}
        isAdmin={isAdminView} loadingIds={loadingIds}
        onRefresh={() => refreshAdminChats()} refreshing={adminRefreshing}
        onClose={() => setDrawerOpen(false)}
        onSelect={selectChat}
        onNewChat={newChat} onTogglePin={handleTogglePin} onRename={handleRename}
        onDelete={handleDelete}
        onSleepSandbox={handleSleepSandbox}
        onStopChat={stopChat}
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

      <ModelSheet
        open={sheet === 'model'}
        onClose={() => setSheet(null)}
        model={chatModel}
        list={models}
        refreshing={modelsRefreshing}
        onOpen={() => refreshModels(false)}
        onRefresh={() => refreshModels(true)}
        onChangeModel={changeModel}
      />

      <QuestionSheet
        open={questionOpen}
        question={activeQuestion}
        onMinimize={() => activeQuestion && setDismissedQuestionId(activeQuestion.id)}
        onSubmit={handleAnswerQuestion}
        onSkip={handleSkipQuestion}
      />

      <SettingsSheet
        open={settingsOpen} onClose={() => setSettingsOpen(false)}
        theme={theme} onChangeTheme={setTheme}
        font={font} onChangeFont={setFont}
        accountEmail={account?.email}
      />

      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} onChanged={setAccount} />
    </div>
  );
}
