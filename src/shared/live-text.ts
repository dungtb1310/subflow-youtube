/**
 * Cinema-grade Live Subtitle line-limiting & incremental sentence helpers.
 * Keeps livestream overlays crisp (1-2 lines, ~110-120 chars max) even when
 * a streamer speaks continuously for 30+ seconds without pausing.
 */

export const DEFAULT_LIVE_MAX_CHARS = 115;

const SENTENCE_END_RE = /[.!?。！？]+["'”’)\]]*$/;

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Splits a running livestream transcript into individual sentences while preserving
 * trailing sentence-ending punctuation on each sentence.
 */
export function splitLiveSentences(text: string): string[] {
  const cleaned = normalizeSpaces(text);
  if (!cleaned) return [];

  // Split after ASCII punctuation + whitespace, or after CJK sentence-ending punctuation
  const parts = cleaned
    .split(/(?<=[.!?]["'”’)\]]*)\s+|(?<=[。！？]["'”’)\]]*)\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [cleaned];
}

/**
 * Separates already-completed sentences (followed by subsequent speech) from the
 * active trailing sentence still being spoken.
 */
export function splitCompletedAndActive(text: string): {
  completed: string[];
  active: string;
} {
  const sentences = splitLiveSentences(text);
  if (sentences.length <= 1) {
    return { completed: [], active: sentences[0] ?? '' };
  }

  const completed: string[] = [];
  for (let i = 0; i < sentences.length - 1; i++) {
    if (SENTENCE_END_RE.test(sentences[i])) {
      completed.push(sentences[i]);
    }
  }
  return {
    completed,
    active: sentences[sentences.length - 1],
  };
}

/**
 * Trims a single overly long run-on sentence from the LEFT so the newest spoken
 * words stay completely visible within `maxChars` (~1-2 subtitle lines).
 */
function trimTrailingTail(sentence: string, maxChars: number): string {
  if (sentence.length <= maxChars) return sentence;

  const budget = Math.max(24, maxChars - 2); // leave room for "… "
  const rawTail = sentence.slice(-budget);

  // If no spaces (e.g. CJK), trim directly on character boundary
  if (!rawTail.includes(' ')) {
    return `…${rawTail.trim()}`;
  }

  // Prefer breaking right after a clause comma/semicolon near the start of the window
  const clauseIdx = rawTail.search(/[,;:]\s+/);
  if (clauseIdx >= 0 && clauseIdx <= Math.floor(rawTail.length * 0.35)) {
    const afterClause = rawTail.slice(clauseIdx + 1).trim();
    if (afterClause.length >= Math.floor(budget * 0.55)) {
      return `… ${afterClause}`;
    }
  }

  // Otherwise snap cleanly to the first complete word boundary
  const firstSpace = rawTail.indexOf(' ');
  const wordAligned = firstSpace >= 0 && firstSpace < rawTail.length - 12
    ? rawTail.slice(firstSpace + 1).trim()
    : rawTail.trim();

  return `… ${wordAligned}`;
}

/**
 * Formats a livestream transcript for clean 1-2 line cinema display.
 * - Drops older completed sentences from long monologues so the box never grows tall.
 * - Keeps the previous sentence ONLY when the latest sentence is very short and
 *   both fit together comfortably inside `maxChars`.
 * - Smoothly trims run-on sentences from the left on a word boundary so the newest
 *   words are never clipped.
 */
export function formatLiveSubtitleWindow(
  text: string,
  maxChars = DEFAULT_LIVE_MAX_CHARS,
): string {
  const sentences = splitLiveSentences(text);
  if (sentences.length === 0) return '';

  const latest = sentences[sentences.length - 1];

  // If latest sentence is very brief (e.g., "Right?"), pair with immediate predecessor if it fits
  if (sentences.length >= 2 && latest.length < 36) {
    const combined = `${sentences[sentences.length - 2]} ${latest}`;
    if (combined.length <= maxChars) {
      return combined;
    }
  }

  return trimTrailingTail(latest, maxChars);
}
