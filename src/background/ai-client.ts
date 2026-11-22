import { getLanguageLabel } from '../shared/constants';
import { alignAiCuesToWords, mergeWordsToHeuristicCues } from '../shared/chunker';
import type {
  AiRawCue,
  ListOllamaModelsResponse,
  SubFlowSettings,
  SubtitleCue,
  SubtitleMode,
  TestConnectionResponse,
  WordToken,
} from '../shared/types';

export interface ProcessChunkParams {
  words: WordToken[];
  sourceLanguage: string;
  targetLanguage: string;
  mode: SubtitleMode;
  settings: SubFlowSettings;
  previousContext?: string;
  chunkIndex?: number;
}

const FETCH_TIMEOUT_MS = 45_000;

function buildCueResponseSchema(includeTranslation: boolean): Record<string, unknown> {
  const itemProperties: Record<string, unknown> = {
    startWord: {
      type: 'integer',
      description: 'Inclusive 0-based start word index from the numbered transcript.',
    },
    endWord: {
      type: 'integer',
      description: 'Inclusive 0-based end word index from the numbered transcript.',
    },
    original: {
      type: 'string',
      description:
        'Clean, punctuated, capitalized sentence or readable subtitle line reconstructed from startWord..endWord in the original language.',
    },
  };

  const required = ['startWord', 'endWord', 'original'];

  if (includeTranslation) {
    itemProperties.translated = {
      type: 'string',
      description: 'Natural, idiomatic, concise subtitle translation into the target language.',
    };
    required.push('translated');
  }

  return {
    type: 'object',
    properties: {
      cues: {
        type: 'array',
        items: {
          type: 'object',
          properties: itemProperties,
          required,
        },
      },
    },
    required: ['cues'],
  };
}

export function buildSubtitlePrompts(params: {
  words: WordToken[];
  sourceLanguage: string;
  targetLanguage: string;
  mode: SubtitleMode;
  previousContext?: string;
}): { systemInstruction: string; userPrompt: string; includeTranslation: boolean } {
  const includeTranslation = params.mode !== 'original';
  const sourceLabel = getLanguageLabel(params.sourceLanguage || 'en');
  const targetLabel = getLanguageLabel(params.targetLanguage || 'vi');

  const numberedTranscript = params.words
    .map((w, localIdx) => `[${localIdx}] ${w.text}`)
    .join(' ');

  const systemInstruction = includeTranslation
    ? [
        'You are an expert subtitle editor and translator for YouTube videos.',
        'You receive noisy word-by-word ASR tokens indexed [0]..[N].',
        `Your task: (1) Regroup the tokens into complete, natural, readable ${sourceLabel} sentences/subtitle cues (typically 6-16 words each, never choppy word-by-word fragments), adding accurate punctuation, capitalization, and fixing obvious ASR homophone typos without dropping meaning.`,
        `(2) Translate each cue smoothly and idiomatically into natural spoken ${targetLabel}, preserving tone and context across sentences.`,
        'Rules:',
        '- Every token index from 0 to the last index must be covered sequentially in non-overlapping cues.',
        '- startWord and endWord are inclusive integer indices matching the [i] markers.',
        '- Output strictly valid JSON matching {"cues":[{"startWord":0,"endWord":9,"original":"...","translated":"..."}]}.',
      ].join('\n')
    : [
        'You are an expert subtitle editor for YouTube videos.',
        'You receive noisy word-by-word ASR tokens indexed [0]..[N].',
        `Your task: Regroup the tokens into complete, natural, readable ${sourceLabel} sentences/subtitle cues (typically 6-16 words each, never choppy word-by-word fragments).`,
        'Add accurate punctuation, capitalization, and fix obvious ASR homophone mistakes using surrounding context, while staying faithful to what was spoken.',
        'Rules:',
        '- Every token index from 0 to the last index must be covered sequentially in non-overlapping cues.',
        '- startWord and endWord are inclusive integer indices matching the [i] markers.',
        '- Output strictly valid JSON matching {"cues":[{"startWord":0,"endWord":9,"original":"..."}]}.',
      ].join('\n');

  const contextBlock = params.previousContext
    ? `Previous context (for continuity only, do NOT include in output):\n"${params.previousContext}"\n\n`
    : '';

  const userPrompt = `${contextBlock}Numbered transcript (${params.words.length} tokens, indices 0..${params.words.length - 1}):\n${numberedTranscript}`;

  return { systemInstruction, userPrompt, includeTranslation };
}

