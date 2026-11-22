import {
  GEMINI_MODEL_PRESETS,
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
    ai: qs<HTMLElement>('#panel-ai'),
    style: qs<HTMLElement>('#panel-style'),
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

  function switchTab(tabId: 'subtitles' | 'ai' | 'style'): void {
    for (const btn of tabButtons) {
      const selected = btn.dataset.tab === tabId;
      btn.setAttribute('aria-selected', String(selected));
    }
    for (const [id, panel] of Object.entries(panels)) {
      panel.classList.toggle('hidden', id !== tabId);
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
      videoMetaEl.textContent = 'SubFlow is toggled off for this tab.';
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
      switchTab((btn.dataset.tab as 'subtitles' | 'ai' | 'style') || 'subtitles');
    });
  }

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

  renderSettings();
  await refreshActiveVideoStatus();
  window.setInterval(() => {
    void refreshActiveVideoStatus();
  }, 1400);
}

void initPopup();
