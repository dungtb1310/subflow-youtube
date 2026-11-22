import {
  listOllamaModels,
  processTranscriptChunk,
  testProviderConnection,
} from './ai-client';
import type {
  BackgroundRequest,
  ListOllamaModelsResponse,
  ProcessChunkResponse,
  TestConnectionResponse,
} from '../shared/types';

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

chrome.runtime.onInstalled.addListener(() => {
  void injectIntoOpenYouTubeTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void injectIntoOpenYouTubeTabs();
});

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundRequest,
    _sender,
    sendResponse: (
      resp: ProcessChunkResponse | TestConnectionResponse | ListOllamaModelsResponse | { ok: boolean },
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

    return false;
  },
);