export function extractRawCuesFromModelText(rawText: string): AiRawCue[] {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('Model returned an empty response.');
  }

  // Strip optional markdown code fences
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    const startObj = unfenced.indexOf('{');
    const endObj = unfenced.lastIndexOf('}');
    if (startObj >= 0 && endObj > startObj) {
      parsed = JSON.parse(unfenced.slice(startObj, endObj + 1));
    } else {
      const startArr = unfenced.indexOf('[');
      const endArr = unfenced.lastIndexOf(']');
      if (startArr >= 0 && endArr > startArr) {
        parsed = JSON.parse(unfenced.slice(startArr, endArr + 1));
      } else {
        throw new Error('Could not parse JSON from AI response.');
      }
    }
  }

  if (Array.isArray(parsed)) {
    return parsed as AiRawCue[];
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cues?: unknown }).cues)) {
    return (parsed as { cues: AiRawCue[] }).cues;
  }

  throw new Error('AI response JSON did not contain a "cues" array.');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface GeminiInteractionResponse {
  output_text?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: { message?: string };
}

function extractGeminiInteractionText(data: GeminiInteractionResponse): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }
  if (Array.isArray(data.steps)) {
    const modelSteps = data.steps.filter((s) => s?.type === 'model_output');
    const lastStep = modelSteps[modelSteps.length - 1];
    if (lastStep && Array.isArray(lastStep.content)) {
      const text = lastStep.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('');
      if (text.trim()) return text;
    }
  }
  return '';
}

const GEMINI_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
  'gemini-3.5-flash-lite',
];

const GEMINI_BUSY_COOLDOWN_MS = 120_000;
const geminiBusyUntil = new Map<string, number>();

function parseApiErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string } | Array<{ error?: { message?: string } }>;
    };
    if (Array.isArray(parsed) && parsed[0]?.error?.message) {
      return String(parsed[0].error.message);
    }
    if (parsed?.error && !Array.isArray(parsed.error) && parsed.error.message) {
      return String(parsed.error.message);
    }
  } catch {
    // not JSON
  }
  return trimmed.slice(0, 180);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callSingleGeminiModel(params: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  userPrompt: string;
  schema: Record<string, unknown>;
}): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
  const res = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': params.apiKey,
    },
    body: JSON.stringify({
      model: params.model,
      system_instruction: params.systemInstruction,
      input: params.userPrompt,
      store: false,
      generation_config: {
        thinking_level: 'minimal',
        max_output_tokens: 4096,
      },
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: params.schema,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      message: parseApiErrorMessage(errBody) || `HTTP ${res.status}`,
    };
  }

  const data = (await res.json()) as GeminiInteractionResponse;
  const text = extractGeminiInteractionText(data);
  if (!text) {
    return { ok: false, status: 502, message: 'Gemini API returned an empty output.' };
  }
  return { ok: true, text };
}

async function callGeminiInteractions(params: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  allowFallback?: boolean;
}): Promise<{ text: string; usedModel: string }> {
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    throw new Error('Gemini API key is missing. Add your key in BetterSubtitle Settings.');
  }

  const primaryModel = params.model.trim() || 'gemini-3.5-flash-lite';
  const now = Date.now();
  const candidates = [primaryModel];

  if (params.allowFallback !== false) {
    for (const fb of GEMINI_FALLBACK_MODELS) {
      if (!candidates.includes(fb)) candidates.push(fb);
    }
  }

  // Move models that recently returned 503 to the end of the candidate queue during cooldown
  const ordered = [
    ...candidates.filter((m) => (geminiBusyUntil.get(m) ?? 0) <= now),
    ...candidates.filter((m) => (geminiBusyUntil.get(m) ?? 0) > now),
  ];

  let lastStatus = 0;
  let lastMessage = 'Gemini request failed.';

  for (let i = 0; i < ordered.length; i++) {
    const candidate = ordered[i];
    const attempt = await callSingleGeminiModel({
      apiKey,
      model: candidate,
      systemInstruction: params.systemInstruction,
      userPrompt: params.userPrompt,
      schema: params.schema,
    });

    if (attempt.ok) {
      geminiBusyUntil.delete(candidate);
      return { text: attempt.text, usedModel: candidate };
    }

    lastStatus = attempt.status;
    lastMessage = attempt.message;

    if (attempt.status === 401 || attempt.status === 403) {
      throw new Error('Gemini API key was rejected. Check your key in Google AI Studio.');
    }

    // Retry / fallback on transient overload (503/500/502/504) or per-model quota spike (429)
    const isTransient =
      attempt.status === 503 ||
      attempt.status === 500 ||
      attempt.status === 502 ||
      attempt.status === 504 ||
      attempt.status === 429;

    if (!isTransient) {
      throw new Error(`Gemini (${candidate}) error ${attempt.status}: ${attempt.message}`);
    }

    if (attempt.status === 503) {
      geminiBusyUntil.set(candidate, Date.now() + GEMINI_BUSY_COOLDOWN_MS);
    }

    // Brief backoff before trying the next candidate model
    if (i < ordered.length - 1) {
      await sleep(attempt.status === 429 ? 700 : 350);
    }
  }

  if (lastStatus === 429) {
    throw new Error(
      'Gemini free-tier rate limit reached. Wait a moment or switch to Ollama (Local).',
    );
  }
  if (lastStatus === 503) {
    throw new Error(
      'Gemini servers are temporarily overloaded (503). Click Re-run in a moment or switch to Ollama.',
    );
  }
  throw new Error(`Gemini API error (${lastStatus}): ${lastMessage}`);
}

