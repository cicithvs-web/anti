import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import BottomSheet from './BottomSheet';
import RippleButton from './RippleButton.jsx';

// Pop-up pertanyaan interaktif AI (ask_question / ACP elicitation) — bergaya mirip ModelSheet.
// Menutup sheet (X / tap luar) hanya menyembunyikan sementara agar user bisa membaca riwayat chat;
// untuk melewati pertanyaan secara eksplisit gunakan tombol "Lewati".
export default function QuestionSheet({ open, question, onMinimize, onSubmit, onSkip }) {
  const [draft, setDraft] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Reset form hanya ketika ID pertanyaan berubah (minimize lalu buka ulang tidak menghapus pilihan)
  useEffect(() => {
    setDraft({});
    setSubmitting(false);
    setError('');
  }, [question?.id]);

  const fields = question?.fields || [];

  const hasAnswer = useMemo(() => {
    for (const f of fields) {
      const val = draft[f.key];
      const other = f.otherKey ? String(draft[f.otherKey] || '').trim() : '';
      if (other) return true;
      if (f.type === 'multi' && Array.isArray(val) && val.length > 0) return true;
      if (f.type === 'boolean' && typeof val === 'boolean') return true;
      if (f.type !== 'multi' && f.type !== 'boolean' && val !== undefined && val !== null && String(val).trim() !== '') return true;
    }
    return false;
  }, [fields, draft]);

  const missingRequired = useMemo(() => fields.some((f) => {
    if (!f.required) return false;
    const val = draft[f.key];
    const other = f.otherKey ? String(draft[f.otherKey] || '').trim() : '';
    if (other) return false;
    if (f.type === 'multi') return !Array.isArray(val) || val.length === 0;
    if (f.type === 'boolean') return typeof val !== 'boolean';
    return val === undefined || val === null || String(val).trim() === '';
  }), [fields, draft]);

  const pickSingle = (f, value) => {
    setError('');
    setDraft((prev) => {
      const next = { ...prev };
      if (String(prev[f.key]) === String(value)) delete next[f.key];
      else {
        next[f.key] = value;
        if (f.otherKey) delete next[f.otherKey];
      }
      return next;
    });
  };

  const toggleMulti = (f, value) => {
    setError('');
    setDraft((prev) => {
      const cur = Array.isArray(prev[f.key]) ? prev[f.key] : [];
      const exists = cur.some((v) => String(v) === String(value));
      const nextList = exists ? cur.filter((v) => String(v) !== String(value)) : [...cur, value];
      return { ...prev, [f.key]: nextList };
    });
  };

  const setOther = (f, text) => {
    setError('');
    setDraft((prev) => {
      const next = { ...prev, [f.otherKey]: text };
      if (f.type === 'single' && text.trim()) delete next[f.key];
      return next;
    });
  };

  const setScalar = (key, value) => {
    setError('');
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (submitting || !question || !hasAnswer || missingRequired) return;
    setSubmitting(true);
    setError('');
    try {
      await onSubmit(draft);
    } catch (err) {
      setError(err?.body?.error || err?.message || 'Gagal mengirim jawaban.');
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    if (submitting || !question) return;
    setSubmitting(true);
    setError('');
    try {
      await onSkip();
    } catch (err) {
      setError(err?.body?.error || err?.message || 'Gagal melewati pertanyaan.');
      setSubmitting(false);
    }
  };

  const title = fields.length > 1 ? `Pertanyaan AI (${fields.length})` : 'Pertanyaan AI';

  return (
    <BottomSheet open={!!(open && question)} title={title} onClose={onMinimize}>
      {question && (
        <form className="q-form" onSubmit={handleSubmit}>
          {fields.map((f, idx) => (
            <div key={f.key} className="q-block">
              <div className="q-title">
                {fields.length > 1 && <span className="q-num">{idx + 1}.</span>}
                <span>{f.title}</span>
              </div>
              {f.description && <div className="q-desc">{f.description}</div>}
              {f.type === 'multi' && <div className="q-hint">Bisa pilih lebih dari satu</div>}

              {f.type === 'single' && (
                <div className="card-list">
                  {f.options.map((o) => {
                    const selected = String(draft[f.key]) === String(o.value);
                    return (
                      <RippleButton
                        key={String(o.value)}
                        type="button"
                        className={'model-row q-opt' + (selected ? ' selected' : '')}
                        onClick={() => pickSingle(f, o.value)}
                      >
                        <div className="q-opt-label">
                          <span>{o.label}</span>
                          {o.recommended && <span className="badge">Rekomendasi</span>}
                        </div>
                        {selected && <Check size={18} className="q-check-icon" />}
                      </RippleButton>
                    );
                  })}
                </div>
              )}

              {f.type === 'multi' && (
                <div className="card-list">
                  {f.options.map((o) => {
                    const list = Array.isArray(draft[f.key]) ? draft[f.key] : [];
                    const selected = list.some((v) => String(v) === String(o.value));
                    return (
                      <RippleButton
                        key={String(o.value)}
                        type="button"
                        className={'model-row q-opt' + (selected ? ' selected' : '')}
                        onClick={() => toggleMulti(f, o.value)}
                      >
                        <div className="q-opt-label">
                          <span>{o.label}</span>
                          {o.recommended && <span className="badge">Rekomendasi</span>}
                        </div>
                        <span className={'q-checkbox' + (selected ? ' checked' : '')} aria-hidden="true">
                          {selected && <Check size={13} strokeWidth={3} />}
                        </span>
                      </RippleButton>
                    );
                  })}
                </div>
              )}

              {f.type === 'boolean' && (
                <div className="card-list">
                  {[{ value: true, label: 'Ya' }, { value: false, label: 'Tidak' }].map((o) => {
                    const selected = draft[f.key] === o.value;
                    return (
                      <RippleButton
                        key={o.label}
                        type="button"
                        className={'model-row q-opt' + (selected ? ' selected' : '')}
                        onClick={() => setScalar(f.key, o.value)}
                      >
                        <div className="q-opt-label"><span>{o.label}</span></div>
                        {selected && <Check size={18} className="q-check-icon" />}
                      </RippleButton>
                    );
                  })}
                </div>
              )}

              {(f.type === 'text' || f.type === 'number') && (
                <input
                  type={f.type === 'number' ? 'number' : 'text'}
                  className="app-dialog-input q-other-input"
                  placeholder="Tulis jawabanmu…"
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setScalar(f.key, e.target.value)}
                />
              )}

              {f.otherKey && (
                <input
                  type="text"
                  className="app-dialog-input q-other-input"
                  placeholder="Lainnya (tulis jawaban sendiri, opsional)…"
                  value={draft[f.otherKey] ?? ''}
                  onChange={(e) => setOther(f, e.target.value)}
                />
              )}
            </div>
          ))}

          {error && <div className="q-error" role="alert">{error}</div>}

          <div className="q-actions">
            <button
              type="button"
              className="app-dialog-btn secondary"
              onClick={handleSkip}
              disabled={submitting}
            >
              Lewati
            </button>
            <button
              type="submit"
              className="app-dialog-btn primary"
              disabled={submitting || !hasAnswer || missingRequired}
            >
              {submitting ? 'Mengirim…' : 'Kirim jawaban'}
            </button>
          </div>
        </form>
      )}
    </BottomSheet>
  );
}
