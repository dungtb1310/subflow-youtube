import {
  GEMINI_MODEL_PRESETS,
  LIVE_SOURCE_LANGUAGES,
  OPENAI_PRESETS,
  SUPPORTED_LANGUAGES,
} from '../shared/constants';
import { loadSettings, normalizeSettings, saveSettings } from '../shared/storage';
import type {
  AiProvider,
  BackgroundRequest,
  ContentRequest,
  DualOrder,
  ExportSrtResponse,
  ListOllamaModelsResponse,
  LiveSessionStatus,
  LiveSttEngine,
  RuntimeStatus,
  SubFlowSettings,
  SubtitleMode,
  TestConnectionResponse,
} from '../shared/types';

const MODE_HINTS: Record<SubtitleMode, string> = {
  original:
    "Merges choppy word-by-word captions into clean punctuated sentences in the video's original language.",
  dual: 'Shows both the cleaned original sentence and a contextual translation stacked together.',
  translated: 'Reconstructs complete sentences and shows only the natural translation.',
};

const CUSTOM_MODEL_VALUE = '__custom__';

function qs<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

function sendBackground<T>(msg: BackgroundRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('Extension runtime unavailable.'));
      return;
    }
    chrome.runtime.sendMessage(msg, (response: T) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function queryActiveYouTubeTab(): Promise<chrome.tabs.Tab | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return null;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) return null;
  if (!/^https:\/\/(www|m)\.youtube\.com\//i.test(tab.url)) return null;
  return tab;
}

async function sendMessageOnce<T>(tabId: number, msg: ContentRequest): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (response: T) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response ?? null);
    });
  });
}

async function sendToActiveTab<T>(msg: ContentRequest): Promise<T | null> {
  const tab = await queryActiveYouTubeTab();
  if (!tab?.id) return null;
  const first = await sendMessageOnce<T>(tab.id, msg);
  if (first !== null) return first;

  // Auto-inject into already-open YouTube tabs (e.g. opened before extension install/reload)
  try {
    const injected = await sendBackground<{ ok: boolean }>({
      type: 'ENSURE_CONTENT_SCRIPT',
      payload: { tabId: tab.id },
    });
    if (injected?.ok) {
      await new Promise((r) => setTimeout(r, 280));
      return await sendMessageOnce<T>(tab.id, msg);
    }
  } catch {
    // ignore
  }
  return null;
}

function triggerFileDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function initPopup(): Promise<void> {
  let settings: SubFlowSettings = await loadSettings();

  // Header & Tabs
  const masterToggle = qs<HTMLButtonElement>('#master-toggle');
  const headerStatus = qs<HTMLSpanElement>('#header-status');
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
  const panels: Record<string, HTMLElement> = {
    subtitles: qs<HTMLElement>('#panel-subtitles'),
    live: qs<HTMLElement>('#panel-live'),
    ai: qs<HTMLElement>('#panel-ai'),
    style: qs<HTMLElement>('#panel-style'),
  };

  // Live Audio tab controls
  const liveTabDot = qs<HTMLSpanElement>('#live-tab-dot');
  const liveToggleBtn = qs<HTMLButtonElement>('#live-toggle-btn');
  const liveToggleLabel = qs<HTMLSpanElement>('#live-toggle-label');
  const liveStateText = qs<HTMLSpanElement>('#live-state-text');
  const liveMeterRow = qs<HTMLDivElement>('#live-meter-row');
  const liveMeterFill = qs<HTMLDivElement>('#live-meter-fill');
  const liveElapsedEl = qs<HTMLSpanElement>('#live-elapsed');
  const liveEngineButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-live-engine]'),
  );
  const liveSourceLangSelect = qs<HTMLSelectElement>('#live-source-lang');
  const liveConfigGemini = qs<HTMLDivElement>('#live-config-gemini');
  const liveGeminiMissingKey = qs<HTMLDivElement>('#live-gemini-missing-key');
  const liveJumpAiBtn = qs<HTMLButtonElement>('#live-jump-ai-btn');
  const liveConfigWhisper = qs<HTMLDivElement>('#live-config-whisper');
  const localWhisperUrlInput = qs<HTMLInputElement>('#local-whisper-url');
  const testWhisperBtn = qs<HTMLButtonElement>('#test-whisper-btn');
  const liveFeedbackEl = qs<HTMLDivElement>('#live-feedback');
  const exportLiveSrtBtn = qs<HTMLButtonElement>('#export-live-srt-btn');
  const liveLatestOrigEl = qs<HTMLDivElement>('#live-latest-orig');
  const liveLatestTransEl = qs<HTMLDivElement>('#live-latest-trans');

  let liveStatus: LiveSessionStatus = {
    active: false,
    tabId: null,
    tabTitle: '',
    engine: settings.liveEngine,
    state: 'idle',
    audioLevel: 0,
    startedAt: null,
    cueCount: 0,
    latestOriginal: '',
    latestTranslated: '',
  };

  // Subtitles tab controls
  const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mode]'));
  const modeHint = qs<HTMLParagraphElement>('#mode-hint');
  const targetLangSelect = qs<HTMLSelectElement>('#target-language');
  const offlineTranslateNotice = qs<HTMLDivElement>('#offline-translate-notice');
  const jumpAiBtn = qs<HTMLButtonElement>('#jump-ai-btn');
  const videoTitleEl = qs<HTMLDivElement>('#video-title');
  const videoMetaEl = qs<HTMLDivElement>('#video-meta');
  const exportSrtBtn = qs<HTMLButtonElement>('#export-srt-btn');
  const reprocessBtn = qs<HTMLButtonElement>('#reprocess-btn');
  const activeEngineBadge = qs<HTMLSpanElement>('#active-engine-badge');

  // AI tab controls
  const providerButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-provider]'),
  );
  const providerPanels: Record<AiProvider, HTMLElement> = {
    offline: qs<HTMLElement>('#config-offline'),
    gemini: qs<HTMLElement>('#config-gemini'),
    ollama: qs<HTMLElement>('#config-ollama'),
    openai: qs<HTMLElement>('#config-openai'),
  };

  const geminiApiKeyInput = qs<HTMLInputElement>('#gemini-api-key');
  const geminiModelPreset = qs<HTMLSelectElement>('#gemini-model-preset');
  const geminiCustomModelGroup = qs<HTMLDivElement>('#gemini-custom-model-group');
  const geminiCustomModelInput = qs<HTMLInputElement>('#gemini-custom-model');

  const ollamaUrlInput = qs<HTMLInputElement>('#ollama-url');
  const ollamaModelInput = qs<HTMLInputElement>('#ollama-model');
  const ollamaModelList = qs<HTMLDataListElement>('#ollama-model-list');
  const scanOllamaBtn = qs<HTMLButtonElement>('#scan-ollama-btn');

  const openaiPresetsEl = qs<HTMLDivElement>('#openai-presets');
  const openaiBaseUrlInput = qs<HTMLInputElement>('#openai-base-url');
  const openaiApiKeyInput = qs<HTMLInputElement>('#openai-api-key');
  const openaiModelInput = qs<HTMLInputElement>('#openai-model');

  const testConnBtn = qs<HTMLButtonElement>('#test-connection-btn');
  const clearCacheBtn = qs<HTMLButtonElement>('#clear-cache-btn');
  const connResultEl = qs<HTMLDivElement>('#connection-result');

  // Style tab controls
  const previewCueEl = qs<HTMLDivElement>('#preview-cue');
  const previewPrimaryEl = qs<HTMLParagraphElement>('#preview-primary');
  const previewSecondaryEl = qs<HTMLParagraphElement>('#preview-secondary');
  const fontSizeInput = qs<HTMLInputElement>('#font-size');
  const fontSizeVal = qs<HTMLSpanElement>('#font-size-val');
  const bgOpacityInput = qs<HTMLInputElement>('#bg-opacity');
  const bgOpacityVal = qs<HTMLSpanElement>('#bg-opacity-val');
  const bottomOffsetInput = qs<HTMLInputElement>('#bottom-offset');
  const bottomOffsetVal = qs<HTMLSpanElement>('#bottom-offset-val');
  const dualOrderButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-dual-order]'),
  );
  const hideNativeToggle = qs<HTMLInputElement>('#hide-native-toggle');
  const pauseHoverToggle = qs<HTMLInputElement>('#pause-hover-toggle');

  // Populate static selects & presets
  for (const lang of SUPPORTED_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = `${lang.label} — ${lang.nativeName}`;
    targetLangSelect.appendChild(opt);
  }

  for (const preset of GEMINI_MODEL_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    geminiModelPreset.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_MODEL_VALUE;
  customOpt.textContent = 'Custom model ID...';
  geminiModelPreset.appendChild(customOpt);

  for (const preset of OPENAI_PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn';
    chip.textContent = preset.label;
    chip.addEventListener('click', () => {
      openaiBaseUrlInput.value = preset.baseUrl;
      openaiModelInput.value = preset.defaultModel;
      void commitPatch({
        openaiBaseUrl: preset.baseUrl,
        openaiModel: preset.defaultModel,
      });
    });
    openaiPresetsEl.appendChild(chip);
  }

  for (const lang of LIVE_SOURCE_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    liveSourceLangSelect.appendChild(opt);
  }

  function switchTab(tabId: 'subtitles' | 'live' | 'ai' | 'style'): void {
    for (const btn of tabButtons) {
      const selected = btn.dataset.tab === tabId;
      btn.setAttribute('aria-selected', String(selected));
    }
    for (const [id, panel] of Object.entries(panels)) {
      panel.classList.toggle('hidden', id !== tabId);
    }
  }

  function showLiveFeedback(text: string, tone: 'ok' | 'err' | 'neutral' = 'neutral'): void {
    liveFeedbackEl.textContent = text;
    liveFeedbackEl.classList.remove('hidden', 'ok', 'err');
    if (tone === 'ok') liveFeedbackEl.classList.add('ok');
    if (tone === 'err') liveFeedbackEl.classList.add('err');
  }

  function formatElapsed(startedAt: number | null): string {
    if (!startedAt) return '00:00';
    const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function renderLiveStatus(): void {
    const active = liveStatus.active;
    liveTabDot.classList.toggle('hidden', !active);

    if (active) {
      liveToggleBtn.classList.remove('btn-primary', 'btn-live-start');
      liveToggleBtn.classList.add('btn-live-stop');
      liveToggleLabel.textContent = 'Stop Live Audio Capture';
      liveMeterRow.classList.remove('hidden');
      liveMeterFill.style.width = `${Math.round(Math.min(1, Math.max(0.04, liveStatus.audioLevel)) * 100)}%`;
      liveElapsedEl.textContent = `${formatElapsed(liveStatus.startedAt)} · ${liveStatus.cueCount} cue${liveStatus.cueCount === 1 ? '' : 's'}`;

      const tabLabel = liveStatus.tabTitle ? ` (${liveStatus.tabTitle.slice(0, 32)})` : '';
      if (liveStatus.state === 'connecting') {
        liveStateText.textContent = `Connecting live audio${tabLabel}...`;
      } else if (liveStatus.state === 'reconnecting') {
        liveStateText.textContent = `Reconnecting live audio${tabLabel}...`;
      } else {
        liveStateText.textContent = `Listening to active tab${tabLabel}`;
      }

      headerStatus.textContent = 'Live';
      headerStatus.dataset.tone = 'active';
    } else {
      liveToggleBtn.classList.remove('btn-live-stop');
      liveToggleBtn.classList.add('btn-primary', 'btn-live-start');
      liveToggleLabel.textContent = 'Start Live Audio Capture';
      liveMeterRow.classList.add('hidden');
      liveStateText.textContent =
        'Captures audio from the active tab (YouTube Live, Twitch, videos without CC).';
    }

    if (liveStatus.state === 'error' && liveStatus.error) {
      showLiveFeedback(liveStatus.error, 'err');
    }

    exportLiveSrtBtn.disabled = liveStatus.cueCount === 0;
    liveLatestOrigEl.textContent =
      liveStatus.latestOriginal || (active ? 'Listening for speech...' : 'Waiting for live audio...');
    if (liveStatus.latestTranslated) {
      liveLatestTransEl.textContent = liveStatus.latestTranslated;
      liveLatestTransEl.classList.remove('hidden');
    } else {
      liveLatestTransEl.textContent = '';
      liveLatestTransEl.classList.add('hidden');
    }
  }

  function showFeedback(text: string, tone: 'ok' | 'err' | 'neutral' = 'neutral'): void {
    connResultEl.textContent = text;
    connResultEl.classList.remove('hidden', 'ok', 'err');
    if (tone === 'ok') connResultEl.classList.add('ok');
    if (tone === 'err') connResultEl.classList.add('err');
  }

  function renderPreview(): void {
    const scaledSize = Math.round(10 + ((settings.fontSize - 14) / 22) * 8);
    previewCueEl.style.background = `rgba(13, 16, 22, ${settings.bgOpacity})`;
    previewPrimaryEl.style.fontSize = `${scaledSize}px`;
    previewSecondaryEl.style.fontSize = `${Math.max(10, Math.round(scaledSize * 0.85))}px`;

    const sampleOrig = 'YouTube subtitles should read like real sentences.';
    const sampleTrans = 'Phụ đề YouTube nên đọc mượt như câu văn thực thụ.';

    if (settings.mode === 'original') {
      previewPrimaryEl.textContent = sampleOrig;
      previewSecondaryEl.classList.add('hidden');
    } else if (settings.mode === 'translated') {
      previewPrimaryEl.textContent = sampleTrans;
      previewSecondaryEl.classList.add('hidden');
    } else {
      previewSecondaryEl.classList.remove('hidden');
      if (settings.dualOrder === 'translated-top') {
        previewPrimaryEl.textContent = sampleTrans;
        previewSecondaryEl.textContent = sampleOrig;
      } else {
        previewPrimaryEl.textContent = sampleOrig;
        previewSecondaryEl.textContent = sampleTrans;
      }
    }
  }

  function renderSettings(): void {
    masterToggle.setAttribute('aria-checked', String(settings.enabled));

    for (const btn of modeButtons) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.mode));
    }
    modeHint.textContent = MODE_HINTS[settings.mode];

    targetLangSelect.value = settings.targetLanguage;
    targetLangSelect.disabled = settings.mode === 'original';

    const needsAiForTranslation =
      settings.provider === 'offline' && settings.mode !== 'original';
    offlineTranslateNotice.classList.toggle('hidden', !needsAiForTranslation);

    const engineBadgeMap: Record<AiProvider, string> = {
      offline: 'Offline Merger',
      gemini: `Gemini · ${settings.geminiModel}`,
      ollama: `Ollama · ${settings.ollamaModel}`,
      openai: `OpenAI · ${settings.openaiModel}`,
    };
    activeEngineBadge.textContent = engineBadgeMap[settings.provider];

    for (const btn of providerButtons) {
      btn.setAttribute('aria-pressed', String(btn.dataset.provider === settings.provider));
    }
    for (const [prov, el] of Object.entries(providerPanels)) {
      el.classList.toggle('hidden', prov !== settings.provider);
    }

    if (document.activeElement !== geminiApiKeyInput) {
      geminiApiKeyInput.value = settings.geminiApiKey;
    }
    const isPresetModel = GEMINI_MODEL_PRESETS.some((p) => p.id === settings.geminiModel);
    if (isPresetModel) {
      geminiModelPreset.value = settings.geminiModel;
      geminiCustomModelGroup.classList.add('hidden');
    } else {
      geminiModelPreset.value = CUSTOM_MODEL_VALUE;
      if (document.activeElement !== geminiCustomModelInput) {
        geminiCustomModelInput.value = settings.geminiModel;
      }
      geminiCustomModelGroup.classList.remove('hidden');
    }

    if (document.activeElement !== ollamaUrlInput) {
      ollamaUrlInput.value = settings.ollamaUrl;
    }
    if (document.activeElement !== ollamaModelInput) {
      ollamaModelInput.value = settings.ollamaModel;
    }

    if (document.activeElement !== openaiBaseUrlInput) {
      openaiBaseUrlInput.value = settings.openaiBaseUrl;
    }
    if (document.activeElement !== openaiApiKeyInput) {
      openaiApiKeyInput.value = settings.openaiApiKey;
    }
    if (document.activeElement !== openaiModelInput) {
      openaiModelInput.value = settings.openaiModel;
    }

    fontSizeInput.value = String(settings.fontSize);
    fontSizeVal.textContent = `${settings.fontSize}px`;

    const opacityPct = Math.round(settings.bgOpacity * 100);
    bgOpacityInput.value = String(opacityPct);
    bgOpacityVal.textContent = `${opacityPct}%`;

    bottomOffsetInput.value = String(settings.bottomOffsetPercent);
    bottomOffsetVal.textContent = `${settings.bottomOffsetPercent}%`;

    for (const btn of dualOrderButtons) {
      btn.setAttribute('aria-pressed', String(btn.dataset.dualOrder === settings.dualOrder));
    }

    hideNativeToggle.checked = settings.hideNativeCaptions;
    pauseHoverToggle.checked = settings.pauseOnHover;

    for (const btn of liveEngineButtons) {
      btn.setAttribute('aria-pressed', String(btn.dataset.liveEngine === settings.liveEngine));
    }
    liveSourceLangSelect.value = settings.liveSourceLanguage;
    liveConfigGemini.classList.toggle('hidden', settings.liveEngine !== 'gemini-live');
    liveConfigWhisper.classList.toggle('hidden', settings.liveEngine !== 'local-whisper');
    liveGeminiMissingKey.classList.toggle(
      'hidden',
      settings.liveEngine !== 'gemini-live' || settings.geminiApiKey.trim().length > 0,
    );
    if (document.activeElement !== localWhisperUrlInput) {
      localWhisperUrlInput.value = settings.localWhisperUrl;
    }

    renderPreview();
  }

  let pendingDebouncedPatch: Partial<SubFlowSettings> = {};
  let saveTimer: number | null = null;

  async function commitPatch(patch: Partial<SubFlowSettings>): Promise<void> {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    const mergedPatch = { ...pendingDebouncedPatch, ...patch };
    pendingDebouncedPatch = {};
    settings = normalizeSettings({ ...settings, ...mergedPatch });
    renderSettings();
    settings = await saveSettings(mergedPatch);
    renderSettings();
  }

  async function refreshActiveVideoStatus(): Promise<void> {
    if (!settings.enabled) {
      headerStatus.textContent = 'Paused';
      headerStatus.dataset.tone = 'idle';
    }

    const status = await sendToActiveTab<RuntimeStatus>({ type: 'GET_STATUS' });
    if (!status || !status.videoId) {
      if (settings.enabled) {
        headerStatus.textContent = 'Standby';
        headerStatus.dataset.tone = 'idle';
      }
      videoTitleEl.textContent = 'No YouTube video active';
      videoMetaEl.textContent = 'Open any YouTube video with captions to start.';
      exportSrtBtn.disabled = true;
      reprocessBtn.disabled = true;
      return;
    }

    videoTitleEl.textContent = status.videoTitle || `Video ${status.videoId}`;
    exportSrtBtn.disabled = status.cueCount === 0;
    reprocessBtn.disabled = false;

    if (!settings.enabled) {
      videoMetaEl.textContent = 'BetterSubtitle is toggled off for this tab.';
      return;
    }

    if (status.state === 'processing') {
      headerStatus.textContent = `AI ${status.processedChunks}/${status.totalChunks}`;
      headerStatus.dataset.tone = 'processing';
      videoMetaEl.textContent = `${status.trackName || 'Captions'} · Refining chunk ${status.processedChunks} of ${status.totalChunks} (${status.cueCount} cues ready)`;
    } else if (status.state === 'loading') {
      headerStatus.textContent = 'Loading';
      headerStatus.dataset.tone = 'processing';
      videoMetaEl.textContent = 'Fetching YouTube transcript...';
    } else if (status.state === 'error') {
      headerStatus.textContent = 'AI Error';
      headerStatus.dataset.tone = 'error';
      videoMetaEl.textContent = status.message || 'AI request failed. Showing offline sentence merge.';
    } else if (status.state === 'no-captions') {
      headerStatus.textContent = 'No CC';
      headerStatus.dataset.tone = 'idle';
      videoMetaEl.textContent = status.message || 'This video does not provide YouTube captions.';
    } else {
      headerStatus.textContent = 'Active';
      headerStatus.dataset.tone = 'active';
      videoMetaEl.textContent = `${status.trackName || 'Captions'} · ${status.cueCount} sentence cues ready`;
    }
  }

  // Bind events
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      switchTab((btn.dataset.tab as 'subtitles' | 'live' | 'ai' | 'style') || 'subtitles');
    });
  }

  // Live Audio controls
  for (const btn of liveEngineButtons) {
    btn.addEventListener('click', () => {
      const liveEngine = btn.dataset.liveEngine as LiveSttEngine;
      liveFeedbackEl.classList.add('hidden');
      void commitPatch({ liveEngine });
    });
  }

  liveSourceLangSelect.addEventListener('change', () => {
    void commitPatch({ liveSourceLanguage: liveSourceLangSelect.value });
  });

  liveJumpAiBtn.addEventListener('click', () => {
    void commitPatch({ provider: 'gemini' });
    switchTab('ai');
  });

  localWhisperUrlInput.addEventListener('input', () => {
    schedulePatch({ localWhisperUrl: localWhisperUrlInput.value.trim() });
  });

  testWhisperBtn.addEventListener('click', async () => {
    testWhisperBtn.disabled = true;
    testWhisperBtn.textContent = 'Testing...';
    showLiveFeedback('Checking Local Whisper server...', 'neutral');
    try {
      const url = localWhisperUrlInput.value.trim() || 'http://localhost:8765';
      await commitPatch({ localWhisperUrl: url });
      const res = await sendBackground<TestConnectionResponse>({
        type: 'TEST_LOCAL_WHISPER',
        payload: { localWhisperUrl: url },
      });
      showLiveFeedback(res.message, res.ok ? 'ok' : 'err');
    } catch (err) {
      showLiveFeedback(err instanceof Error ? err.message : 'Server check failed.', 'err');
    } finally {
      testWhisperBtn.disabled = false;
      testWhisperBtn.textContent = 'Test';
    }
  });

  liveToggleBtn.addEventListener('click', async () => {
    liveFeedbackEl.classList.add('hidden');
    if (liveStatus.active) {
      liveToggleBtn.disabled = true;
      try {
        const res = await sendBackground<{ ok: boolean; status?: LiveSessionStatus }>({
          type: 'STOP_LIVE_AUDIO',
        });
        if (res.status) liveStatus = res.status;
        renderLiveStatus();
        await refreshActiveVideoStatus();
      } finally {
        liveToggleBtn.disabled = false;
      }
      return;
    }

    liveToggleBtn.disabled = true;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id || !tab.url || /^(chrome|edge|chrome-extension|about):/i.test(tab.url)) {
        showLiveFeedback(
          'Open a video or livestream tab (YouTube, Twitch, etc.) before starting Live Audio.',
          'err',
        );
        return;
      }

      if (settings.liveEngine === 'gemini-live' && !settings.geminiApiKey.trim()) {
        showLiveFeedback(
          'Add your Gemini API key in the AI Engine tab first, or switch to Local Whisper.',
          'err',
        );
        return;
      }

      if (!chrome.tabCapture?.getMediaStreamId) {
        showLiveFeedback('Tab audio capture is not supported in this browser.', 'err');
        return;
      }

      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
          if (chrome.runtime.lastError || !id) {
            reject(
              new Error(chrome.runtime.lastError?.message || 'Could not obtain tab audio stream.'),
            );
            return;
          }
          resolve(id);
        });
      });

      const res = await sendBackground<{
        ok: boolean;
        status?: LiveSessionStatus;
        error?: string;
      }>({
        type: 'START_LIVE_AUDIO',
        payload: {
          tabId: tab.id,
          tabTitle: tab.title || 'Live Tab',
          tabUrl: tab.url,
          streamId,
        },
      });

      if (res.status) liveStatus = res.status;
      if (!res.ok) {
        showLiveFeedback(res.error || 'Failed to start Live Audio.', 'err');
      }
      renderLiveStatus();
    } catch (err) {
      showLiveFeedback(err instanceof Error ? err.message : 'Failed to capture tab audio.', 'err');
    } finally {
      liveToggleBtn.disabled = false;
    }
  });

  exportLiveSrtBtn.addEventListener('click', async () => {
    const resp = await sendBackground<ExportSrtResponse>({ type: 'EXPORT_LIVE_SRT' });
    if (resp?.ok && resp.srt && resp.filename) {
      triggerFileDownload(resp.filename, resp.srt);
    }
  });

  masterToggle.addEventListener('click', () => {
    void commitPatch({ enabled: !settings.enabled }).then(refreshActiveVideoStatus);
  });

  for (const btn of modeButtons) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as SubtitleMode;
      void commitPatch({ mode });
    });
  }

  targetLangSelect.addEventListener('change', () => {
    void commitPatch({ targetLanguage: targetLangSelect.value });
  });

  jumpAiBtn.addEventListener('click', () => {
    switchTab('ai');
  });

  exportSrtBtn.addEventListener('click', async () => {
    const resp = await sendToActiveTab<ExportSrtResponse>({ type: 'EXPORT_SRT' });
    if (resp?.ok && resp.srt && resp.filename) {
      triggerFileDownload(resp.filename, resp.srt);
    }
  });

  reprocessBtn.addEventListener('click', async () => {
    await sendToActiveTab({ type: 'REPROCESS_VIDEO' });
    setTimeout(() => void refreshActiveVideoStatus(), 300);
  });

  // Provider selection
  for (const btn of providerButtons) {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider as AiProvider;
      connResultEl.classList.add('hidden');
      void commitPatch({ provider });
    });
  }

  // Secret visibility toggles
  document.querySelectorAll<HTMLButtonElement>('[data-toggle-secret]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.toggleSecret;
      if (!targetId) return;
      const input = document.getElementById(targetId) as HTMLInputElement | null;
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Debounced text input saver (merges cleanly into commitPatch if another control is clicked first)
  const schedulePatch = (patch: Partial<SubFlowSettings>) => {
    pendingDebouncedPatch = { ...pendingDebouncedPatch, ...patch };
    settings = normalizeSettings({ ...settings, ...patch });
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      const toFlush = pendingDebouncedPatch;
      pendingDebouncedPatch = {};
      void commitPatch(toFlush);
    }, 240);
  };

  geminiApiKeyInput.addEventListener('input', () => {
    schedulePatch({ geminiApiKey: geminiApiKeyInput.value.trim() });
  });

  geminiModelPreset.addEventListener('change', () => {
    if (geminiModelPreset.value === CUSTOM_MODEL_VALUE) {
      geminiCustomModelGroup.classList.remove('hidden');
      geminiCustomModelInput.focus();
    } else {
      geminiCustomModelGroup.classList.add('hidden');
      void commitPatch({ geminiModel: geminiModelPreset.value });
    }
  });

  geminiCustomModelInput.addEventListener('input', () => {
    const val = geminiCustomModelInput.value.trim();
    if (val) schedulePatch({ geminiModel: val });
  });

  ollamaUrlInput.addEventListener('input', () => {
    schedulePatch({ ollamaUrl: ollamaUrlInput.value.trim() });
  });

  ollamaModelInput.addEventListener('input', () => {
    schedulePatch({ ollamaModel: ollamaModelInput.value.trim() });
  });

  scanOllamaBtn.addEventListener('click', async () => {
    scanOllamaBtn.disabled = true;
    scanOllamaBtn.textContent = 'Scanning...';
    try {
      const url = ollamaUrlInput.value.trim() || 'http://localhost:11434';
      await commitPatch({ ollamaUrl: url });
      const res = await sendBackground<ListOllamaModelsResponse>({
        type: 'LIST_OLLAMA_MODELS',
        payload: { ollamaUrl: url },
      });
      if (!res.ok) {
        showFeedback(res.error || 'Could not reach Ollama.', 'err');
      } else if (!res.models || res.models.length === 0) {
        showFeedback('Ollama is running, but no models are pulled yet.', 'err');
      } else {
        ollamaModelList.textContent = '';
        for (const model of res.models) {
          const opt = document.createElement('option');
          opt.value = model;
          ollamaModelList.appendChild(opt);
        }
        if (!res.models.includes(ollamaModelInput.value.trim())) {
          ollamaModelInput.value = res.models[0];
          await commitPatch({ ollamaModel: res.models[0] });
        }
        showFeedback(`Found ${res.models.length} local model(s): ${res.models.slice(0, 4).join(', ')}`, 'ok');
      }
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : 'Scan failed.', 'err');
    } finally {
      scanOllamaBtn.disabled = false;
      scanOllamaBtn.textContent = 'Scan';
    }
  });

  openaiBaseUrlInput.addEventListener('input', () => {
    schedulePatch({ openaiBaseUrl: openaiBaseUrlInput.value.trim() });
  });

  openaiApiKeyInput.addEventListener('input', () => {
    schedulePatch({ openaiApiKey: openaiApiKeyInput.value.trim() });
  });

  openaiModelInput.addEventListener('input', () => {
    schedulePatch({ openaiModel: openaiModelInput.value.trim() });
  });

  testConnBtn.addEventListener('click', async () => {
    testConnBtn.disabled = true;
    testConnBtn.textContent = 'Testing...';
    showFeedback('Checking provider connection...', 'neutral');
    try {
      // Flush latest edited inputs before testing
      settings = await saveSettings({
        geminiApiKey: geminiApiKeyInput.value.trim(),
        geminiModel:
          geminiModelPreset.value === CUSTOM_MODEL_VALUE
            ? geminiCustomModelInput.value.trim() || settings.geminiModel
            : geminiModelPreset.value,
        ollamaUrl: ollamaUrlInput.value.trim() || 'http://localhost:11434',
        ollamaModel: ollamaModelInput.value.trim(),
        openaiBaseUrl: openaiBaseUrlInput.value.trim() || 'https://api.openai.com/v1',
        openaiApiKey: openaiApiKeyInput.value.trim(),
        openaiModel: openaiModelInput.value.trim() || 'gpt-4o-mini',
      });
      const res = await sendBackground<TestConnectionResponse>({
        type: 'TEST_CONNECTION',
        payload: { settings },
      });
      showFeedback(res.message, res.ok ? 'ok' : 'err');
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : 'Connection test failed.', 'err');
    } finally {
      testConnBtn.disabled = false;
      testConnBtn.textContent = 'Test Connection';
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    await sendToActiveTab({ type: 'CLEAR_CACHE' });
    showFeedback('Subtitle cache cleared for active video.', 'ok');
    setTimeout(() => void refreshActiveVideoStatus(), 300);
  });

  // Style controls
  fontSizeInput.addEventListener('input', () => {
    const fontSize = Number(fontSizeInput.value);
    fontSizeVal.textContent = `${fontSize}px`;
    void commitPatch({ fontSize });
  });

  bgOpacityInput.addEventListener('input', () => {
    const pct = Number(bgOpacityInput.value);
    bgOpacityVal.textContent = `${pct}%`;
    void commitPatch({ bgOpacity: pct / 100 });
  });

  bottomOffsetInput.addEventListener('input', () => {
    const bottomOffsetPercent = Number(bottomOffsetInput.value);
    bottomOffsetVal.textContent = `${bottomOffsetPercent}%`;
    void commitPatch({ bottomOffsetPercent });
  });

  for (const btn of dualOrderButtons) {
    btn.addEventListener('click', () => {
      const dualOrder = btn.dataset.dualOrder as DualOrder;
      void commitPatch({ dualOrder });
    });
  }

  hideNativeToggle.addEventListener('change', () => {
    void commitPatch({ hideNativeCaptions: hideNativeToggle.checked });
  });

  pauseHoverToggle.addEventListener('change', () => {
    void commitPatch({ pauseOnHover: pauseHoverToggle.checked });
  });

  async function refreshLiveStatus(): Promise<void> {
    try {
      const next = await sendBackground<LiveSessionStatus>({ type: 'GET_LIVE_STATUS' });
      if (next && typeof next.active === 'boolean') {
        liveStatus = next;
        renderLiveStatus();
      }
    } catch {
      // ignore
    }
  }

  renderSettings();
  await Promise.all([refreshActiveVideoStatus(), refreshLiveStatus()]);
  window.setInterval(() => {
    void refreshLiveStatus();
    if (!liveStatus.active) {
      void refreshActiveVideoStatus();
    }
  }, 550);
}

void initPopup();
