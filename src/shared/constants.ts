import type { SubFlowSettings } from './types';

export const STORAGE_KEY = 'bettersubtitle_settings_v1';
export const LEGACY_STORAGE_KEY = 'subflow_settings_v1';

export const DEFAULT_SETTINGS: SubFlowSettings = {
  enabled: true,
  mode: 'original',
  targetLanguage: 'vi',
  provider: 'offline',
  geminiApiKey: '',
  geminiModel: 'gemini-3.5-flash-lite',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: 'gpt-4o-mini',
  fontSize: 22,
  bgOpacity: 0.78,
  bottomOffsetPercent: 9,
  dualOrder: 'original-top',
  hideNativeCaptions: true,
  pauseOnHover: false,
};

export interface LanguageOption {
  code: string;
  label: string;
  nativeName: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'vi', label: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'en', label: 'English', nativeName: 'English' },
  { code: 'ja', label: 'Japanese', nativeName: '日本語' },
  { code: 'ko', label: 'Korean', nativeName: '한국어' },
  { code: 'zh-Hans', label: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'fr', label: 'French', nativeName: 'Français' },
  { code: 'de', label: 'German', nativeName: 'Deutsch' },
  { code: 'es', label: 'Spanish', nativeName: 'Español' },
  { code: 'pt', label: 'Portuguese', nativeName: 'Português' },
  { code: 'th', label: 'Thai', nativeName: 'ไทย' },
  { code: 'id', label: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'ru', label: 'Russian', nativeName: 'Русский' },
];

export interface ModelPreset {
  id: string;
  label: string;
}

export const GEMINI_MODEL_PRESETS: ModelPreset[] = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (Fastest)' },
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen (Balanced)' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (High Quality)' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (Lightweight)' },
];

export interface OpenAiPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
}

export const OPENAI_PRESETS: OpenAiPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-3.5-flash-lite',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (Local)',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
  },
];

export function getLanguageLabel(code: string): string {
  const found = SUPPORTED_LANGUAGES.find((lang) => lang.code === code);
  return found ? found.label : code;
}
