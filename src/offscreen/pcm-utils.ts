/**
 * Pure audio & wire-protocol utilities for Realtime Live Audio Capture.
 * Converts Web Audio Float32 frames into 16kHz mono little-endian Int16 PCM
 * and constructs/parses Gemini Live Transcribe & Local Whisper WebSocket messages.
 */

export const TARGET_SAMPLE_RATE = 16000;
export const GEMINI_LIVE_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';

export function downsampleFloat32ToInt16Pcm(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate = TARGET_SAMPLE_RATE,
): Int16Array {
  if (input.length === 0) return new Int16Array(0);

  if (inputSampleRate <= targetSampleRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    }
    return out;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.floor(input.length / ratio);
  const out = new Int16Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += input[i];
      count++;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[offsetResult] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return out;
}

export function computeRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / samples.length);
  // Normalize gently for UI meter (0..1)
  return Math.min(1, Math.max(0, rms * 4.5));
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function buildGeminiLiveWsUrl(apiKey: string): string {
  const encodedKey = encodeURIComponent(apiKey.trim());
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodedKey}`;
}

export function buildGeminiLiveSetupMessage(params: {
  model?: string;
  sourceLanguage?: string;
}): Record<string, unknown> {
  const model = params.model || GEMINI_LIVE_TRANSCRIBE_MODEL;
  const lang = (params.sourceLanguage || 'auto').trim();
  const languageCodes = lang && lang !== 'auto' ? [lang] : [];

  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['TEXT'],
      },
      inputAudioTranscription: {
        mode: 'smart',
        languageCodes,
      },
    },
  };
}

export function buildGeminiLiveAudioMessage(base64Pcm: string): Record<string, unknown> {
  return {
    realtimeInput: {
      audio: {
        data: base64Pcm,
        mimeType: `audio/pcm;rate=${TARGET_SAMPLE_RATE}`,
      },
    },
  };
}

export function buildGeminiLiveStreamEndMessage(): Record<string, unknown> {
  return {
    realtimeInput: {
      audioStreamEnd: true,
    },
  };
}

export interface ParsedGeminiLiveEvent {
  setupComplete?: boolean;
  interimText?: string;
  finalText?: string;
  goAway?: boolean;
}

export function parseGeminiLiveServerMessage(rawJson: string): ParsedGeminiLiveEvent {
  if (!rawJson || !rawJson.trim()) return {};
  try {
    const msg = JSON.parse(rawJson) as {
      setupComplete?: unknown;
      goAway?: unknown;
      serverContent?: {
        interimInputTranscription?: { text?: string };
        inputTranscription?: { text?: string };
      };
    };

    const result: ParsedGeminiLiveEvent = {};
    if (msg.setupComplete !== undefined) {
      result.setupComplete = true;
    }
    if (msg.goAway !== undefined) {
      result.goAway = true;
    }
    const sc = msg.serverContent;
    if (sc?.interimInputTranscription?.text) {
      result.interimText = sc.interimInputTranscription.text.trim();
    }
    if (sc?.inputTranscription?.text) {
      result.finalText = sc.inputTranscription.text.trim();
    }
    return result;
  } catch {
    return {};
  }
}

export function buildLocalWhisperWsUrl(baseUrl: string, sourceLanguage: string): string {
  const cleaned = (baseUrl || 'http://localhost:8765').trim().replace(/\/+$/, '');
  const wsBase = cleaned
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://');
  const lang = encodeURIComponent((sourceLanguage || 'auto').trim() || 'auto');
  return `${wsBase}/ws/transcribe?lang=${lang}`;
}
