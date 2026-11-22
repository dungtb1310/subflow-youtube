import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_MAX_CHARS,
  formatLiveSubtitleWindow,
  splitCompletedAndActive,
  splitLiveSentences,
} from '../../src/shared/live-text';

describe('live-text cinema line windowing & incremental sentence splitting', () => {
  const LONG_MONOLOGUE =
    "Yeah, I think that's fair. Did you hear about them giving you negative reputation and a bad ending if you play GTA the way it's supposed to be played? I don't think that the best thing about a game like GTA is that there is no supposed to be played. And this is a big opinion that I have about like a lot of sandbox games is that the best sandbox games are the ones that allow you to effectively pick your own path in the game. I think that if you want to play the game and be family friendly and rescue everybody's dog and get the cats out of the tree and help old ladies across the";

  it('splits multi-sentence livestream monologues cleanly', () => {
    const sentences = splitLiveSentences(LONG_MONOLOGUE);
    expect(sentences).toHaveLength(5);
    expect(sentences[0]).toBe("Yeah, I think that's fair.");
    expect(sentences[1]).toContain('supposed to be played?');
    expect(sentences[4]).toContain('help old ladies across the');
  });

  it('extracts already-completed sentences separately from the active trailing speech', () => {
    const { completed, active } = splitCompletedAndActive(LONG_MONOLOGUE);
    expect(completed).toHaveLength(4);
    expect(completed[0]).toBe("Yeah, I think that's fair.");
    expect(active).toContain('rescue everybody');
  });

  it('keeps long livestream monologues strictly within 1-2 lines (~115 chars) preserving newest words', () => {
    const display = formatLiveSubtitleWindow(LONG_MONOLOGUE);
    expect(display.length).toBeLessThanOrEqual(DEFAULT_LIVE_MAX_CHARS);
    expect(display.startsWith('… ')).toBe(true);
    expect(display.endsWith('help old ladies across the')).toBe(true);
    // Must not keep old sentences from 20 seconds ago
    expect(display).not.toContain('negative reputation');
  });

  it('pairs a very short latest sentence with its predecessor only when both fit cleanly', () => {
    const shortPair = formatLiveSubtitleWindow("That's actually crazy. Right?");
    expect(shortPair).toBe("That's actually crazy. Right?");

    const longPrevShortLatest = formatLiveSubtitleWindow(
      'This is a much longer previous sentence that already fills up two entire lines of screen space on a livestream. Right?',
    );
    expect(longPrevShortLatest).toBe('Right?');
  });

  it('handles CJK text without spaces cleanly', () => {
    const cjk = 'これは最初の文です。これは二番目の文で、配信者が止まらずに話し続けているテストです。';
    const sentences = splitLiveSentences(cjk);
    expect(sentences).toHaveLength(2);
    const display = formatLiveSubtitleWindow(cjk, 40);
    expect(display.length).toBeLessThanOrEqual(40);
    expect(display.endsWith('テストです。')).toBe(true);
  });
});
