import { describe, expect, it } from 'vitest';
import {
  buildGeminiLiveAudioMessage,
  buildGeminiLiveSetupMessage,
  buildGeminiLiveWsUrl,
  buildLocalWhisperWsUrl,
  computeRmsLevel,
  downsampleFloat32ToInt16Pcm,
  int16ToBase64,
  parseGeminiLiveServerMessage,
} from '../../src/offscreen/pcm-utils';

describe('pcm-utils & Gemini Live wire protocol', () => {
  it('downsamples 48kHz Float32 audio to 16kHz Int16 PCM accurately with clamping', () => {
    const input = new Float32Array(480); // 10ms @ 48kHz
    input.fill(0.5);
    input[0] = 1.8; // should clamp to +1.0
    input[1] = 1.8;
    input[2] = 1.8;

    const pcm = downsampleFloat32ToInt16Pcm(input, 48000, 16000);
    expect(pcm.length).toBe(160); // 10ms @ 16kHz
    expect(pcm[0]).toBe(32767);
    expect(pcm[10]).toBeCloseTo(16384, -1);
  });

  it('computes normalized RMS audio levels and encodes Int16 PCM to base64', () => {
    const silent = new Float32Array(128);
    expect(computeRmsLevel(silent)).toBe(0);

    const loud = new Float32Array(128).fill(0.5);
    expect(computeRmsLevel(loud)).toBe(1);

    const pcm = new Int16Array([0, 1000, -1000]);
    const b64 = int16ToBase64(pcm);
    expect(typeof b64).toBe('string');
    expect(atob(b64).length).toBe(6);
  });

  it('constructs and parses Gemini Live Transcribe WebSocket messages', () => {
    expect(buildGeminiLiveWsUrl('my-key')).toContain(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=my-key',
    );

    const setupAuto = buildGeminiLiveSetupMessage({ sourceLanguage: 'auto' }) as {
      setup: {
        model: string;
        generationConfig: { responseModalities: string[] };
        inputAudioTranscription: { mode: string; languageCodes: string[] };
      };
    };
    expect(setupAuto.setup.model).toBe('models/gemini-3.5-transcribe-live');
    expect(setupAuto.setup.generationConfig.responseModalities).toEqual(['TEXT']);
    expect(setupAuto.setup.inputAudioTranscription.mode).toBe('smart');
    expect(setupAuto.setup.inputAudioTranscription.languageCodes).toEqual([]);

    const setupEn = buildGeminiLiveSetupMessage({ sourceLanguage: 'en' }) as {
      setup: { inputAudioTranscription: { languageCodes: string[] } };
    };
    expect(setupEn.setup.inputAudioTranscription.languageCodes).toEqual(['en']);

    const audioMsg = buildGeminiLiveAudioMessage('AAAA') as {
      realtimeInput: { audio: { data: string; mimeType: string } };
    };
    expect(audioMsg.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');

    expect(parseGeminiLiveServerMessage('{"setupComplete":{}}')).toEqual({ setupComplete: true });
    expect(
      parseGeminiLiveServerMessage(
        JSON.stringify({
          serverContent: {
            interimInputTranscription: { text: 'hello everyone' },
            inputTranscription: { text: 'Hello everyone, welcome to the stream!' },
          },
          goAway: { timeLeft: '30s' },
        }),
      ),
    ).toEqual({
      interimText: 'hello everyone',
      finalText: 'Hello everyone, welcome to the stream!',
      goAway: true,
    });
  });

  it('builds Local Whisper WebSocket URL from http/https base URLs', () => {
    expect(buildLocalWhisperWsUrl('http://localhost:8765/', 'en')).toBe(
      'ws://localhost:8765/ws/transcribe?lang=en',
    );
    expect(buildLocalWhisperWsUrl('https://whisper.local', 'auto')).toBe(
      'wss://whisper.local/ws/transcribe?lang=auto',
    );
  });
});
