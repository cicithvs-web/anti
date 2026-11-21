import { useState, useEffect, useCallback, useRef } from 'react';
import { Moon, Type, Gauge, ChevronRight, X, Sun, Monitor, Clock, CalendarDays, RefreshCw } from 'lucide-react';
import { cachedQuota, isQuotaPending, loadQuota } from '../services/ai';

const THEMES = [
  { id: 'light', label: 'Terang', icon: Sun },
  { id: 'dark', label: 'Gelap', icon: Moon },
  { id: 'system', label: 'Sistem', icon: Monitor },
];

const FONTS = ['Default', 'Serif', 'Mono', 'Rounded'];

function Card({ icon: Icon, title, subtitle, onClick, right }) {
  return (
    <button className="settings-card" onClick={onClick} type="button">
      <span className="settings-card-icon"><Icon size={20} /></span>
      <span className="settings-card-body">
        <span className="settings-card-title">{title}</span>
        {subtitle && <span className="settings-card-sub">{subtitle}</span>}
      </span>
      {right ?? <ChevronRight size={18} className="settings-chevron" />}
    </button>
  );
}

function ThemeCard({ theme, active, onSelect }) {
  const Icon = theme.icon;
  return (
    <button type="button" className={'theme-opt' + (active ? ' active' : '')} onClick={onSelect}>
      <span className="theme-preview"><Icon size={16} /></span>
      <span className="theme-label">{theme.label}</span>
    </button>
  );
}

const WIN = { '5h': '5 jam', weekly: '1 minggu' };
const FRESH_PREFETCH_MS = 10_000;

function fmtReset(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return 'segera';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
  return d ? `${d} hari ${h} jam` : h ? `${h} jam ${m} menit` : `${m} menit`;
}

function fmtUpdatedAgo(at, now) {
  if (!at) return '';
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 15) return 'Baru saja diperbarui';
  if (sec < 60) return `Diperbarui ${sec} dtk lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Diperbarui ${min} mnt lalu`;
  return `Diperbarui ${Math.floor(min / 60)} jam lalu`;
}

