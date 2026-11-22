import type { BackgroundRequest, LiveSessionState, OffscreenRequest } from '../shared/types';
import {
  buildGeminiLiveAudioMessage,
  buildGeminiLiveSetupMessage,
  buildGeminiLiveStreamEndMessage,
  buildGeminiLiveWsUrl,
  buildLocalWhisperWsUrl,
  computeRmsLevel,
  downsampleFloat32ToInt16Pcm,
  int16ToBase64,
  parseGeminiLiveServerMessage,
  TARGET_SAMPLE_RATE,
} from './pcm-utils';

interface ActiveCaptureConfig {
  streamId: string;
  engine: 'gemini-live' | 'local-whisper';
  geminiApiKey: string;
  liveSourceLanguage: string;
  localWhisperUrl: string;
}

const PCM_CHUNK_SAMPLES = 1600; // 100ms @ 16kHz
const SILENCE_RMS_THRESHOLD = 0.035;
const HYBRID_VAD_SILENCE_MS = 750;

let activeConfig: ActiveCaptureConfig | null = null;
let mediaStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let silentGainNode: GainNode | null = null;
let ws: WebSocket | null = null;
let wsReady = false;
let intentionallyStopped = false;
let reconnectTimer: number | null = null;
let reconnectAttempts = 0;

let pcmBuffer: number[] = [];
let hasSpokenSinceFlush = false;
let lastSpeechTimestamp = 0;
let lastLevelEmitAt = 0;

function sendToBackground(msg: BackgroundRequest): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    // ignore if background worker is restarting
  }
}

function emitState(state: LiveSessionState, error?: string, fatal?: boolean): void {
  sendToBackground({
    type: 'OFFSCREEN_STATE',
    payload: { state, error, fatal },
  });
}

function closeSocketOnly(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  wsReady = false;
  if (ws) {
    const old = ws;
    ws = null;
    try {
      if (
        old.readyState === WebSocket.OPEN &&
        activeConfig?.engine === 'gemini-live'
      ) {
        old.send(JSON.stringify(buildGeminiLiveStreamEndMessage()));
      }
      old.close(1000, 'Session closed');
    } catch {
      // ignore
    }
  }
}

function stopCapture(emitIdle = true): void {
  intentionallyStopped = true;
  closeSocketOnly();

  try {
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    sourceNode?.disconnect();
    silentGainNode?.disconnect();
  } catch {
    // ignore
  }
  workletNode = null;
  sourceNode = null;
  silentGainNode = null;

  if (audioCtx) {
    void audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    mediaStream = null;
  }

  pcmBuffer = [];
  hasSpokenSinceFlush = false;
  activeConfig = null;
  if (emitIdle) {
    emitState('idle');
  }
}

function flushPcmChunks(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !wsReady || !activeConfig) return;

  while (pcmBuffer.length >= PCM_CHUNK_SAMPLES) {
    const slice = pcmBuffer.splice(0, PCM_CHUNK_SAMPLES);
    const int16 = Int16Array.from(slice);

    if (activeConfig.engine === 'gemini-live') {
      const b64 = int16ToBase64(int16);
      ws.send(JSON.stringify(buildGeminiLiveAudioMessage(b64)));
    } else {
      ws.send(int16.buffer);
    }
  }
}

function scheduleReconnect(reason?: string): void {
  if (intentionallyStopped || !activeConfig) return;
  reconnectAttempts++;
  if (reconnectAttempts > 6) {
    stopCapture(false);
    emitState('error', reason || 'Live audio stream disconnected repeatedly.', true);
    return;
  }
  const delayMs = Math.min(5000, 600 * reconnectAttempts);
  emitState('reconnecting');
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!intentionallyStopped && activeConfig) {
      connectWebSocket(activeConfig);
    }
  }, delayMs);
}

