import { exportCuesToSrt } from '../shared/srt';
import { loadSettings } from '../shared/storage';
import type {
  BackgroundRequest,
  ContentRequest,
  ExportSrtResponse,
  ListOllamaModelsResponse,
  LiveSessionStatus,
  OffscreenRequest,
  ProcessChunkResponse,
  SubtitleCue,
  TestConnectionResponse,
} from '../shared/types';
import {
  listOllamaModels,
  processTranscriptChunk,
  testLocalWhisperServer,
  testProviderConnection,
  translateLiveSentence,
} from './ai-client';

const OFFSCREEN_PATH = 'offscreen.html';
const YOUTUBE_URL_RE = /^https:\/\/(www|m)\.youtube\.com\//i;

let liveStatus: LiveSessionStatus = {
  active: false,
  tabId: null,
  tabTitle: '',
  engine: 'gemini-live',
  state: 'idle',
  audioLevel: 0,
  startedAt: null,
  cueCount: 0,
  latestOriginal: '',
  latestTranslated: '',
};

let liveCues: SubtitleCue[] = [];
let liveCueSeq = 0;
let liveEpoch = 0;

async function injectIntoYouTubeTab(tabId: number): Promise<boolean> {
  if (!chrome.scripting?.executeScript) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-bridge.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'ISOLATED',
    });
    return true;
  } catch {
    return false;
  }
}

async function injectUniversalLiveOverlay(tabId: number): Promise<boolean> {
  if (!chrome.scripting?.executeScript) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['live-overlay.js'],
      world: 'ISOLATED',
    });
    return true;
  } catch {
    return false;
  }
}

async function injectIntoOpenYouTubeTabs(): Promise<void> {
  if (!chrome.tabs?.query) return;
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
    });
    for (const tab of tabs) {
      if (typeof tab.id === 'number') {
        void injectIntoYouTubeTab(tab.id);
      }
    }
  } catch {
    // non-fatal
  }
}

function sendTabMessageSafe(tabId: number, msg: ContentRequest): void {
  try {
    chrome.tabs.sendMessage(tabId, msg, () => {
      // Read lastError to avoid unhandled unchecked runtime.lastError warnings
      void chrome.runtime.lastError;
    });
  } catch {
    // ignore
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('Offscreen API is unavailable in this browser version.');
  }

  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (typeof chrome.runtime.getContexts === 'function') {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
      documentUrls: [offscreenUrl],
    });
    if (existing.length > 0) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
      justification: 'Capture active tab audio for realtime livestream subtitle transcription.',
    });
  } catch (err) {
    // If document already exists on older Chrome without getContexts, ignore duplicate error
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('single offscreen')) {
      throw err;
    }
  }
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    if (chrome.offscreen?.closeDocument) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    // ignore if already closed
  }
}