function QuotaSkeleton() {
  return (
    <>
      {[0, 1].map((g) => (
        <section key={g} className="limit-group" aria-hidden="true">
          <div className="skel skel-title" />
          {[0, 1].map((r) => (
            <div key={r} className="limit-row">
              <span className="skel skel-icon" />
              <span className="limit-body" style={{ flex: 1, gap: 6 }}>
                <span className="skel skel-line" style={{ width: '52%' }} />
                <span className="skel skel-bar" />
                <span className="skel skel-line" style={{ width: '38%', height: 10 }} />
              </span>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

function LimitPanel({ onBack, accountEmail }) {
  const initial = cachedQuota(accountEmail);
  const [groups, setGroups] = useState(() => initial?.groups || null);
  const [updatedAt, setUpdatedAt] = useState(() => initial?.at || null);
  const [refreshing, setRefreshing] = useState(() => !initial || isQuotaPending() || Date.now() - (initial.at || 0) > FRESH_PREFETCH_MS);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const fetchQuota = useCallback((force = true) => {
    setRefreshing(true);
    setErr('');
    loadQuota({ email: accountEmail, refresh: force })
      .then((r) => {
        if (!aliveRef.current) return;
        if (r.needLogin) {
          setGroups(null);
          setUpdatedAt(null);
          setErr('Login dulu lewat menu Akun untuk melihat limit asli.');
        } else if (!r.ok) {
          setErr('Gagal mengambil kuota terbaru.');
        } else {
          setGroups(r.groups || []);
          setUpdatedAt(r.at || Date.now());
          setNow(Date.now());
        }
      })
      .catch(() => { if (aliveRef.current) setErr('Gagal mengambil kuota terbaru.'); })
      .finally(() => { if (aliveRef.current) setRefreshing(false); });
  }, [accountEmail]);

  useEffect(() => {
    const c = cachedQuota(accountEmail);
    if (c) { setGroups(c.groups); setUpdatedAt(c.at); }
    else { setGroups(null); setUpdatedAt(null); }

    // Jika prefetch dari saat membuka Pengaturan baru selesai (< 10 dtk) & tidak sedang berjalan, langsung pakai.
    // Selain itu, langsung ambil kuota realtime di belakang layar.
    const recentlyFetched = c?.at && Date.now() - c.at <= FRESH_PREFETCH_MS && !isQuotaPending();
    if (recentlyFetched) {
      setRefreshing(false);
      setErr('');
      return;
    }
    fetchQuota(true);
  }, [accountEmail, fetchQuota]);

  // Perbarui label "X dtk/mnt lalu" secara berkala selama panel terbuka
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const statusText = refreshing
    ? (groups ? 'Memperbarui kuota terbaru…' : 'Mengambil kuota…')
    : err && groups
      ? `${err} · ${fmtUpdatedAgo(updatedAt, now)}`
      : fmtUpdatedAgo(updatedAt, now);

  return (
    <div className="settings-page">
      <div className="settings-page-head">
        <button className="settings-back" onClick={onBack} type="button" aria-label="Kembali">
          <ChevronRight size={20} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span className="settings-page-title">Limit</span>
        <button
          className="settings-refresh"
          onClick={() => fetchQuota(true)}
          type="button"
          disabled={refreshing}
          aria-label="Perbarui kuota"
          title="Perbarui kuota"
        >
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
        </button>
      </div>

      {statusText && (
        <div className={'limit-status' + (refreshing ? ' shimmer' : '')}>{statusText}</div>
      )}

      {err && !groups && (
        <div className="limit-empty">{err}</div>
      )}

      {!groups && refreshing && <QuotaSkeleton />}

      {groups && groups.length === 0 && !refreshing && !err && (
        <div className="limit-empty">Data kuota tidak tersedia.</div>
      )}

      {(groups || []).map((g) => (
        <section key={g.name} className="limit-group">
          <div className="limit-group-name">
            {g.name === 'Gemini Models' ? 'Gemini' : g.name === 'Claude and GPT models' ? 'Claude & GPT' : g.name}
          </div>
          {[...g.buckets].sort((a, b) => (a.window === '5h' ? -1 : 1)).map((b) => {
            const pct = Math.round((b.remaining_fraction ?? 0) * 100);
            return (
              <div key={b.id} className="limit-row">
                <span className="limit-icon">{b.window === 'weekly' ? <CalendarDays size={18} /> : <Clock size={18} />}</span>
                <span className="limit-body" style={{ flex: 1 }}>
                  <span className="limit-label">{WIN[b.window] || b.window} · sisa {pct}%</span>
                  <span style={{ display: 'block', height: 6, borderRadius: 3, background: 'var(--border)', margin: '6px 0', overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: pct + '%', borderRadius: 3, background: pct > 50 ? '#22c55e' : pct > 20 ? '#f59e0b' : '#ef4444', transition: 'width .6s ease' }} />
                  </span>
                  <span className="limit-desc">Reset dalam {fmtReset(b.reset_time)}</span>
                </span>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

export default function SettingsSheet({ open, onClose, theme, onChangeTheme, font, onChangeFont, accountEmail }) {
  const [page, setPage] = useState('main'); // 'main' | 'font' | 'limit'
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  // Prefetch kuota realtime di belakang layar saat sheet Pengaturan dibuka
  useEffect(() => {
    if (!open || !accountEmail) return;
    const c = cachedQuota(accountEmail);
    if (!c?.at || Date.now() - c.at > FRESH_PREFETCH_MS) {
      loadQuota({ email: accountEmail, refresh: true }).catch(() => {});
    }
  }, [open, accountEmail]);

  // Animasi smooth buka & tutup (sheet tetap ter-mount saat transisi keluar)
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => { setMounted(false); setPage('main'); }, 320);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;

  const close = () => { onClose(); setTimeout(() => setPage('main'), 250); };

  return (
    <>
      <div className={'settings-overlay' + (visible ? ' open' : '')} onClick={close} />
      <div className={'settings-sheet' + (visible ? ' open' : '')}>
        {page === 'main' && (
          <div className="settings-page">
            <div className="settings-handle" />
            <div className="settings-head">
              <span className="settings-title">Pengaturan</span>
              <button className="settings-close" onClick={close} type="button" aria-label="Tutup"><X size={18} /></button>
            </div>

            <Card icon={Moon} title="Mode warna" subtitle={THEMES.find(t => t.id === theme)?.label} right={false} />
            <div className="theme-row">
              {THEMES.map(t => (
                <ThemeCard key={t.id} theme={t} active={theme === t.id} onSelect={() => onChangeTheme(t.id)} />
              ))}
            </div>

            <Card icon={Type} title="Gaya font" subtitle={font} onClick={() => setPage('font')} />
            <Card icon={Gauge} title="Limit" subtitle="Kuota pemakaian model" onClick={() => setPage('limit')} />
          </div>
        )}

        {page === 'font' && (
          <div className="settings-page">
            <div className="settings-page-head">
              <button className="settings-back" onClick={() => setPage('main')} type="button" aria-label="Kembali">
                <ChevronRight size={20} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <span className="settings-page-title">Gaya font</span>
            </div>
            {FONTS.map(f => (
              <button key={f} type="button" className={'settings-option' + (font === f ? ' active' : '')} onClick={() => onChangeFont(f)}>
                <span className="settings-option-label">{f}</span>
                {font === f && <span className="settings-check">✓</span>}
              </button>
            ))}
          </div>
        )}

        {page === 'limit' && <LimitPanel onBack={() => setPage('main')} accountEmail={accountEmail} />}
      </div>
    </>
  );
}