async function callOllamaChat(params: {
  ollamaUrl: string;
  model: string;
  systemInstruction: string;
  userPrompt: string;
  schema: Record<string, unknown>;
}): Promise<string> {
  const baseUrl = (params.ollamaUrl || 'http://localhost:11434').trim().replace(/\/+$/, '');
  const model = params.model.trim();
  if (!model) {
    throw new Error('Ollama model name is missing. Click "Scan Models" in Settings.');
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: params.schema,
          options: {
            temperature: 0.2,
          },
          messages: [
            { role: 'system', content: params.systemInstruction },
            { role: 'user', content: params.userPrompt },
          ],
        }),
      },
      90_000,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach Ollama at ${baseUrl}. Ensure Ollama is running (${detail}).`);
  }

  if (res.status === 403) {
    throw new Error(
      'Ollama blocked browser extension origin (HTTP 403). Start Ollama with OLLAMA_ORIGINS="chrome-extension://*" or OLLAMA_ORIGINS="*".',
    );
  }
  if (res.status === 404) {
    throw new Error(`Ollama model "${model}" was not found. Run "ollama pull ${model}" first.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama error (${res.status}): ${body.slice(0, 220)}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? '';
  if (!content.trim()) {
    throw new Error('Ollama returned an empty response.');
  }
  return content;
}