async function startLiveAudioSession(payload: {
  tabId: number;
  tabTitle: string;
  tabUrl: string;
  streamId: string;
}): Promise<{ ok: boolean; status: LiveSessionStatus; error?: string }> {
  const settings = await loadSettings();

  if (settings.liveEngine === 'gemini-live' && !settings.geminiApiKey.trim()) {
    const err = 'Enter your Gemini API key in the AI Engine tab first (or switch to Local Whisper).';
    liveStatus = {
      ...liveStatus,
      active: false,
      state: 'error',
      error: err,
    };
    return { ok: false, status: { ...liveStatus }, error: err };
  }

  // Cleanly stop any prior live session first
  if (liveStatus.active) {
    await stopLiveAudioSession();
  }

  liveEpoch++;
  liveCues = [];
  liveCueSeq = 0;

  // Mount overlay on target tab (YouTube uses native content.js; any other site gets live-overlay.js)
  if (YOUTUBE_URL_RE.test(payload.tabUrl)) {
    await injectIntoYouTubeTab(payload.tabId);
  } else {
    await injectUniversalLiveOverlay(payload.tabId);
  }

  liveStatus = {
    active: true,
    tabId: payload.tabId,
    tabTitle: payload.tabTitle,
    engine: settings.liveEngine,
    state: 'connecting',
    audioLevel: 0,
    startedAt: Date.now(),
    cueCount: 0,
    latestOriginal: '',
    latestTranslated: '',
    error: undefined,
  };

  sendTabMessageSafe(payload.tabId, {
    type: 'LIVE_SESSION_STATE',
    payload: { active: true, state: 'connecting' },
  });

  try {
    await ensureOffscreenDocument();
    const startRes = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const req: OffscreenRequest = {
        type: 'OFFSCREEN_START',
        payload: {
          streamId: payload.streamId,
          engine: settings.liveEngine,
          geminiApiKey: settings.geminiApiKey,
          liveSourceLanguage: settings.liveSourceLanguage,
          localWhisperUrl: settings.localWhisperUrl,
        },
      };
      chrome.runtime.sendMessage(req, (resp?: { ok: boolean; error?: string }) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp ?? { ok: false, error: 'Offscreen audio capture did not respond.' });
      });
    });

    if (!startRes.ok) {
      throw new Error(startRes.error || 'Failed to start tab audio capture.');
    }

    return { ok: true, status: { ...liveStatus } };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    liveStatus = {
      ...liveStatus,
      active: false,
      state: 'error',
      error: errorMsg,
    };
    sendTabMessageSafe(payload.tabId, {
      type: 'LIVE_SESSION_STATE',
      payload: { active: false, state: 'error', error: errorMsg },
    });
    await closeOffscreenDocument();
    return { ok: false, status: { ...liveStatus }, error: errorMsg };
  }
}

