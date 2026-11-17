// Fallback sebelum login; daftar asli diambil dari `agy models` via /api/models
export const DEFAULT_MODEL = 'gemini-3.8-flash-high';
export const MODELS = [
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', desc: 'Default agybot' },
];

// Jadwal limit per provider
export const LIMITS = {
  gemini: [
    { label: '5 jam', desc: 'Reset tiap 5 jam' },
    { label: '1 minggu', desc: 'Reset tiap minggu' },
  ],
  claude: [
    { label: '5 jam', desc: 'Reset tiap 5 jam' },
    { label: '1 minggu', desc: 'Reset tiap minggu' },
  ],
  gpt: [
    { label: '5 jam', desc: 'Reset tiap 5 jam' },
    { label: '1 minggu', desc: 'Reset tiap minggu' },
  ],
};

export function providerOf(modelId) {
  const m = (modelId || '').split('/')[0];
  if (m === 'claude' || m === 'anthropic') return 'claude';
  if (m === 'gpt' || m === 'openai') return 'gpt';
  return 'gemini';
}
