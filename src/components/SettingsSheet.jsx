import { useState, useEffect } from 'react';
import { Moon, Type, Gauge, ChevronRight, X, Sun, Monitor, Clock, CalendarDays } from 'lucide-react';
import { LIMITS } from '../data/models';
import { getQuota } from '../services/ai';

const THEMES = [
  { id: 'light', label: 'Terang', icon: Sun },
  { id: 'dark', label: 'Gelap', icon: Moon },
  { id: 'system', label: 'Sistem', icon: Monitor },
];

const FONTS = ['Default', 'Serif', 'Mono', 'Rounded'];

// Provider saat ini: kumpulan model yang pakai provider sama
const PROVIDERS = [
  { id: 'gemini', name: 'Gemini' },
  { id: 'claude', name: 'Claude & GPT', models: ['claude', 'gpt'] },
];

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
function fmtReset(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return 'segera';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
  return d ? `${d} hari ${h} jam` : h ? `${h} jam ${m} menit` : `${m} menit`;
}

function LimitPanel({ onBack }) {
  const [q, setQ] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    getQuota().then(r => {
      if (r.needLogin) setErr('Login dulu lewat menu Akun untuk melihat limit asli.');
      else if (!r.ok) setErr('Gagal mengambil kuota.');
      else setQ(r.groups);
    }).catch(() => setErr('Gagal mengambil kuota.'));
  }, []);
  if (q || err) return (
    <div className="settings-page">
      <div className="settings-page-head">
        <button className="settings-back" onClick={onBack} type="button" aria-label="Kembali">
          <ChevronRight size={20} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span className="settings-page-title">Limit</span>
      </div>
      {err && <div className="limit-desc" style={{ padding: 12 }}>{err}</div>}
      {(q || []).map(g => (
        <section key={g.name} className="limit-group">
          <div className="limit-group-name">{g.name === 'Gemini Models' ? 'Gemini' : g.name === 'Claude and GPT models' ? 'Claude & GPT' : g.name}</div>
          {[...g.buckets].sort((a, b) => (a.window === '5h' ? -1 : 1)).map(b => {
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
  return (
    <div className="settings-page">
      <div className="settings-page-head">
        <button className="settings-back" onClick={onBack} type="button" aria-label="Kembali">
          <ChevronRight size={20} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span className="settings-page-title">Limit</span>
      </div>

      {PROVIDERS.map(p => (
        <section key={p.id} className="limit-group">
          <div className="limit-group-name">{p.name}</div>
          {LIMITS[p.id].map(l => (
            <div key={l.label} className="limit-row">
              <span className="limit-icon">
                {l.label.includes('minggu') ? <CalendarDays size={18} /> : <Clock size={18} />}
              </span>
              <span className="limit-body">
                <span className="limit-label">{l.label}</span>
                <span className="limit-desc">{l.desc}</span>
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export default function SettingsSheet({ open, onClose, theme, onChangeTheme, font, onChangeFont }) {
  const [page, setPage] = useState('main'); // 'main' | 'font' | 'limit'
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

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

        {page === 'limit' && <LimitPanel onBack={() => setPage('main')} />}
      </div>
    </>
  );
}
