import { useState, useEffect, useRef } from 'react';
import { X, LogIn, LogOut, ExternalLink, User, Loader, CircleCheck, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { apiStatus, loginStart, loginStatus, loginCode, loginCancel, logout, adminLogin, adminLogout } from '../services/ai';

export default function AccountSheet({ open, onClose, onChanged }) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [st, setSt] = useState(null);        // status backend
  const [login, setLogin] = useState(null);  // { status, url } saat proses login
  const [msg, setMsg] = useState('');
  const [code, setCode] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [adminErr, setAdminErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const refresh = async () => {
    try {
      const s = await apiStatus();
      setSt(s);
      setLogin(s.login || null);
      onChanged?.(s);
    } catch {}
  };
  const stopPoll = () => { clearInterval(pollRef.current); pollRef.current = null; };

  const startPoll = () => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const r = await loginStatus();
        if (r.active) { setLogin(r.active); return; }
        stopPoll(); setLogin(null);
        const res = r.result;
        if (res?.status === 'success') setMsg(`✅ Login berhasil sebagai ${res.email}`);
        else if (res?.status === 'timeout') setMsg('⏰ ' + res.error);
        else if (res?.status === 'failed') setMsg('❌ ' + res.error);
        else if (res?.status === 'cancelled') setMsg('Login dibatalkan.');
        refresh();
      } catch (e) {
        if (e?.status === 403) { stopPoll(); setLogin(null); refresh(); }
      }
    }, 1500);
  };

  useEffect(() => {
    if (open) {
      setMounted(true); setMsg(''); setAdminErr(''); setAdminKey(''); refresh();
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => { if (open && login) startPoll(); return stopPoll; }, [open, !!login]);

  if (!mounted) return null;

  const canManage = !!st && (!st.adminEnabled || !!st.isAdmin);
  const loggedIn = st?.loggedIn;

  const handleApiError = (e, fallback) => {
    setMsg('❌ ' + (e?.body?.error || fallback));
    if (e?.status === 403) refresh();
  };

  const doUnlockAdmin = async (e) => {
    e.preventDefault();
    if (!adminKey.trim() || busy) return;
    setBusy(true); setAdminErr(''); setMsg('');
    try {
      const r = await adminLogin(adminKey.trim());
      if (r.ok) {
        setAdminKey('');
        await refresh();
      } else {
        setAdminErr(r.error || 'Kunci admin salah.');
      }
    } finally { setBusy(false); }
  };

  const doLockAdmin = async () => {
    setBusy(true); setMsg(''); setAdminErr('');
    try {
      stopPoll();
      await adminLogout();
      setLogin(null);
      await refresh();
    } finally { setBusy(false); }
  };

  const doLogin = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await loginStart();
      if (!r.ok) setMsg(r.error || 'Gagal memulai login');
      setLogin({ status: r.status || 'preparing', url: r.url || null });
    } catch (e) { handleApiError(e, 'Gagal memulai login'); }
    finally { setBusy(false); }
  };
  const doCancel = async () => {
    try { await loginCancel(); stopPoll(); setLogin(null); setMsg('Login dibatalkan.'); refresh(); }
    catch (e) { handleApiError(e, 'Gagal membatalkan login'); }
  };
  const doCode = async () => {
    if (!code.trim()) return;
    try {
      const r = await loginCode(code); setCode('');
      setMsg(r.ok ? 'Kode dikirim, menunggu konfirmasi…' : '❌ ' + r.error);
    } catch (e) { handleApiError(e, 'Gagal mengirim kode'); }
  };
  const doLogout = async () => {
    setBusy(true);
    try { const r = await logout(); setMsg(r.ok ? `👋 Logout dari ${r.email}` : r.error); await refresh(); }
    catch (e) { handleApiError(e, 'Gagal logout'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className={'settings-overlay' + (visible ? ' open' : '')} onClick={onClose} />
      <div className={'settings-sheet' + (visible ? ' open' : '')}>
        <div className="settings-page">
          <div className="settings-handle" />
          <div className="settings-head">
            <span className="settings-title">Akun</span>
            <button className="settings-close" onClick={onClose} type="button" aria-label="Tutup"><X size={18} /></button>
          </div>

          <div className="account-card">
            <span className="account-avatar">{loggedIn ? <CircleCheck size={22} color="#22c55e" /> : <User size={22} />}</span>
            <div className="account-info">
              <div className="account-name">{loggedIn ? st.email : (st ? 'Belum login' : 'Memuat…')}</div>
              <div className="account-sub">
                {st ? `Antigravity (agy) · antrean ${st.running}/${st.maxParallel}${st.queued ? ` · ${st.queued} menunggu` : ''}` : 'Memuat…'}
              </div>
            </div>
          </div>

          {!st ? null : !canManage ? (
            <form className="admin-lock-box" onSubmit={doUnlockAdmin}>
              <div className="admin-lock-head">
                <Lock size={16} />
                <span>Pengelolaan akun dikunci. Masukkan kunci admin untuk login, ganti akun, atau logout.</span>
              </div>
              <input
                className="auth-input"
                type="password"
                autoComplete="off"
                placeholder="Kunci admin"
                value={adminKey}
                onChange={(e) => { setAdminKey(e.target.value); if (adminErr) setAdminErr(''); }}
              />
              {adminErr && <div className="auth-error">{adminErr}</div>}
              <button className="account-btn primary" type="submit" disabled={busy || !adminKey.trim()}>
                {busy ? <Loader size={18} className="spin" /> : <KeyRound size={17} />} Buka kunci akun
              </button>
            </form>
          ) : login ? (
            <>
              {!login.url ? (
                <div className="account-status"><Loader size={16} className="spin" /> Menyiapkan link login…</div>
              ) : (
                <>
                  <div className="account-status"><Loader size={16} className="spin" /> Menunggu kamu login di Google…</div>
                  <a className="account-btn primary" href={login.url} target="_blank" rel="noreferrer">
                    <ExternalLink size={18} /> Buka halaman login Google
                  </a>
                  <div className="key-row" style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                    <input className="key-input" placeholder="Kode otorisasi (kalau diminta)" value={code}
                      onChange={e => setCode(e.target.value)} style={{ flex: 1, padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                    <button className="account-btn" style={{ width: 'auto', marginBottom: 0 }} onClick={doCode}><KeyRound size={16} /></button>
                  </div>
                </>
              )}
              <button className="account-btn danger" onClick={doCancel}><X size={18} /> Batalkan</button>
            </>
          ) : loggedIn ? (
            <>
              <button className="account-btn" disabled={busy} onClick={doLogin}><LogIn size={18} /> Ganti akun</button>
              <button className="account-btn danger" disabled={busy} onClick={doLogout}>
                {busy ? <Loader size={18} className="spin" /> : <LogOut size={18} />} Logout
              </button>
            </>
          ) : (
            <button className="account-btn primary" disabled={busy} onClick={doLogin}>
              {busy ? <Loader size={18} className="spin" /> : <LogIn size={18} />} Login dengan Google
            </button>
          )}

          {canManage && st.adminEnabled && !login && (
            <button className="account-btn admin-relock" type="button" disabled={busy} onClick={doLockAdmin}>
              <ShieldCheck size={16} /> Kunci kembali akses akun
            </button>
          )}

          {msg && <div className="account-status">{msg}</div>}
          {canManage && (
            <div className="account-hint">Login memakai OAuth Google dari CLI Antigravity (agy), sama seperti /login di agybot. Token lama di-backup & dipulihkan kalau login gagal.</div>
          )}
        </div>
      </div>
    </>
  );
}
