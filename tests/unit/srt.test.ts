import { describe, expect, it } from 'vitest';
import { exportCuesToSrt, formatSrtTimestamp } from '../../src/shared/srt';
import type { SubtitleCue } from '../../src/shared/types';

describe('srt exporter', () => {
  it('formats timestamps in HH:MM:SS,mmm', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000');
    expect(formatSrtTimestamp(3_723_456)).toBe('01:02:03,456');
  });

  it('exports original, translated, and dual cues respecting dualOrder', () => {
    const cues: SubtitleCue[] = [
      {
        id: '1',
        startMs: 1200,
        endMs: 3800,
        original: 'Welcome back to the channel.',
        translated: 'Chào mừng bạn quay lại với kênh.',
        source: 'ai',
      },
    ];

    expect(exportCuesToSrt(cues, 'original')).toBe(
      '1\n00:00:01,200 --> 00:00:03,800\nWelcome back to the channel.\n',
    );
    expect(exportCuesToSrt(cues, 'translated')).toBe(
      '1\n00:00:01,200 --> 00:00:03,800\nChào mừng bạn quay lại với kênh.\n',
    );
    expect(exportCuesToSrt(cues, 'dual', 'translated-top')).toBe(
      '1\n00:00:01,200 --> 00:00:03,800\nChào mừng bạn quay lại với kênh.\nWelcome back to the channel.\n',
    );
  });
});
