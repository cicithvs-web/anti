import { useEffect, useMemo, useState } from 'react';
import {
  X, File, FileArchive, FileText, FileCode, FileJson, FileSpreadsheet,
  FileAudio, FileVideo, FileImage, FileCog, Play,
} from 'lucide-react';

const EXT_ICONS = [
  [FileArchive, ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']],
  [FileJson, ['json', 'jsonl', 'ndjson']],
  [FileCog, ['yml', 'yaml', 'toml', 'ini', 'env', 'conf', 'cfg', 'xml']],
  [FileCode, ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php',
    'rb', 'sh', 'bash', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'swift', 'dart', 'lua']],
  [FileSpreadsheet, ['csv', 'tsv', 'xls', 'xlsx', 'ods']],
  [FileText, ['pdf', 'txt', 'md', 'doc', 'docx', 'odt', 'rtf', 'log']],
  [FileAudio, ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']],
  [FileVideo, ['mp4', 'mov', 'mkv', 'webm', 'avi']],
  [FileImage, ['heic', 'heif', 'tif', 'tiff', 'bmp', 'psd', 'raw']],
];

export const fileExt = (name = '') => {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
};

function iconFor(f) {
  const ext = fileExt(f.name);
  for (const [Icon, exts] of EXT_ICONS) if (exts.includes(ext)) return Icon;
  if (f.type?.startsWith('image/')) return FileImage;
  if (f.type?.startsWith('audio/')) return FileAudio;
  if (f.type?.startsWith('video/')) return FileVideo;
  if (f.type?.startsWith('text/')) return FileText;
  return File;
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const isImageAttachment = (f) => !!f?.type?.startsWith('image/') && !!f.file;

// Object URL untuk 1 File; dicabut otomatis saat file berganti / komponen hilang.
export function useObjectUrl(file) {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

// Key stabil per objek lampiran (index bergeser saat ada yang dihapus).
const keys = new WeakMap();
let nextKey = 0;
export const keyOf = (f) => {
  if (!keys.has(f)) keys.set(f, ++nextKey);
  return keys.get(f);
};

export function FileCard({ f, onRemove, onOpen, playable = false }) {
  const Icon = iconFor(f);
  const ext = fileExt(f.name);
  const size = f.size ?? f.file?.size;
  const inner = (
    <>
      <span className={'att-card-icon' + (playable ? ' playable' : '')}>
        {playable ? <Play size={18} fill="currentColor" /> : <Icon size={20} />}
      </span>
      <span className="att-card-text">
        <span className="att-card-name">{f.name}</span>
        <span className="att-card-meta">{[ext.toUpperCase(), formatSize(size)].filter(Boolean).join(' · ')}</span>
      </span>
    </>
  );
  if (onOpen && !onRemove) {
    return (
      <button type="button" className="att-card att-card-btn" title={f.name} onClick={onOpen}>
        {inner}
      </button>
    );
  }
  return (
    <div className="att-card" title={f.name}>
      {inner}
      {onRemove && (
        <button type="button" className="att-card-remove" onClick={onRemove} aria-label={`Hapus ${f.name}`}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// src: URL gambar dari server (pesan terkirim); kalau kosong pakai object URL dari f.file (composer).
export function ImageThumb({ f, src, onOpen, onRemove, onBroken, className = '' }) {
  const objectUrl = useObjectUrl(src ? null : f.file);
  const url = src || objectUrl;
  return (
    <div className={'att-thumb ' + className}>
      <button type="button" className="att-thumb-open" onClick={onOpen} aria-label={`Lihat ${f.name}`}>
        <img src={url} alt={f.name} draggable={false} onError={onBroken} />
      </button>
      {onRemove && (
        <button type="button" className="att-thumb-remove" onClick={onRemove} aria-label={`Hapus ${f.name}`}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * Baris lampiran di composer: gambar → thumbnail seragam (object-fit: cover),
 * selain itu → kartu file. Gambar yang gagal dirender browser (mis. HEIC) jatuh ke kartu file.
 */
export default function AttachmentTray({ attachments, onRemove, onOpen }) {
  const [broken, setBroken] = useState(() => new WeakSet());
  const markBroken = (f) => setBroken((s) => { const n = new WeakSet(); attachments.forEach((a) => (s.has(a) || a === f) && n.add(a)); return n; });

  return (
    <div className="att-tray">
      {attachments.map((f, i) => (
        isImageAttachment(f) && !broken.has(f)
          ? <ImageThumb key={keyOf(f)} f={f} onOpen={() => onOpen(i)} onRemove={() => onRemove(i)} onBroken={() => markBroken(f)} />
          : <FileCard key={keyOf(f)} f={f} onRemove={() => onRemove(i)} />
      ))}
    </div>
  );
}
