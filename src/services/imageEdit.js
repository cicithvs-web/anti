// imageEdit.js — render hasil crop + putar ke File baru (dipakai ImageEditor).

// Tipe yang bisa diedit di canvas. GIF dilewati supaya animasinya tidak hilang.
export const EDITABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const isEditableImage = (f) => EDITABLE_IMAGE_TYPES.includes(f?.type);

// Sisi terpanjang hasil edit. Foto kamera HP (12–50 MP) diperkecil supaya upload ringan.
const MAX_SIDE = 2000;
const JPEG_QUALITY = 0.9;

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gambar tidak bisa dibuka'));
    img.src = src;
  });
}

/**
 * cropPx: croppedAreaPixels dari react-easy-crop. Koordinatnya relatif terhadap
 * bounding box gambar yang SUDAH diputar, jadi gambar digambar berputar di koordinat itu.
 * Canvas langsung dibuat seukuran hasil akhir (tanpa canvas perantara sebesar foto asli)
 * supaya tidak kena batas ukuran canvas di Safari iOS.
 */
export async function renderEditedImage({ src, cropPx, rotation, name, type }) {
  const img = await loadImage(src);
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const rad = (rotation * Math.PI) / 180;
  const sideways = Math.abs(rotation) % 180 === 90;
  const bw = sideways ? nh : nw;
  const bh = sideways ? nw : nh;

  const cw = Math.max(1, Math.round(cropPx.width));
  const ch = Math.max(1, Math.round(cropPx.height));
  const scale = Math.min(1, MAX_SIDE / Math.max(cw, ch));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cw * scale));
  canvas.height = Math.max(1, Math.round(ch * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  // PNG dipertahankan (bisa transparan / screenshot teks); selain itu jadi JPEG.
  const outType = type === 'image/png' ? 'image/png' : 'image/jpeg';
  if (outType === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.scale(scale, scale);
  ctx.translate(-cropPx.x, -cropPx.y);
  ctx.translate(bw / 2, bh / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -nw / 2, -nh / 2);

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Gagal menyimpan gambar'))), outType, JPEG_QUALITY));

  const base = (name || 'foto').replace(/\.[^.]+$/, '') || 'foto';
  const outName = `${base}.${outType === 'image/png' ? 'png' : 'jpg'}`;
  return new File([blob], outName, { type: outType, lastModified: Date.now() });
}

export const cameraFileName = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `kamera-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
};
