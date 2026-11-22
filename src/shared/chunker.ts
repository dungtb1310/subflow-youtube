import type { AiRawCue, SubtitleCue, TranscriptChunk, WordToken } from './types';

const ABBREVIATIONS = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'sr.',
  'jr.',
  'st.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
  'u.s.',
  'u.k.',
  'a.m.',
  'p.m.',
  'inc.',
  'ltd.',
]);

const SOFT_BREAK_WORDS = new Set([
  'and',
  'but',
  'so',
  'because',
  'although',
  'though',
  'while',
  'when',
  'where',
  'which',
  'however',
  'actually',
  'basically',
  'then',
  'therefore',
  'instead',
]);

function endsWithSentencePunctuation(word: string): boolean {
  const lower = word.toLowerCase();
  if (ABBREVIATIONS.has(lower)) return false;
  if (/^\d+\.\d+$/.test(word)) return false;
  return /[.?!。？！…]["')\]»”’]*$/.test(word);
}

function endsWithClausePunctuation(word: string): boolean {
  return /[,;:，；：—–-]["')\]»”’]*$/.test(word);
}

function isStageDirection(word: string): boolean {
  return /^\[.*\]$/.test(word) || /^\(.*\)$/.test(word);
}

function formatSentenceText(words: WordToken[], languageCode?: string): string {
  const isEnglishLike = !languageCode || languageCode.toLowerCase().startsWith('en');
  const raw = words.map((w) => w.text).join(' ').replace(/\s+([,.;:?!])/g, '$1').trim();
  if (!raw) return '';

  let cleaned = raw;
  if (isEnglishLike) {
    // Fix common lowercase ASR artifacts for English pronouns
    cleaned = cleaned
      .replace(/\bi\b/g, 'I')
      .replace(/\bi'm\b/gi, "I'm")
      .replace(/\bi've\b/gi, "I've")
      .replace(/\bi'll\b/gi, "I'll")
      .replace(/\bi'd\b/gi, "I'd");
  }

  // Capitalize first alphabetic character if it's lowercase
  if (!isStageDirection(cleaned)) {
    cleaned = cleaned.replace(/^([("'“‘]*)([a-zà-ỹ])/, (_, lead: string, ch: string) => {
      return `${lead}${ch.toUpperCase()}`;
    });
  }

  return cleaned;
}

export interface HeuristicMergeOptions {
  maxWordsPerCue?: number;
  maxCharsPerCue?: number;
  maxDurationMs?: number;
  pauseSplitMs?: number;
  hardPauseSplitMs?: number;
  languageCode?: string;
}

/**
 * Instantly merges choppy word-by-word ASR tokens into natural, readable sentence-level cues.
 * Works 100% offline with zero latency and serves as both Offline mode and immediate preview
 * while the AI engine refines/translates chunks in the background.
 */
export function mergeWordsToHeuristicCues(
  words: WordToken[],
  options: HeuristicMergeOptions = {},
): SubtitleCue[] {
  if (words.length === 0) return [];

  const maxWords = options.maxWordsPerCue ?? 15;
  const maxChars = options.maxCharsPerCue ?? 88;
  const maxDurationMs = options.maxDurationMs ?? 5600;
  const pauseSplitMs = options.pauseSplitMs ?? 650;
  const hardPauseSplitMs = options.hardPauseSplitMs ?? 1100;

  const groups: WordToken[][] = [];
  let buffer: WordToken[] = [];
  let charCount = 0;

  const flush = () => {
    if (buffer.length > 0) {
      groups.push(buffer);
      buffer = [];
      charCount = 0;
    }
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];

    // Keep sound effects like [Music] isolated cleanly
    if (isStageDirection(word.text)) {
      flush();
      groups.push([word]);
      continue;
    }

    buffer.push(word);
    charCount += word.text.length + (buffer.length > 1 ? 1 : 0);

    if (!next) {
      flush();
      break;
    }

    const gapMs = Math.max(0, next.startMs - word.endMs);
    const cueDurationMs = word.endMs - buffer[0].startMs;
    const hitSentenceEnd = endsWithSentencePunctuation(word.text);
    const hitClauseEnd = endsWithClausePunctuation(word.text);

    // 1. Definite sentence end
    if (hitSentenceEnd && (buffer.length >= 3 || gapMs >= 220)) {
      flush();
      continue;
    }

    // 2. Strong natural speech pause
    if (gapMs >= hardPauseSplitMs) {
      flush();
      continue;
    }
    if (gapMs >= pauseSplitMs && buffer.length >= 4) {
      flush();
      continue;
    }

    // 3. Clause punctuation once cue has comfortable length
    if (hitClauseEnd && (buffer.length >= 8 || charCount >= 52 || cueDurationMs >= 3400)) {
      flush();
      continue;
    }

    // 4. Conjunction soft break only when cue is already fairly long
    const nextLower = next.text.toLowerCase().replace(/[^a-z]/g, '');
    if (
      SOFT_BREAK_WORDS.has(nextLower) &&
      (buffer.length >= Math.floor(maxWords * 0.8) || charCount >= Math.floor(maxChars * 0.8))
    ) {
      flush();
      continue;
    }

    // 5. Hard readability caps (look back for best internal pause if possible)
    if (buffer.length >= maxWords || charCount >= maxChars || cueDurationMs >= maxDurationMs) {
      let bestSplitIdx = -1;
      let bestScore = 0;
      for (let k = Math.max(4, Math.floor(buffer.length * 0.45)); k < buffer.length - 1; k++) {
        const internalGap = Math.max(0, buffer[k + 1].startMs - buffer[k].endMs);
        const punctBonus = endsWithClausePunctuation(buffer[k].text) ? 500 : 0;
        const nextTok = buffer[k + 1].text.toLowerCase().replace(/[^a-z]/g, '');
        const conjBonus = SOFT_BREAK_WORDS.has(nextTok) ? 260 : 0;
        const score = internalGap + punctBonus + conjBonus;
        if (score > bestScore && score >= 180) {
          bestScore = score;
          bestSplitIdx = k + 1;
        }
      }

      if (bestSplitIdx > 0 && bestSplitIdx < buffer.length) {
        groups.push(buffer.slice(0, bestSplitIdx));
        buffer = buffer.slice(bestSplitIdx);
        charCount = buffer.reduce((acc, w) => acc + w.text.length + 1, -1);
      } else {
        flush();
      }
    }
  }

  // Convert word groups to non-overlapping SubtitleCues with smooth readable end padding
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < groups.length; i++) {
    const grp = groups[i];
    const nextGrp = groups[i + 1];
    const text = formatSentenceText(grp, options.languageCode);
    if (!text) continue;

    const startMs = grp[0].startMs;
    const rawEndMs = grp[grp.length - 1].endMs;
    const paddedEndMs = rawEndMs + 280;
    const endMs = nextGrp
      ? Math.min(paddedEndMs, Math.max(rawEndMs, nextGrp[0].startMs - 20))
      : paddedEndMs + 320;

    cues.push({
      id: `h-${grp[0].index}-${grp[grp.length - 1].index}`,
      startMs,
      endMs: Math.max(startMs + 250, endMs),
      original: text,
      source: 'heuristic',
    });
  }

  return cues;
}

/**
 * Splits full transcript into semantic processing chunks (~40-55s / ~100-130 words)
 * preferring natural pauses or sentence boundaries near each split point.
 */
export function splitWordsIntoAiChunks(
  words: WordToken[],
  targetWords = 115,
  maxDurationMs = 52_000,
): TranscriptChunk[] {
  if (words.length === 0) return [];

  const chunks: TranscriptChunk[] = [];
  let cursor = 0;
  let chunkIndex = 0;

  while (cursor < words.length) {
    const remaining = words.length - cursor;
    if (remaining <= Math.round(targetWords * 1.25)) {
      const slice = words.slice(cursor);
      chunks.push({
        chunkIndex,
        startWordIndex: slice[0].index,
        endWordIndex: slice[slice.length - 1].index,
        startMs: slice[0].startMs,
        endMs: slice[slice.length - 1].endMs,
        words: slice,
      });
      break;
    }

    // Find max index allowed by word count and duration
    let idealEnd = Math.min(words.length - 1, cursor + targetWords - 1);
    const chunkStartMs = words[cursor].startMs;
    while (
      idealEnd > cursor + 25 &&
      words[idealEnd].endMs - chunkStartMs > maxDurationMs
    ) {
      idealEnd--;
    }

    // Search window around idealEnd for best sentence end or speech pause
    const searchStart = Math.max(cursor + 30, idealEnd - 25);
    const searchEnd = Math.min(words.length - 2, idealEnd + 20);
    let bestEnd = idealEnd;
    let bestScore = -1;

    for (let idx = searchStart; idx <= searchEnd; idx++) {
      const w = words[idx];
      const next = words[idx + 1];
      const gap = Math.max(0, next.startMs - w.endMs);
      const sentBonus = endsWithSentencePunctuation(w.text) ? 900 : 0;
      const clauseBonus = endsWithClausePunctuation(w.text) ? 300 : 0;
      const distancePenalty = Math.abs(idx - idealEnd) * 8;
      const score = gap + sentBonus + clauseBonus - distancePenalty;
      if (score > bestScore) {
        bestScore = score;
        bestEnd = idx;
      }
    }

    const slice = words.slice(cursor, bestEnd + 1);
    chunks.push({
      chunkIndex,
      startWordIndex: slice[0].index,
      endWordIndex: slice[slice.length - 1].index,
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      words: slice,
    });

    cursor = bestEnd + 1;
    chunkIndex++;
  }

  return chunks;
}

/**
 * Maps AI-generated cues (using word indices) safely back to exact millisecond timestamps.
 * Guarantees monotonic timing, zero out-of-bounds crashes, and fills any dropped word gaps.
 */
export function alignAiCuesToWords(
  rawCues: AiRawCue[],
  chunkWords: WordToken[],
  chunkIndex: number,
  languageCode?: string,
): SubtitleCue[] {
  if (chunkWords.length === 0) return [];
  if (!Array.isArray(rawCues) || rawCues.length === 0) {
    return mergeWordsToHeuristicCues(chunkWords, { languageCode });
  }

  const firstGlobalIdx = chunkWords[0].index;
  const lastGlobalIdx = chunkWords[chunkWords.length - 1].index;
  const count = chunkWords.length;

  // Detect whether model returned local indices (0..count-1) or global word indices
  const usesGlobalIndices =
    firstGlobalIdx > 0 &&
    rawCues.some((c) => c.startWord >= firstGlobalIdx && c.startWord <= lastGlobalIdx) &&
    !rawCues.some((c) => c.startWord < firstGlobalIdx);

  const normalizeIdx = (idx: number): number => {
    const shifted = usesGlobalIndices ? idx - firstGlobalIdx : idx;
    return Math.max(0, Math.min(count - 1, Math.round(shifted)));
  };

  interface NormalizedCue {
    startLocal: number;
    endLocal: number;
    original: string;
    translated?: string;
  }

  const normalized: NormalizedCue[] = [];
  for (const rc of rawCues) {
    if (!rc || typeof rc.startWord !== 'number' || typeof rc.endWord !== 'number') continue;
    const orig = typeof rc.original === 'string' ? rc.original.trim() : '';
    const trans = typeof rc.translated === 'string' ? rc.translated.trim() : undefined;
    if (!orig && !trans) continue;

    let s = normalizeIdx(rc.startWord);
    let e = normalizeIdx(rc.endWord);
    if (e < s) {
      [s, e] = [e, s];
    }

    normalized.push({
      startLocal: s,
      endLocal: e,
      original: orig || formatSentenceText(chunkWords.slice(s, e + 1), languageCode),
      translated: trans,
    });
  }

  if (normalized.length === 0) {
    return mergeWordsToHeuristicCues(chunkWords, { languageCode });
  }

  normalized.sort((a, b) => a.startLocal - b.startLocal || a.endLocal - b.endLocal);

  // Enforce non-overlapping monotonic word ranges and fill large uncovered gaps
  const finalCues: SubtitleCue[] = [];
  let coveredUpTo = -1;

  for (let i = 0; i < normalized.length; i++) {
    const item = normalized[i];
    const startLocal = Math.max(coveredUpTo + 1, item.startLocal);
    if (startLocal >= count) break;

    // Fill large gap (> 5 dropped words) with heuristic fallback so nothing vanishes
    if (startLocal - (coveredUpTo + 1) >= 6) {
      const gapWords = chunkWords.slice(coveredUpTo + 1, startLocal);
      finalCues.push(...mergeWordsToHeuristicCues(gapWords, { languageCode }));
    }

    const endLocal = Math.max(startLocal, Math.min(count - 1, item.endLocal));
    const startWord = chunkWords[startLocal];
    const endWord = chunkWords[endLocal];

    finalCues.push({
      id: `ai-c${chunkIndex}-${i}`,
      startMs: startWord.startMs,
      endMs: endWord.endMs + 220,
      original: item.original,
      translated: item.translated,
      source: 'ai',
    });

    coveredUpTo = endLocal;
  }

  // Cover significant trailing words if AI stopped early
  if (count - 1 - coveredUpTo >= 6) {
    const tailWords = chunkWords.slice(coveredUpTo + 1);
    finalCues.push(...mergeWordsToHeuristicCues(tailWords, { languageCode }));
  }

  // Clamp cue endMs strictly against the next cue's startMs
  for (let i = 0; i < finalCues.length - 1; i++) {
    const curr = finalCues[i];
    const next = finalCues[i + 1];
    if (curr.endMs > next.startMs - 15) {
      curr.endMs = Math.max(curr.startMs + 200, next.startMs - 15);
    }
  }

  return finalCues;
}

/**
 * Binary search to find the active SubtitleCue at a given playback timestamp (ms).
 */
export function findCueAtTime(cues: SubtitleCue[], timeMs: number): SubtitleCue | null {
  if (cues.length === 0) return null;

  let lo = 0;
  let hi = cues.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cue = cues[mid];
    if (timeMs < cue.startMs) {
      hi = mid - 1;
    } else if (timeMs > cue.endMs) {
      lo = mid + 1;
    } else {
      return cue;
    }
  }

  return null;
}