async function stopLiveAudioSession(): Promise<{ ok: boolean; status: LiveSessionStatus }> {
  const prevTabId = liveStatus.tabId;
  liveEpoch++;

  try {
    await new Promise<void>((resolve) => {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' } satisfies OffscreenRequest, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  } catch {
    // ignore
  }

  await closeOffscreenDocument();

  liveStatus = {
    ...liveStatus,
    active: false,
    tabId: null,
    state: 'idle',
    audioLevel: 0,
    error: undefined,
  };

  if (prevTabId !== null) {
    sendTabMessageSafe(prevTabId, {
      type: 'LIVE_SESSION_STATE',
      payload: { active: false, state: 'idle' },
    });
  }

  return { ok: true, status: { ...liveStatus } };
}

async function handleLiveTranscript(payload: {
  text: string;
  isFinal: boolean;
  language?: string;
}): Promise<void> {
  if (!liveStatus.active || liveStatus.tabId === null) return;
  const text = payload.text.trim();
  if (!text) return;

  const targetTabId = liveStatus.tabId;
  const myEpoch = liveEpoch;
  const elapsedMs = Math.max(0, Date.now() - (liveStatus.startedAt ?? Date.now()));

  if (!payload.isFinal) {
    liveStatus.latestOriginal = text;
    sendTabMessageSafe(targetTabId, {
      type: 'LIVE_SUBTITLE_UPDATE',
      payload: {
        id: `live-interim-${liveCueSeq}`,
        original: text,
        isFinal: false,
        timestampMs: elapsedMs,
      },
    });
    return;
  }

  // Finalized sentence
  const cueId = `live-${++liveCueSeq}`;
  const prevCue = liveCues[liveCues.length - 1];
  const startMs = prevCue ? Math.max(prevCue.endMs, elapsedMs - 2500) : Math.max(0, elapsedMs - 2500);
  const cue: SubtitleCue = {
    id: cueId,
    startMs,
    endMs: Math.max(startMs + 1200, elapsedMs + 400),
    original: text,
    source: 'live',
  };
  liveCues.push(cue);
  liveStatus.cueCount = liveCues.length;
  liveStatus.latestOriginal = text;
  liveStatus.latestTranslated = '';

  // Push finalized original sentence right away so user never waits for translation
  sendTabMessageSafe(targetTabId, {
    type: 'LIVE_SUBTITLE_UPDATE',
    payload: {
      id: cueId,
      original: text,
      isFinal: true,
      timestampMs: elapsedMs,
    },
  });

  // Translate if Dual or Translated mode is active
  const settings = await loadSettings();
  if (settings.mode === 'original') return;

  const recentHistory = liveCues.slice(-4, -1).map((c) => c.original);
  try {
    const translated = await translateLiveSentence({
      text,
      targetLanguage: settings.targetLanguage,
      settings,
      recentHistory,
    });
    if (myEpoch !== liveEpoch || !liveStatus.active || !translated) return;

    cue.translated = translated;
    if (liveStatus.latestOriginal === text) {
      liveStatus.latestTranslated = translated;
    }

    sendTabMessageSafe(targetTabId, {
      type: 'LIVE_SUBTITLE_UPDATE',
      payload: {
        id: cueId,
        original: text,
        translated,
        isFinal: true,
        timestampMs: elapsedMs,
      },
    });
  } catch {
    // Non-fatal: keep finalized original sentence visible
  }
}

async function exportLiveSrt(): Promise<ExportSrtResponse> {
  if (liveCues.length === 0) {
    return { ok: false, error: 'No live transcript sentences recorded yet.' };
  }
  const settings = await loadSettings();
  const srt = exportCuesToSrt(liveCues, settings.mode, settings.dualOrder);
  const safeTitle = (liveStatus.tabTitle || 'live-stream')
    .replace(/[<>:"/\\|?*]+/g, '')
    .trim()
    .slice(0, 56);
  return {
    ok: true,
    filename: `${safeTitle || 'bettersubtitle-live'}.live.srt`,
    srt,
  };
}

chrome.runtime.onInstalled.addListener(() => {
  void injectIntoOpenYouTubeTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void injectIntoOpenYouTubeTabs();
});

chrome.tabs.onRemoved.addListener((closedTabId) => {
  if (liveStatus.active && liveStatus.tabId === closedTabId) {
    void stopLiveAudioSession();
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundRequest,
    _sender,
    sendResponse: (
      resp:
        | ProcessChunkResponse
        | TestConnectionResponse
        | ListOllamaModelsResponse
        | ExportSrtResponse
        | LiveSessionStatus
        | { ok: boolean; status?: LiveSessionStatus; error?: string },
    ) => void,
  ) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    if (message.type === 'PROCESS_CHUNK') {
      processTranscriptChunk(message.payload)
        .then((cues) => sendResponse({ ok: true, cues }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'TEST_CONNECTION') {
      testProviderConnection(message.payload.settings)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'LIST_OLLAMA_MODELS') {
      listOllamaModels(message.payload.ollamaUrl)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'ENSURE_CONTENT_SCRIPT') {
      injectIntoYouTubeTab(message.payload.tabId)
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === 'TEST_LOCAL_WHISPER') {
      testLocalWhisperServer(message.payload.localWhisperUrl)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'START_LIVE_AUDIO') {
      startLiveAudioSession(message.payload)
        .then((res) => sendResponse(res))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'STOP_LIVE_AUDIO') {
      stopLiveAudioSession()
        .then((res) => sendResponse(res))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === 'GET_LIVE_STATUS') {
      sendResponse({ ...liveStatus });
      return false;
    }

    if (message.type === 'EXPORT_LIVE_SRT') {
      exportLiveSrt()
        .then((res) => sendResponse(res))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'OFFSCREEN_AUDIO_LEVEL') {
      if (liveStatus.active) {
        liveStatus.audioLevel = message.payload.level;
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'OFFSCREEN_STATE') {
      liveStatus.state = message.payload.state;
      liveStatus.error = message.payload.state === 'listening' ? undefined : message.payload.error;
      if (
        message.payload.state === 'idle' ||
        (message.payload.state === 'error' && message.payload.fatal)
      ) {
        liveStatus.active = false;
        liveStatus.audioLevel = 0;
        void closeOffscreenDocument();
      }
      if (liveStatus.tabId !== null) {
        sendTabMessageSafe(liveStatus.tabId, {
          type: 'LIVE_SESSION_STATE',
          payload: {
            active: liveStatus.active,
            state: message.payload.state,
            error: liveStatus.error,
          },
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'OFFSCREEN_TRANSCRIPT') {
      void handleLiveTranscript(message.payload);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  },
);
