import type { DualOrder, SubtitleCue, SubtitleMode } from './types';

function pad(n: number, len = 2): string {
  return String(Math.floor(n)).padStart(len, '0');
}

export function formatSrtTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

export function exportCuesToSrt(
  cues: SubtitleCue[],
  mode: SubtitleMode,
  dualOrder: DualOrder = 'original-top',
): string {
  const blocks: string[] = [];
  let seq = 1;

  for (const cue of cues) {
    const lines: string[] = [];
    if (mode === 'original') {
      lines.push(cue.original);
    } else if (mode === 'translated') {
      lines.push(cue.translated || cue.original);
    } else {
      if (cue.translated && cue.translated !== cue.original) {
        if (dualOrder === 'translated-top') {
          lines.push(cue.translated, cue.original);
        } else {
          lines.push(cue.original, cue.translated);
        }
      } else {
        lines.push(cue.original);
      }
    }

    const body = lines.filter((l) => l.trim().length > 0).join('\n');
    if (!body) continue;

    blocks.push(
      `${seq}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${body}`,
    );
    seq++;
  }

  return blocks.join('\n\n') + (blocks.length > 0 ? '\n' : '');
}
