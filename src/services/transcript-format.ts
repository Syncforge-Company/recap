import type { Segment } from './transcription-service';

/** SRT subtitles with the speaker name prefixed to each cue. */
export function toSRT(segments: Segment[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${formatSRTTime(seg.start)} --> ${formatSRTTime(seg.end)}\n[${seg.speaker}]: ${seg.text}\n`)
    .join('\n');
}

/** Plain text grouped into speaker turns. */
export function toPlainText(segments: Segment[]): string {
  let text = '';
  let lastSpeaker = '';
  for (const seg of segments) {
    if (seg.speaker !== lastSpeaker) {
      if (text) text += '\n';
      text += `\n[${seg.speaker}]:\n`;
      lastSpeaker = seg.speaker;
    }
    text += `${seg.text} `;
  }
  return text.trim();
}

export function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000) % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Chronological order; ties broken by end time then speaker for determinism. */
export function sortSegments(segments: Segment[]): Segment[] {
  return segments.sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));
}
