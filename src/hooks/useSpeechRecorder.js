import { useCallback, useEffect, useRef, useState } from 'react';

// Voice-to-text pakai Web Speech API bawaan browser (Chrome/Edge/Safari).
// Setara /voice di agy CLI, tapi mic-nya mic browser — agy di sandbox Docker tidak punya audio device.
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

const ERRORS = {
  'not-allowed': 'Izin mikrofon ditolak. Izinkan mic di pengaturan browser.',
  'service-not-allowed': 'Izin mikrofon ditolak. Izinkan mic di pengaturan browser.',
  'audio-capture': 'Mikrofon tidak ditemukan.',
  'network': 'Gagal menghubungi layanan pengenalan suara (cek internet).',
  'language-not-supported': 'Bahasa tidak didukung browser ini.',
};

/**
 * onTranscript(text, isFinal) dipanggil dengan transkrip lengkap sejak start().
 */
export default function useSpeechRecorder({ lang = 'id-ID', onTranscript } = {}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;

  const supported = !!SR;

  const stop = useCallback(() => { try { recRef.current?.stop(); } catch {} }, []);
  // abort: berhenti tanpa mengirim hasil yang masih tertunda (dipakai saat pesan sudah dikirim)
  const abort = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    rec.onresult = null;
    try { rec.abort(); } catch {}
  }, []);

  const start = useCallback(() => {
    setError(null);
    if (!SR) { setError('Browser ini belum mendukung input suara. Coba Chrome/Edge/Safari.'); return; }
    if (!window.isSecureContext) { setError('Input suara butuh HTTPS atau localhost.'); return; }
    if (recRef.current) return;
    const rec = new SR();
    rec.lang = lang;
    // Chrome Android punya bug di mode continuous: hasil final terulang (teks dobel).
    // Di Android pakai mode sekali-ucap: berhenti sendiri setelah jeda bicara.
    rec.continuous = !/Android/i.test(navigator.userAgent);
    rec.interimResults = true;
    rec.onresult = (e) => {
      let finalText = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      cbRef.current?.((finalText + interim).replace(/\s+/g, ' ').trim(), !interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return;
      setError(ERRORS[e.error] || `Input suara gagal (${e.error}).`);
    };
    rec.onend = () => { recRef.current = null; setRecording(false); };
    recRef.current = rec;
    try { rec.start(); setRecording(true); }
    catch (err) { recRef.current = null; setError(`Input suara gagal: ${err.message}`); }
  }, [lang]);

  const toggle = useCallback(() => (recRef.current ? stop() : start()), [start, stop]);

  // hentikan mic saat komponen di-unmount
  useEffect(() => () => { try { recRef.current?.abort(); } catch {} }, []);

  // pesan error hilang sendiri
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  return { supported, recording, error, start, stop, abort, toggle };
}
