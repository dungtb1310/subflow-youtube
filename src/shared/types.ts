export type SubtitleMode = 'original' | 'dual' | 'translated';

export type AiProvider = 'offline' | 'gemini' | 'ollama' | 'openai';

export type DualOrder = 'original-top' | 'translated-top';

export type LiveSttEngine = 'gemini-live' | 'local-whisper';

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
  liveEngine: LiveSttEngine;
  liveSourceLanguage: string;
  localWhisperUrl: string;
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
  source: 'heuristic' | 'ai' | 'live';
  isInterim?: boolean;
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

export type LiveSessionState = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'error';

export interface LiveSessionStatus {
  active: boolean;
  tabId: number | null;
  tabTitle: string;
  engine: LiveSttEngine;
  state: LiveSessionState;
  audioLevel: number;
  startedAt: number | null;
  cueCount: number;
  latestOriginal: string;
  latestTranslated: string;
  error?: string;
}

export interface LiveCuePayload {
  id: string;
  original: string;
  translated?: string;
  isFinal: boolean;
  timestampMs: number;
}

// Messages sent from Content Script, Popup, or Offscreen Document to Background Service Worker
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
    }
  | {
      type: 'START_LIVE_AUDIO';
      payload: {
        tabId: number;
        tabTitle: string;
        tabUrl: string;
        streamId: string;
      };
    }
  | {
      type: 'STOP_LIVE_AUDIO';
    }
  | {
      type: 'GET_LIVE_STATUS';
    }
  | {
      type: 'EXPORT_LIVE_SRT';
    }
  | {
      type: 'TEST_LOCAL_WHISPER';
      payload: {
        localWhisperUrl: string;
      };
    }
  | {
      type: 'OFFSCREEN_TRANSCRIPT';
      payload: {
        text: string;
        isFinal: boolean;
        language?: string;
      };
    }
  | {
      type: 'OFFSCREEN_STATE';
      payload: {
        state: LiveSessionState;
        error?: string;
        fatal?: boolean;
      };
    }
  | {
      type: 'OFFSCREEN_AUDIO_LEVEL';
      payload: {
        level: number;
      };
    };

// Messages sent from Service Worker to Offscreen Document
export type OffscreenRequest =
  | {
      type: 'OFFSCREEN_START';
      payload: {
        streamId: string;
        engine: LiveSttEngine;
        geminiApiKey: string;
        liveSourceLanguage: string;
        localWhisperUrl: string;
      };
    }
  | {
      type: 'OFFSCREEN_STOP';
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

// Messages sent from Popup or Background to Active Tab Content Script / Live Overlay
export type ContentRequest =
  | { type: 'GET_STATUS' }
  | { type: 'EXPORT_SRT' }
  | { type: 'CLEAR_CACHE' }
  | { type: 'REPROCESS_VIDEO' }
  | {
      type: 'LIVE_SUBTITLE_UPDATE';
      payload: LiveCuePayload;
    }
  | {
      type: 'LIVE_SESSION_STATE';
      payload: {
        active: boolean;
        state: LiveSessionState;
        error?: string;
      };
    };

export interface ExportSrtResponse {
  ok: boolean;
  filename?: string;
  srt?: string;
  error?: string;
}
