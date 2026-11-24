// linkify.js — deteksi tautan aman untuk bubble user & Markdown AI:
// Mendukung https://..., http://..., www...., dan domain polos (mis. github.com, github.com/user, gay.my.id)
// tanpa salah mendeteksi email (user@gmail.com) atau nama file lokal (app.js, render.py, video.mp4).

const WEB_TLDS = [
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro',
  'io', 'dev', 'app', 'ai', 'gg', 'me', 'co', 'tv', 'cc', 'ly', 'be', 'to', 'gl',
  'xyz', 'site', 'online', 'store', 'cloud', 'tech', 'shop', 'blog', 'live', 'news',
  'page', 'link', 'fun', 'vip', 'top', 'icu', 'wiki', 'space', 'digital', 'agency',
  'id', 'my', 'sg', 'uk', 'us', 'au', 'ca', 'de', 'fr', 'jp', 'kr', 'nl', 'se', 'ch', 'eu', 'in', 'ru', 'br', 'cn',
].join('|');

// Cocokkan salah satu:
//   1. https?://...
//   2. www.<domain>.<tld>...
//   3. <domain>.<tld>... (dengan TLD web yang valid, termasuk 2-level seperti .co.id / .my.id)
const URL_RE = new RegExp(
  '(?:https?:\\/\\/[^\\s<>"\'`]+|'
  + 'www\\.(?:[a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(?::\\d{1,5})?(?:\\/[^\\s<>"\'`]*)?|'
  + '(?:[a-zA-Z0-9-]+\\.)+(?:' + WEB_TLDS + ')(?::\\d{1,5})?(?:[/?#][^\\s<>"\'`]*)?)',
  'gi',
);

const BOUNDARY_BEFORE_RE = /[a-zA-Z0-9_@./-]/;
const TRAILING_PUNCT_RE = /[.,;:!?"'\]}>]+$/;

function trimTrailing(raw) {
  let url = raw;
  for (;;) {
    const prev = url;
    url = url.replace(TRAILING_PUNCT_RE, '');
    // Potong ')' penutup di akhir hanya jika tidak berpasangan dengan '(' di dalam URL (aman untuk URL Wikipedia)
    while (url.endsWith(')')) {
      const opens = (url.match(/\(/g) || []).length;
      const closes = (url.match(/\)/g) || []).length;
      if (closes > opens) url = url.slice(0, -1);
      else break;
    }
    if (url === prev) break;
  }
  return url;
}

/**
 * Pecah teks polos menjadi array segmen:
 *   { type: 'text', value: string } | { type: 'link', text: string, href: string }
 */
export function splitTextWithLinks(text) {
  const src = String(text || '');
  if (!src) return [];

  URL_RE.lastIndex = 0;
  const out = [];
  let cursor = 0;
  let m;

  while ((m = URL_RE.exec(src)) !== null) {
    const start = m.index;
    const raw = m[0];

    // Cegah kecocokan di tengah kata, path relatif (/foo/bar.com), atau alamat email (user@gmail.com)
    if (start > 0 && BOUNDARY_BEFORE_RE.test(src[start - 1])) continue;

    const clean = trimTrailing(raw);
    if (!clean) continue;

    // Jika bare domain langsung diikuti '@' (email), huruf/angka (foo.comx), atau '.<label>' (trakteer.id.1@gmail.com, app.id.bak), lewati.
    // Titik akhir kalimat biasa (mis. "gay.my.id/app.") tetap diizinkan.
    const rest = src.slice(start + clean.length);
    if (rest.startsWith('@')) continue;
    if (!/^https?:\/\//i.test(clean) && /^(?:[a-zA-Z0-9_-]|\.[a-zA-Z0-9_-])/.test(rest)) continue;

    const href = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;

    if (start > cursor) out.push({ type: 'text', value: src.slice(cursor, start) });
    out.push({ type: 'link', text: clean, href });
    cursor = start + clean.length;
    URL_RE.lastIndex = cursor;
  }

  if (cursor < src.length) out.push({ type: 'text', value: src.slice(cursor) });
  return out;
}
