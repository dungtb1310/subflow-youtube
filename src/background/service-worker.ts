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

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundRequest,
    _sender,
    sendResponse: (
      resp: ProcessChunkResponse | TestConnectionResponse | ListOllamaModelsResponse,
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

    return false;
  },
);
