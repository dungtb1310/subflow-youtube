import { describe, expect, it } from 'vitest';
import {
  alignAiCuesToWords,
  findCueAtTime,
  mergeWordsToHeuristicCues,
  splitWordsIntoAiChunks,
} from '../../src/shared/chunker';
import type { WordToken } from '../../src/shared/types';

function makeWordStream(sentences: Array<{ words: string[]; gapBeforeMs?: number }>): WordToken[] {
  const out: WordToken[] = [];
  let t = 1000;
  let idx = 0;

  for (const s of sentences) {
    if (s.gapBeforeMs) t += s.gapBeforeMs;
    for (const w of s.words) {
      out.push({ index: idx++, text: w, startMs: t, endMs: t + 260 });
      t += 300;
    }
  }
  return out;
}

describe('chunker & sentence merger', () => {
  it('merges choppy unpunctuated ASR words into readable sentence cues using pauses', () => {
    const words = makeWordStream([
      { words: ['i', 'think', 'youtube', 'auto', 'captions', 'are', 'really', 'hard', 'to', 'read'] },
      { gapBeforeMs: 950, words: ['so', "i'm", 'building', 'a', 'much', 'cleaner', 'extension'] },
    ]);

    const cues = mergeWordsToHeuristicCues(words, { languageCode: 'en' });
    expect(cues).toHaveLength(2);
    expect(cues[0].original).toBe('I think youtube auto captions are really hard to read');
    expect(cues[1].original).toBe("So I'm building a much cleaner extension");
    expect(cues[0].endMs).toBeLessThan(cues[1].startMs);
  });

  it('splits on terminal punctuation without breaking on abbreviations like Dr.', () => {
    const words = makeWordStream([
      { words: ['Dr.', 'Smith', 'explained', 'the', 'algorithm.', 'Then', 'we', 'tested', 'it.'] },
    ]);

    const cues = mergeWordsToHeuristicCues(words, { languageCode: 'en' });
    expect(cues).toHaveLength(2);
    expect(cues[0].original).toBe('Dr. Smith explained the algorithm.');
    expect(cues[1].original).toBe('Then we tested it.');
  });

  it('splits long transcripts into semantic AI chunks at pause boundaries', () => {
    const stream = makeWordStream([
      { words: Array.from({ length: 100 }, (_, i) => `word${i}`) },
      { gapBeforeMs: 1400, words: Array.from({ length: 100 }, (_, i) => `next${i}`) },
    ]);

    const chunks = splitWordsIntoAiChunks(stream, 105, 60_000);
    expect(chunks.length).toBe(2);
    expect(chunks[0].words[chunks[0].words.length - 1].text).toBe('word99');
    expect(chunks[1].words[0].text).toBe('next0');
  });

  it('maps AI word-index cues accurately back to exact timestamps and fills dropped gaps', () => {
    const words = makeWordStream([
      { words: ['hello', 'everyone', 'welcome', 'back', 'today', 'we', 'fix', 'captions'] },
    ]);

    const cues = alignAiCuesToWords(
      [
        {
          startWord: 0,
          endWord: 3,
          original: 'Hello everyone, welcome back.',
          translated: 'Xin chào mọi người, chào mừng quay lại.',
        },
        {
          startWord: 4,
          endWord: 7,
          original: 'Today we fix captions.',
          translated: 'Hôm nay chúng ta sửa phụ đề.',
        },
      ],
      words,
      0,
      'en',
    );

    expect(cues).toHaveLength(2);
    expect(cues[0].startMs).toBe(words[0].startMs);
    expect(cues[1].startMs).toBe(words[4].startMs);
    expect(cues[0].translated).toBe('Xin chào mọi người, chào mừng quay lại.');
    expect(findCueAtTime(cues, words[5].startMs + 50)?.id).toBe(cues[1].id);
    expect(findCueAtTime(cues, 100)).toBeNull();
  });
});
