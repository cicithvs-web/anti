import { useState } from 'react';
import { KeyRound, Loader } from 'lucide-react';
import { authLogin } from '../services/ai';

// Layar token akses — muncul kalau server membalas 401 (token di .env: AUTH_TOKEN)
export default function AuthGate({ onSuccess }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true); setError('');
    const r = await authLogin(token.trim());
    setBusy(false);
    if (r.ok) onSuccess?.();
    else setError(r.error || 'Token salah.');
  };

  return (
    <div className="app auth-gate">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-icon"><KeyRound size={26} /></div>
        <div className="auth-title">AntiGPT</div>
        <div className="auth-sub">Masukkan token akses untuk melanjutkan.</div>
        <input
          className="auth-input" type="password" autoFocus autoComplete="current-password"
          placeholder="Token akses" value={token} onChange={e => setToken(e.target.value)}
        />
        {error && <div className="auth-error">{error}</div>}
        <button className="account-btn primary" type="submit" disabled={busy || !token.trim()}>
          {busy ? <Loader size={18} className="spin" /> : null} Masuk
        </button>
      </form>
    </div>
  );
}
