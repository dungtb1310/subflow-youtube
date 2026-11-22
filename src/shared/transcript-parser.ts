import type { WordToken } from './types';

interface Json3Segment {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Segment[];
}

interface Json3Transcript {
  events?: Json3Event[];
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITY_MAP[entity] ?? match;
  });
}

function tokenizeText(raw: string): string[] {
  const cleaned = decodeHtmlEntities(raw)
    .replace(/\u200B|\uFEFF/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned.split(' ').filter(Boolean);
}

function appendDistributedWords(
  out: Array<{ text: string; startMs: number; endMs: number }>,
  text: string,
  startMs: number,
  endMs: number,
): void {
  const pieces = tokenizeText(text);
  if (pieces.length === 0) return;

  const safeStart = Math.max(0, Math.round(startMs));
  const safeDuration = Math.max(120, Math.round(endMs - safeStart));

  if (pieces.length === 1) {
    out.push({
      text: pieces[0],
      startMs: safeStart,
      endMs: safeStart + safeDuration,
    });
    return;
  }

  // Distribute duration proportionally by character weight for multi-word segments
  const weights = pieces.map((p) => Math.max(1, p.length));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  let cursor = safeStart;

  for (let i = 0; i < pieces.length; i++) {
    const sliceMs =
      i === pieces.length - 1
        ? safeStart + safeDuration - cursor
        : Math.max(60, Math.round((safeDuration * weights[i]) / totalWeight));
    const tokenEnd = Math.max(cursor + 60, cursor + sliceMs);
    out.push({
      text: pieces[i],
      startMs: cursor,
      endMs: tokenEnd,
    });
    cursor = tokenEnd;
  }
}

function finalizeWordTokens(
  rawTokens: Array<{ text: string; startMs: number; endMs: number }>,
): WordToken[] {
  if (rawTokens.length === 0) return [];

  rawTokens.sort((a, b) => a.startMs - b.startMs);

  // Deduplicate accidental overlapping duplicates with near-identical timestamps & text
  const deduped: Array<{ text: string; startMs: number; endMs: number }> = [];
  for (const tok of rawTokens) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.text.toLowerCase() === tok.text.toLowerCase() &&
      Math.abs(tok.startMs - prev.startMs) < 90
    ) {
      prev.endMs = Math.max(prev.endMs, tok.endMs);
      continue;
    }
    deduped.push({ ...tok });
  }

  // Clamp endMs so each word ends cleanly before or at the next word's start
  const result: WordToken[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const curr = deduped[i];
    const next = deduped[i + 1];
    let endMs = Math.max(curr.startMs + 80, curr.endMs);

    // Estimate realistic spoken word duration so YouTube's inflated event dDurationMs
    // (display dwell time) does not swallow genuine silence pauses between sentences.
    const estimatedSpokenMs = Math.min(720, Math.max(220, curr.text.length * 65 + 140));
    if (next) {
      const spanToNext = next.startMs - curr.startMs;
      if (spanToNext > estimatedSpokenMs + 180) {
        endMs = Math.min(endMs, curr.startMs + estimatedSpokenMs);
      } else if (spanToNext > 0 && endMs > next.startMs) {
        endMs = Math.max(curr.startMs + 60, next.startMs);
      } else if (spanToNext === 0) {
        endMs = curr.startMs + 80;
      }
    } else if (endMs - curr.startMs > estimatedSpokenMs + 250) {
      endMs = curr.startMs + estimatedSpokenMs + 250;
    }

    result.push({
      index: i,
      text: curr.text,
      startMs: curr.startMs,
      endMs,
    });
  }

  return result;
}

