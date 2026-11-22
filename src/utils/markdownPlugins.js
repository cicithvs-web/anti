// markdownPlugins.js — konfigurasi lengkap remark & rehype untuk ChatView:
// GFM, LaTeX math (KaTeX), GitHub Alerts, safe HTML (<br>, <details>, <kbd>, <mark>, <u>, <table>),
// dan syntax highlighting (highlight.js) dengan proteksi XSS via rehype-sanitize.
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';

const ALERT_TYPES = new Set(['note', 'tip', 'important', 'warning', 'caution']);

/**
 * Konversi delimiter LaTeX `\[...\]` dan `\(...\)` menjadi `$$...$$` dan `$...$`
 * di luar fenced code block (```/~~~) dan inline code (`...`) agar terdeteksi remark-math.
 */
export function preprocessLatex(raw) {
  const text = String(raw || '');
  if (!text.includes('\\(') && !text.includes('\\[')) return text;

  // Pisahkan bagian kode (fenced maupun inline) agar tidak pernah disentuh
  const tokenRe = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;
  const parts = text.split(tokenRe);
  for (let i = 0; i < parts.length; i += 2) {
    let seg = parts[i];
    // Display math: \[ ... \]
    seg = seg.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) => `\n$$\n${inner.trim()}\n$$\n`);
    // Inline math: \( ... \)
    seg = seg.replace(/\\\(([^\n]+?)\\\)/g, (_, inner) => `$${inner.trim()}$`);
    parts[i] = seg;
  }
  return parts.join('');
}

/**
 * Plugin remark untuk GitHub Alerts / Callouts:
 *   > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
 */
export function remarkAlerts() {
  return (tree) => {
    const walk = (node) => {
      if (!node || !Array.isArray(node.children)) return;
      for (const child of node.children) {
        if (child.type === 'blockquote' && Array.isArray(child.children) && child.children.length) {
          const first = child.children[0];
          if (first?.type === 'paragraph' && Array.isArray(first.children) && first.children.length) {
            const firstInline = first.children[0];
            if (firstInline?.type === 'text') {
              const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\r?\n|[ \t]+|$)/i.exec(firstInline.value);
              if (m) {
                const kind = m[1].toLowerCase();
                if (ALERT_TYPES.has(kind)) {
                  const rest = firstInline.value.slice(m[0].length);
                  if (rest) {
                    firstInline.value = rest;
                  } else {
                    first.children.shift();
                    // Jika langsung diikuti hard break / <br>, buang baris kosong pertamanya
                    if (first.children[0]?.type === 'break'
                      || (first.children[0]?.type === 'html' && /^<br\s*\/?>$/i.test(String(first.children[0].value || '').trim()))) {
                      first.children.shift();
                    }
                    if (!first.children.length) child.children.shift();
                  }
                  child.data = {
                    ...(child.data || {}),
                    hProperties: {
                      ...(child.data?.hProperties || {}),
                      'data-alert': kind,
                    },
                  };
                }
              }
            }
          }
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

/**
 * Skema sanitasi ketat berbasis GitHub defaultSchema:
 * - Izinkan tag HTML aman (<br>, <details>, <summary>, <sub>, <sup>, <kbd>, <mark>, <u>, <table>, dll.)
 * - Pertahankan className `language-*`, `math-inline`, `math-display`, task list, dan `data-alert`
 * - Tetap membuang <script>, <iframe>, event handler (onclick/onerror), dan URL berbahaya.
 */
export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: Array.from(new Set([...(defaultSchema.tagNames || []), 'mark', 'u'])),
  attributes: {
    ...(defaultSchema.attributes || {}),
    code: [
      ...(defaultSchema.attributes?.code || []),
      ['className', /^language-./, 'math-inline', 'math-display'],
    ],
    blockquote: [
      ...(defaultSchema.attributes?.blockquote || []),
      'dataAlert',
      'data-alert',
    ],
    ul: [
      ...(defaultSchema.attributes?.ul || []),
      ['className', 'contains-task-list'],
    ],
    li: [
      ...(defaultSchema.attributes?.li || []),
      ['className', 'task-list-item'],
    ],
    input: [
      ['type', 'checkbox'],
      ['disabled', true],
      'checked',
    ],
    td: ['align', 'colSpan', 'rowSpan'],
    th: ['align', 'colSpan', 'rowSpan'],
    details: ['open'],
  },
};

export const REMARK_PLUGINS = [
  remarkGfm,
  remarkMath,
  remarkAlerts,
];

export const REHYPE_PLUGINS = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  [rehypeKatex, { strict: false, throwOnError: false }],
  [rehypeHighlight, {
    detect: false,
    ignoreMissing: true,
    plainText: ['mermaid', 'math', 'text', 'txt', 'plaintext'],
  }],
];
