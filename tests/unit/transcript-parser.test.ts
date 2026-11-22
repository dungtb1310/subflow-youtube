import { describe, expect, it } from 'vitest';
import { pickBestCaptionTrack } from '../../src/content/subtitle-manager';
import {
  decodeHtmlEntities,
  parseJson3Transcript,
  parseXmlTranscript,
  parseYouTubeTranscript,
} from '../../src/shared/transcript-parser';

describe('transcript-parser', () => {
  it('decodes named, decimal, and hex HTML entities', () => {
    expect(decodeHtmlEntities('don&#39;t &amp; won&#x27;t &quot;quote&quot;')).toBe(
      `don't & won't "quote"`,
    );
  });

  it('parses noisy word-by-word YouTube json3 ASR transcripts cleanly', () => {
    const sampleJson3 = {
      events: [
        // Pure newline rolling-window event (should be ignored)
        { tStartMs: 500, dDurationMs: 200, aAppend: 1, segs: [{ utf8: '\n' }] },
        {
          tStartMs: 1000,
          dDurationMs: 4200,
          segs: [
            { utf8: 'welcome' },
            { utf8: ' back', tOffsetMs: 320 },
            { utf8: ' to', tOffsetMs: 640 },
            { utf8: ' the', tOffsetMs: 820 },
            { utf8: ' channel', tOffsetMs: 1050 },
          ],
        },
        {
          tStartMs: 2900,
          dDurationMs: 3100,
          segs: [
            { utf8: 'today' },
            { utf8: ' we&#39;re', tOffsetMs: 300 },
            { utf8: ' building', tOffsetMs: 620 },
            { utf8: ' better', tOffsetMs: 980 },
            { utf8: ' subtitles', tOffsetMs: 1320 },
          ],
        },
      ],
    };

    const words = parseJson3Transcript(sampleJson3);
    expect(words.map((w) => w.text)).toEqual([
      'welcome',
      'back',
      'to',
      'the',
      'channel',
      'today',
      "we're",
      'building',
      'better',
      'subtitles',
    ]);

    // Check monotonic non-overlapping timestamps
    for (let i = 0; i < words.length; i++) {
      expect(words[i].index).toBe(i);
      expect(words[i].endMs).toBeGreaterThan(words[i].startMs);
      if (i > 0) {
        expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
        expect(words[i - 1].endMs).toBeLessThanOrEqual(words[i].startMs);
      }
    }

    // Verify genuine pause between "channel" (2050ms) and "today" (2900ms) is preserved
    // rather than swallowed by YouTube's inflated event dDurationMs (4200ms)
    const channelWord = words[4];
    const todayWord = words[5];
    expect(todayWord.startMs - channelWord.endMs).toBeGreaterThanOrEqual(200);
  });

  it('parses classic timedtext XML and format-3 XML', () => {
    const classicXml = `<?xml version="1.0" encoding="utf-8" ?>
      <transcript>
        <text start="1.5" dur="2.0">Hello &amp; welcome</text>
        <text start="4.0" dur="1.8">to BetterSubtitle.</text>
      </transcript>`;

    const wordsClassic = parseXmlTranscript(classicXml);
    expect(wordsClassic.map((w) => w.text)).toEqual(['Hello', '&', 'welcome', 'to', 'BetterSubtitle.']);
    expect(wordsClassic[0].startMs).toBe(1500);
    expect(wordsClassic[3].startMs).toBe(4000);

    const srv3Xml = `<timedtext format="3"><body>
      <p t="2000" d="1800"><s>hello</s><s t="400"> world</s></p>
    </body></timedtext>`;
    const wordsSrv3 = parseYouTubeTranscript(srv3Xml);
    expect(wordsSrv3.map((w) => w.text)).toEqual(['hello', 'world']);
    expect(wordsSrv3[0].startMs).toBe(2000);
    expect(wordsSrv3[1].startMs).toBe(2400);
  });

  it('picks native spoken language track instead of alphabetical first track (e.g. English over Arabic)', () => {
    const tracks = [
      { languageCode: 'ar', name: 'Arabic', baseUrl: 'https://yt/ar' },
      { languageCode: 'bn', name: 'Bangla', baseUrl: 'https://yt/bn' },
      { languageCode: 'en', name: 'English', baseUrl: 'https://yt/en', isDefault: true },
      { languageCode: 'en', name: 'English (auto-generated)', baseUrl: 'https://yt/en-asr', kind: 'asr' },
      { languageCode: 'vi', name: 'Vietnamese', baseUrl: 'https://yt/vi' },
    ];
    const picked = pickBestCaptionTrack(tracks);
    expect(picked?.languageCode).toBe('en');
    expect(picked?.kind).toBeUndefined();

    // When only ASR exists for native spoken language alongside translated manual tracks
    const asrOnlyNative = [
      { languageCode: 'ar', name: 'Arabic', baseUrl: 'https://yt/ar' },
      { languageCode: 'ja', name: 'Japanese (auto-generated)', baseUrl: 'https://yt/ja-asr', kind: 'asr' },
    ];
    expect(pickBestCaptionTrack(asrOnlyNative)?.languageCode).toBe('ja');
  });
});