export function parseJson3Transcript(json: Json3Transcript): WordToken[] {
  const events = json?.events;
  if (!Array.isArray(events) || events.length === 0) return [];

  const rawTokens: Array<{ text: string; startMs: number; endMs: number }> = [];

  for (let eIdx = 0; eIdx < events.length; eIdx++) {
    const ev = events[eIdx];
    if (!ev || typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs)) continue;

    // Skip pure append newline markers used by YouTube's rolling ASR display
    const meaningfulSegs = ev.segs.filter(
      (s) => typeof s?.utf8 === 'string' && s.utf8.replace(/[\r\n\s]+/g, '').length > 0,
    );
    if (meaningfulSegs.length === 0) continue;

    const eventStart = Math.max(0, ev.tStartMs);
    const nextEventStart = findNextMeaningfulEventStart(events, eIdx);
    const fallbackDur =
      typeof ev.dDurationMs === 'number' && ev.dDurationMs > 0
        ? ev.dDurationMs
        : nextEventStart !== null
          ? Math.max(300, nextEventStart - eventStart)
          : 2500;
    const eventEnd = eventStart + fallbackDur;

    // Check if segments carry individual tOffsetMs (word-level ASR)
    const hasOffsets = meaningfulSegs.some((s) => typeof s.tOffsetMs === 'number' && s.tOffsetMs > 0);

    if (hasOffsets || meaningfulSegs.length > 1) {
      for (let sIdx = 0; sIdx < meaningfulSegs.length; sIdx++) {
        const seg = meaningfulSegs[sIdx];
        const segStart = eventStart + (typeof seg.tOffsetMs === 'number' ? seg.tOffsetMs : 0);
        const nextSeg = meaningfulSegs[sIdx + 1];
        const nextSegStart =
          nextSeg && typeof nextSeg.tOffsetMs === 'number'
            ? eventStart + nextSeg.tOffsetMs
            : null;
        const segEnd =
          nextSegStart !== null && nextSegStart > segStart
            ? nextSegStart
            : Math.min(eventEnd, nextEventStart ?? eventEnd);

        appendDistributedWords(rawTokens, seg.utf8 ?? '', segStart, Math.max(segStart + 160, segEnd));
      }
    } else {
      const fullText = meaningfulSegs.map((s) => s.utf8 ?? '').join('');
      const effectiveEnd =
        nextEventStart !== null && nextEventStart > eventStart
          ? Math.min(eventEnd, nextEventStart + 120)
          : eventEnd;
      appendDistributedWords(rawTokens, fullText, eventStart, Math.max(eventStart + 250, effectiveEnd));
    }
  }

  return finalizeWordTokens(rawTokens);
}

function findNextMeaningfulEventStart(events: Json3Event[], currentIdx: number): number | null {
  for (let i = currentIdx + 1; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs)) continue;
    const hasText = ev.segs.some(
      (s) => typeof s?.utf8 === 'string' && s.utf8.replace(/[\r\n\s]+/g, '').length > 0,
    );
    if (hasText) return ev.tStartMs;
  }
  return null;
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrText)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

export function parseXmlTranscript(xml: string): WordToken[] {
  const rawTokens: Array<{ text: string; startMs: number; endMs: number }> = [];

  // Format 1: timedtext format="3" (<p t="ms" d="ms"><s>word</s></p>)
  if (/<p\s+[^>]*\bt="/i.test(xml)) {
    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pRe.exec(xml)) !== null) {
      const pAttrs = parseAttributes(pMatch[1]);
      const pStart = Number(pAttrs.t ?? 0);
      const pDur = Number(pAttrs.d ?? 2000);
      const inner = pMatch[2];

      const sRe = /<s\b([^>]*)>([\s\S]*?)<\/s>/gi;
      const segs: Array<{ text: string; offsetMs: number }> = [];
      let sMatch: RegExpExecArray | null;
      while ((sMatch = sRe.exec(inner)) !== null) {
        const sAttrs = parseAttributes(sMatch[1]);
        const offsetMs = Number(sAttrs.t ?? 0);
        const text = sMatch[2].replace(/<[^>]+>/g, '');
        if (text.trim()) {
          segs.push({ text, offsetMs });
        }
      }

      if (segs.length > 0) {
        for (let i = 0; i < segs.length; i++) {
          const startMs = pStart + segs[i].offsetMs;
          const nextStart = i + 1 < segs.length ? pStart + segs[i + 1].offsetMs : pStart + pDur;
          appendDistributedWords(rawTokens, segs[i].text, startMs, Math.max(startMs + 140, nextStart));
        }
      } else {
        const plain = inner.replace(/<[^>]+>/g, '');
        appendDistributedWords(rawTokens, plain, pStart, pStart + Math.max(250, pDur));
      }
    }
    return finalizeWordTokens(rawTokens);
  }

  // Format 2: classic timedtext XML (<text start="sec" dur="sec">...</text>)
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let tMatch: RegExpExecArray | null;
  while ((tMatch = textRe.exec(xml)) !== null) {
    const attrs = parseAttributes(tMatch[1]);
    const startSec = Number.parseFloat(attrs.start ?? '0');
    const durSec = Number.parseFloat(attrs.dur ?? '2.5');
    if (!Number.isFinite(startSec)) continue;
    const startMs = Math.round(startSec * 1000);
    const endMs = startMs + Math.round((Number.isFinite(durSec) && durSec > 0 ? durSec : 2.5) * 1000);
    const plain = tMatch[2].replace(/<[^>]+>/g, '');
    appendDistributedWords(rawTokens, plain, startMs, endMs);
  }

  return finalizeWordTokens(rawTokens);
}

export function parseYouTubeTranscript(payload: string | unknown): WordToken[] {
  if (!payload) return [];

  if (typeof payload === 'object') {
    return parseJson3Transcript(payload as Json3Transcript);
  }

  if (typeof payload !== 'string') return [];

  const trimmed = payload.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Json3Transcript;
      return parseJson3Transcript(parsed);
    } catch {
      return [];
    }
  }

  if (trimmed.startsWith('<')) {
    return parseXmlTranscript(trimmed);
  }

  return [];
}
