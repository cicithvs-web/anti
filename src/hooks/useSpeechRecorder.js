import { useCallback, useEffect, useRef, useState } from 'react';

// Voice-to-text:
// 1. Jika berjalan di dalam APK Android AntiGPT -> pakai native Android SpeechRecognizer via window.AntiGPTNative
// 2. Di browser biasa -> pakai Web Speech API bawaan browser (Chrome/Edge/Safari).
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

function hasNativeVoice() {
  try {
    return typeof window !== 'undefined' && !!window.AntiGPTNative?.isVoiceAvailable?.();
  } catch {
    return false;
  }
}

const ERRORS = {
  'not-allowed': 'Izin mikrofon ditolak. Izinkan mic di pengaturan aplikasi/browser.',
  'service-not-allowed': 'Izin mikrofon ditolak. Izinkan mic di pengaturan aplikasi/browser.',
  'audio-capture': 'Mikrofon tidak ditemukan.',
  'network': 'Gagal menghubungi layanan pengenalan suara (cek internet).',
  'language-not-supported': 'Bahasa tidak didukung perangkat ini.',
  'unavailable': 'Layanan pengenalan suara tidak tersedia di perangkat ini.',
};

/**
 * onTranscript(text, isFinal) dipanggil dengan transkrip lengkap sejak start().
 */
export default function useSpeechRecorder({ lang = 'id-ID', onTranscript } = {}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const nativeActiveRef = useRef(false);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;

  const supported = hasNativeVoice() || !!SR;

  const clearNativeCallbacks = useCallback(() => {
    if (typeof window !== 'undefined' && window.__antigptVoice) {
      delete window.__antigptVoice;
    }
  }, []);

  const stop = useCallback(() => {
    if (nativeActiveRef.current) {
      try { window.AntiGPTNative?.stopVoice?.(); } catch {}
      return;
    }
    try { recRef.current?.stop(); } catch {}
  }, []);

  // abort: berhenti tanpa mengirim hasil yang masih tertunda (dipakai saat pesan sudah dikirim)
  const abort = useCallback(() => {
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false;
      clearNativeCallbacks();
      setRecording(false);
      try { window.AntiGPTNative?.abortVoice?.(); } catch {}
      return;
    }
    const rec = recRef.current;
    if (!rec) return;
    rec.onresult = null;
    try { rec.abort(); } catch {}
  }, [clearNativeCallbacks]);

  const start = useCallback(() => {
    setError(null);
    if (hasNativeVoice()) {
      if (nativeActiveRef.current) return;
      nativeActiveRef.current = true;
      window.__antigptVoice = {
        onResult: (text, isFinal) => {
          if (!nativeActiveRef.current) return;
          cbRef.current?.(String(text || '').replace(/\s+/g, ' ').trim(), !!isFinal);
        },
        onError: (code) => {
          nativeActiveRef.current = false;
          clearNativeCallbacks();
          setRecording(false);
          if (code === 'aborted' || code === 'no-speech') return;
          setError(ERRORS[code] || `Input suara gagal (${code}).`);
        },
        onEnd: () => {
          nativeActiveRef.current = false;
          clearNativeCallbacks();
          setRecording(false);
        },
      };
      try {
        setRecording(true);
        window.AntiGPTNative.startVoice(lang);
      } catch (err) {
        nativeActiveRef.current = false;
        clearNativeCallbacks();
        setRecording(false);
        setError(`Input suara gagal: ${err?.message || err}`);
      }
      return;
    }

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
  }, [lang, clearNativeCallbacks]);

  const toggle = useCallback(() => (nativeActiveRef.current || recRef.current ? stop() : start()), [start, stop]);

  // hentikan mic saat komponen di-unmount
  useEffect(() => () => {
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false;
      clearNativeCallbacks();
      try { window.AntiGPTNative?.abortVoice?.(); } catch {}
    }
    try { recRef.current?.abort(); } catch {}
  }, [clearNativeCallbacks]);

  // pesan error hilang sendiri
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  return { supported, recording, error, start, stop, abort, toggle };
}
