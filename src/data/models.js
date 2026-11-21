// Fallback sebelum login; daftar asli diambil dari `agy models` via /api/models
export const DEFAULT_MODEL = 'gemini-3.8-flash-high';
export const DEFAULT_UPLOAD_LIMITS = { files: 20, fileSizeMb: 100 };
export const MODELS = [
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', desc: 'Default agybot' },
];