async function callOpenAiCompatible(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemInstruction: string;
  userPrompt: string;
}): Promise<string> {
  const baseUrl = (params.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const model = params.model.trim() || 'gpt-4o-mini';
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(baseUrl);

  if (!params.apiKey.trim() && !isLocal) {
    throw new Error('API key is required for this OpenAI-compatible endpoint.');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (params.apiKey.trim()) {
    headers.Authorization = `Bearer ${params.apiKey.trim()}`;
  }

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: params.systemInstruction },
        { role: 'user', content: params.userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error('API key was rejected by the OpenAI-compatible provider.');
    }
    if (res.status === 429) {
      throw new Error('Provider rate limit reached. Try again shortly or switch providers.');
    }
    throw new Error(`Provider error (${res.status}): ${errBody.slice(0, 220)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) {
    throw new Error('OpenAI-compatible provider returned an empty response.');
  }
  return content;
}

export async function processTranscriptChunk(params: ProcessChunkParams): Promise<SubtitleCue[]> {
  if (params.words.length === 0) return [];

  if (params.settings.provider === 'offline') {
    return mergeWordsToHeuristicCues(params.words, {
      languageCode: params.sourceLanguage,
    });
  }

  const { systemInstruction, userPrompt, includeTranslation } = buildSubtitlePrompts({
    words: params.words,
    sourceLanguage: params.sourceLanguage,
    targetLanguage: params.targetLanguage,
    mode: params.mode,
    previousContext: params.previousContext,
  });

  const schema = buildCueResponseSchema(includeTranslation);
  let rawText: string;

  switch (params.settings.provider) {
    case 'gemini': {
      const geminiRes = await callGeminiInteractions({
        apiKey: params.settings.geminiApiKey,
        model: params.settings.geminiModel,
        systemInstruction,
        userPrompt,
        schema,
      });
      rawText = geminiRes.text;
      break;
    }
    case 'ollama':
      rawText = await callOllamaChat({
        ollamaUrl: params.settings.ollamaUrl,
        model: params.settings.ollamaModel,
        systemInstruction,
        userPrompt,
        schema,
      });
      break;
    case 'openai':
      rawText = await callOpenAiCompatible({
        baseUrl: params.settings.openaiBaseUrl,
        apiKey: params.settings.openaiApiKey,
        model: params.settings.openaiModel,
        systemInstruction,
        userPrompt,
      });
      break;
    default:
      return mergeWordsToHeuristicCues(params.words, {
        languageCode: params.sourceLanguage,
      });
  }

  const rawCues = extractRawCuesFromModelText(rawText);
  return alignAiCuesToWords(
    rawCues,
    params.words,
    params.chunkIndex ?? 0,
    params.sourceLanguage,
  );
}

export async function listOllamaModels(ollamaUrl: string): Promise<ListOllamaModelsResponse> {
  const baseUrl = (ollamaUrl || 'http://localhost:11434').trim().replace(/\/+$/, '');
  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/tags`, { method: 'GET' }, 8000);
    if (res.status === 403) {
      return {
        ok: false,
        error: 'Ollama returned 403. Set OLLAMA_ORIGINS="chrome-extension://*" and restart Ollama.',
      };
    }
    if (!res.ok) {
      return { ok: false, error: `Ollama returned HTTP ${res.status}.` };
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((m) => m.name ?? '')
      .filter((name) => name.length > 0);
    return { ok: true, models };
  } catch {
    return {
      ok: false,
      error: `Could not connect to Ollama at ${baseUrl}. Make sure Ollama is running.`,
    };
  }
}

export async function testProviderConnection(
  settings: SubFlowSettings,
): Promise<TestConnectionResponse> {
  const started = Date.now();

  if (settings.provider === 'offline') {
    return {
      ok: true,
      message: 'Offline sentence merger is ready (no network or API key required).',
      latencyMs: 0,
    };
  }

  try {
    if (settings.provider === 'ollama') {
      const listed = await listOllamaModels(settings.ollamaUrl);
      const latencyMs = Date.now() - started;
      if (!listed.ok) {
        return { ok: false, message: listed.error ?? 'Failed to reach Ollama.', latencyMs };
      }
      const models = listed.models ?? [];
      if (models.length === 0) {
        return {
          ok: false,
          message: 'Connected to Ollama, but no models are installed yet (run "ollama pull qwen2.5:7b").',
          latencyMs,
        };
      }
      const hasSelected = models.some(
        (m) => m === settings.ollamaModel || m.startsWith(`${settings.ollamaModel}:`),
      );
      if (!hasSelected && settings.ollamaModel) {
        return {
          ok: true,
          message: `Connected (${models.length} models). Note: "${settings.ollamaModel}" not found; available: ${models.slice(0, 3).join(', ')}.`,
          latencyMs,
        };
      }
      return {
        ok: true,
        message: `Connected to Ollama (${models.length} local model${models.length === 1 ? '' : 's'} ready).`,
        latencyMs,
      };
    }

    if (settings.provider === 'gemini') {
      if (!settings.geminiApiKey.trim()) {
        return { ok: false, message: 'Enter your Gemini API key first.' };
      }
      const preferred = settings.geminiModel || 'gemini-3.5-flash-lite';
      const result = await callGeminiInteractions({
        apiKey: settings.geminiApiKey,
        model: preferred,
        systemInstruction: 'Return {"ok":true} as JSON.',
        userPrompt: 'ping',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      });
      const latencyMs = Date.now() - started;
      const fallbackNote =
        result.usedModel !== preferred
          ? ` (auto-switched from busy ${preferred} → ${result.usedModel})`
          : '';
      return {
        ok: true,
        message: `Connected to Gemini (${result.usedModel}) in ${latencyMs}ms${fallbackNote}.`,
        latencyMs,
      };
    }

    // OpenAI-compatible
    const baseUrl = (settings.openaiBaseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(baseUrl);
    if (!settings.openaiApiKey.trim() && !isLocal) {
      return { ok: false, message: 'Enter your API key for this provider first.' };
    }
    const headers: Record<string, string> = {};
    if (settings.openaiApiKey.trim()) {
      headers.Authorization = `Bearer ${settings.openaiApiKey.trim()}`;
    }
    const res = await fetchWithTimeout(`${baseUrl}/models`, { method: 'GET', headers }, 10_000);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'Authentication failed (HTTP 401/403). Check your API key.', latencyMs };
      }
      return { ok: false, message: `Endpoint returned HTTP ${res.status}.`, latencyMs };
    }
    return {
      ok: true,
      message: `Connected to ${new URL(baseUrl).host} in ${latencyMs}ms.`,
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Connection test failed.',
      latencyMs: Date.now() - started,
    };
  }
}
