export type SubtitleMode = 'original' | 'dual' | 'translated';

export type AiProvider = 'offline' | 'gemini' | 'ollama' | 'openai';

export type DualOrder = 'original-top' | 'translated-top';

export interface SubFlowSettings {
  enabled: boolean;
  mode: SubtitleMode;
  targetLanguage: string;
  provider: AiProvider;
  geminiApiKey: string;
  geminiModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  fontSize: number;
  bgOpacity: number;
  bottomOffsetPercent: number;
  dualOrder: DualOrder;
  hideNativeCaptions: boolean;
  pauseOnHover: boolean;
}

export interface CaptionTrackInfo {
  languageCode: string;
  name: string;
  baseUrl: string;
  kind?: string;
  isTranslatable?: boolean;
  isDefault?: boolean;
}

export interface WordToken {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  original: string;
  translated?: string;
  source: 'heuristic' | 'ai';
}

export interface TranscriptChunk {
  chunkIndex: number;
  startWordIndex: number;
  endWordIndex: number;
  startMs: number;
  endMs: number;
  words: WordToken[];
}

export interface AiRawCue {
  startWord: number;
  endWord: number;
  original: string;
  translated?: string;
}

export type ManagerState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'processing'
  | 'no-captions'
  | 'error';

export interface RuntimeStatus {
  state: ManagerState;
  videoId: string | null;
  videoTitle: string;
  trackName: string;
  sourceLanguage: string;
  totalChunks: number;
  processedChunks: number;
  cueCount: number;
  provider: AiProvider;
  mode: SubtitleMode;
  message?: string;
}

// Messages sent from Content Script or Popup to Background Service Worker
export type BackgroundRequest =
  | {
      type: 'PROCESS_CHUNK';
      payload: {
        words: WordToken[];
        sourceLanguage: string;
        targetLanguage: string;
        mode: SubtitleMode;
        settings: SubFlowSettings;
        previousContext?: string;
      };
    }
  | {
      type: 'TEST_CONNECTION';
      payload: {
        settings: SubFlowSettings;
      };
    }
  | {
      type: 'LIST_OLLAMA_MODELS';
      payload: {
        ollamaUrl: string;
      };
    }
  | {
      type: 'ENSURE_CONTENT_SCRIPT';
      payload: {
        tabId: number;
      };
    };

export interface ProcessChunkResponse {
  ok: boolean;
  cues?: SubtitleCue[];
  error?: string;
}

export interface TestConnectionResponse {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface ListOllamaModelsResponse {
  ok: boolean;
  models?: string[];
  error?: string;
}

// Messages sent from Popup to Active YouTube Content Script
export type ContentRequest =
  | { type: 'GET_STATUS' }
  | { type: 'EXPORT_SRT' }
  | { type: 'CLEAR_CACHE' }
  | { type: 'REPROCESS_VIDEO' };

export interface ExportSrtResponse {
  ok: boolean;
  filename?: string;
  srt?: string;
  error?: string;
}