function connectWebSocket(config: ActiveCaptureConfig): void {
  closeSocketOnly();
  emitState(reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

  if (config.engine === 'gemini-live') {
    if (!config.geminiApiKey.trim()) {
      stopCapture(false);
      emitState('error', 'Gemini API key is missing. Add it in the AI Engine tab.', true);
      return;
    }

    const socket = new WebSocket(buildGeminiLiveWsUrl(config.geminiApiKey));
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      const setup = buildGeminiLiveSetupMessage({
        sourceLanguage: config.liveSourceLanguage,
      });
      socket.send(JSON.stringify(setup));
    };

    socket.onmessage = async (event: MessageEvent) => {
      if (ws !== socket) return;
      let rawText = '';
      if (typeof event.data === 'string') {
        rawText = event.data;
      } else if (event.data instanceof Blob) {
        rawText = await event.data.text();
      }
      if (!rawText) return;

      const parsed = parseGeminiLiveServerMessage(rawText);
      if (parsed.setupComplete) {
        wsReady = true;
        reconnectAttempts = 0;
        emitState('listening');
        flushPcmChunks();
      }
      if (parsed.interimText) {
        sendToBackground({
          type: 'OFFSCREEN_TRANSCRIPT',
          payload: { text: parsed.interimText, isFinal: false },
        });
      }
      if (parsed.finalText) {
        sendToBackground({
          type: 'OFFSCREEN_TRANSCRIPT',
          payload: { text: parsed.finalText, isFinal: true },
        });
      }
      if (parsed.goAway) {
        // Transparently renew session before Google's ~10 min live WebSocket limit closes it
        scheduleReconnect();
      }
    };

    socket.onerror = () => {
      if (ws !== socket || intentionallyStopped) return;
      emitState('error', 'Gemini Live WebSocket error. Check API key and network.');
    };

    socket.onclose = (ev: CloseEvent) => {
      if (ws !== socket || intentionallyStopped) return;
      wsReady = false;
      if (ev.code === 1007 || ev.code === 1008 || ev.code === 4003) {
        const detail = ev.reason ? ` (${ev.reason})` : '';
        stopCapture(false);
        emitState(
          'error',
          `Gemini Live rejected session (code ${ev.code})${detail}. Check your API key or model access.`,
          true,
        );
        return;
      }
      scheduleReconnect(ev.reason || `Gemini Live closed (code ${ev.code}).`);
    };
    return;
  }

  // Local Whisper WebSocket Server
  const wsUrl = buildLocalWhisperWsUrl(config.localWhisperUrl, config.liveSourceLanguage);
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    wsReady = true;
    reconnectAttempts = 0;
    emitState('listening');
    flushPcmChunks();
  };

  socket.onmessage = (event: MessageEvent) => {
    if (ws !== socket || typeof event.data !== 'string') return;
    try {
      const msg = JSON.parse(event.data) as {
        type?: string;
        text?: string;
        language?: string;
        error?: string;
      };
      if (msg.type === 'error' && msg.error) {
        emitState('error', msg.error);
        return;
      }
      if ((msg.type === 'interim' || msg.type === 'final') && msg.text?.trim()) {
        sendToBackground({
          type: 'OFFSCREEN_TRANSCRIPT',
          payload: {
            text: msg.text.trim(),
            isFinal: msg.type === 'final',
            language: msg.language,
          },
        });
      }
    } catch {
      // ignore malformed JSON
    }
  };

  socket.onerror = () => {
    if (ws !== socket || intentionallyStopped) return;
    emitState(
      'error',
      `Cannot connect to Local Whisper at ${config.localWhisperUrl}. Start server/live_whisper_server.py first.`,
    );
  };

  socket.onclose = (ev: CloseEvent) => {
    if (ws !== socket || intentionallyStopped) return;
    wsReady = false;
    scheduleReconnect(
      ev.reason || `Local Whisper server disconnected at ${config.localWhisperUrl}.`,
    );
  };
}

async function startCapture(config: ActiveCaptureConfig): Promise<{ ok: boolean; error?: string }> {
  // Release any previous local stream silently (do NOT emit 'idle' while starting a new session!)
  stopCapture(false);
  intentionallyStopped = false;
  reconnectAttempts = 0;
  activeConfig = config;

  try {
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: config.streamId,
        },
      },
      video: false,
    } as unknown as MediaStreamConstraints;

    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    for (const track of mediaStream.getTracks()) {
      track.onended = () => {
        if (!intentionallyStopped) {
          stopCapture(true);
        }
      };
    }

    audioCtx = new AudioContext();
    await audioCtx.resume().catch(() => {});

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);

    // CRITICAL: Route captured tab audio straight back to speakers so the tab is NOT muted!
    sourceNode.connect(audioCtx.destination);

    // Tap parallel branch using modern AudioWorkletNode (off-main-thread, zero deprecation warnings)
    const workletUrl = chrome.runtime.getURL('pcm-worklet.js');
    await audioCtx.audioWorklet.addModule(workletUrl);

    workletNode = new AudioWorkletNode(audioCtx, 'bettersubtitle-pcm-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    silentGainNode = audioCtx.createGain();
    silentGainNode.gain.value = 0;

    sourceNode.connect(workletNode);
    workletNode.connect(silentGainNode);
    silentGainNode.connect(audioCtx.destination);

    const inputRate = audioCtx.sampleRate;

    workletNode.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (intentionallyStopped || !activeConfig) return;
      const channelData = ev.data;
      if (!(channelData instanceof Float32Array) || channelData.length === 0) return;

      const level = computeRmsLevel(channelData);
      const now = Date.now();

      if (now - lastLevelEmitAt >= 200) {
        lastLevelEmitAt = now;
        sendToBackground({
          type: 'OFFSCREEN_AUDIO_LEVEL',
          payload: { level },
        });
      }

      if (level >= SILENCE_RMS_THRESHOLD) {
        hasSpokenSinceFlush = true;
        lastSpeechTimestamp = now;
      } else if (
        activeConfig.engine === 'gemini-live' &&
        hasSpokenSinceFlush &&
        now - lastSpeechTimestamp >= HYBRID_VAD_SILENCE_MS &&
        ws &&
        ws.readyState === WebSocket.OPEN &&
        wsReady
      ) {
        // Hybrid VAD signal so Gemini Live finalizes the current sentence immediately on pause
        hasSpokenSinceFlush = false;
        try {
          ws.send(JSON.stringify(buildGeminiLiveStreamEndMessage()));
        } catch {
          // ignore
        }
      }

      const pcm16 = downsampleFloat32ToInt16Pcm(channelData, inputRate, TARGET_SAMPLE_RATE);
      for (let i = 0; i < pcm16.length; i++) {
        pcmBuffer.push(pcm16[i]);
      }
      // Prevent unbounded memory growth while socket is connecting/reconnecting (max 2.5s buffer)
      if (pcmBuffer.length > TARGET_SAMPLE_RATE * 2.5) {
        pcmBuffer.splice(0, pcmBuffer.length - TARGET_SAMPLE_RATE * 2);
      }

      flushPcmChunks();
    };

    connectWebSocket(config);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stopCapture(false);
    emitState('error', `Audio capture failed: ${message}`, true);
    return { ok: false, error: message };
  }
}

chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest, _sender, sendResponse: (res: { ok: boolean; error?: string }) => void) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return false;

    if (message.type === 'OFFSCREEN_START') {
      startCapture(message.payload)
        .then((res) => sendResponse(res))
        .catch((err) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }

    if (message.type === 'OFFSCREEN_STOP') {
      stopCapture();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  },
);
