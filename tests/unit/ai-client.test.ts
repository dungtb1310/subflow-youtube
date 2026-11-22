import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractRawCuesFromModelText,
  processTranscriptChunk,
  testProviderConnection,
} from '../../src/background/ai-client';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { WordToken } from '../../src/shared/types';

const SAMPLE_WORDS: WordToken[] = [
  { index: 0, text: 'hello', startMs: 1000, endMs: 1300 },
  { index: 1, text: 'world', startMs: 1320, endMs: 1650 },
  { index: 2, text: 'this', startMs: 1700, endMs: 1920 },
  { index: 3, text: 'works', startMs: 1960, endMs: 2300 },
];

describe('ai-client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts JSON cues cleanly even when wrapped in markdown code fences', () => {
    const fenced = '```json\n{"cues":[{"startWord":0,"endWord":3,"original":"Hello world, this works."}]}\n```';
    const cues = extractRawCuesFromModelText(fenced);
    expect(cues).toHaveLength(1);
    expect(cues[0].original).toBe('Hello world, this works.');
  });

  it('calls Gemini Interactions API v1 with current model & structured schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'v1_test',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cues: [
                    {
                      startWord: 0,
                      endWord: 3,
                      original: 'Hello world, this works.',
                      translated: 'Xin chào thế giới, cái này chạy ngon rồi.',
                    },
                  ],
                }),
              },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cues = await processTranscriptChunk({
      words: SAMPLE_WORDS,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      mode: 'dual',
      settings: {
        ...DEFAULT_SETTINGS,
        provider: 'gemini',
        geminiApiKey: 'test-gemini-key',
        geminiModel: 'gemini-3.5-flash-lite',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1/interactions');
    expect(init.headers['x-goog-api-key']).toBe('test-gemini-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gemini-3.5-flash-lite');
    expect(body.store).toBe(false);
    expect(body.response_format.mime_type).toBe('application/json');

    expect(cues).toHaveLength(1);
    expect(cues[0].original).toBe('Hello world, this works.');
    expect(cues[0].translated).toBe('Xin chào thế giới, cái này chạy ngon rồi.');
    expect(cues[0].startMs).toBe(1000);
  });

  it('calls local Ollama /api/chat and surfaces actionable HTTP 403 CORS guidance', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      processTranscriptChunk({
        words: SAMPLE_WORDS,
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        mode: 'original',
        settings: {
          ...DEFAULT_SETTINGS,
          provider: 'ollama',
          ollamaUrl: 'http://localhost:11434',
          ollamaModel: 'qwen2.5:7b',
        },
      }),
    ).rejects.toThrow(/OLLAMA_ORIGINS/);
  });

  it('automatically falls back to another Gemini model when primary returns 503 high demand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () =>
          JSON.stringify({
            error: {
              message: 'gemini-3.5-flash-lite is currently experiencing high demand',
              code: 'service_unavailable',
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'v1_fb',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    cues: [
                      {
                        startWord: 0,
                        endWord: 3,
                        original: 'Hello world, this works.',
                        translated: 'Xin chào thế giới, chạy ngon.',
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const cues = await processTranscriptChunk({
      words: SAMPLE_WORDS,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      mode: 'dual',
      settings: {
        ...DEFAULT_SETTINGS,
        provider: 'gemini',
        geminiApiKey: 'test-gemini-key',
        geminiModel: 'gemini-3.5-flash-lite',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.model).toBe('gemini-3.1-flash-lite');
    expect(cues[0].translated).toBe('Xin chào thế giới, chạy ngon.');
  });

  it('passes offline connection test immediately without network calls', async () => {
    const res = await testProviderConnection({
      ...DEFAULT_SETTINGS,
      provider: 'offline',
    });
    expect(res.ok).toBe(true);
  });
});
