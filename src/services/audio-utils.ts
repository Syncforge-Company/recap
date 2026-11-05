import fs from 'fs';
import { spawn } from 'child_process';

/**
 * Audio helpers for the Groq/Whisper transcription path.
 *
 * Pipeline per track:
 *   1. Convert any input (raw 48 kHz stereo PCM from Discord, or an uploaded
 *      m4a/mp3/ogg/wav) to 16 kHz mono s16le PCM with ffmpeg. Whisper works at
 *      16 kHz anyway, and this cuts the data ~6x before we touch it.
 *   2. Run a simple energy-based voice activity detector (VAD) over that PCM to
 *      find the regions where someone is actually speaking. Discord tracks are
 *      padded with silence so they stay time-aligned; sending that silence would
 *      burn the provider's audio-seconds quota for nothing.
 *   3. Pack speech regions into chunks (short gaps between regions), encode each
 *      chunk as a small Ogg/Opus file, and keep a map from chunk time back to
 *      original track time so transcript timestamps stay correct.
 */

export const VAD_SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2; // s16le mono
const BYTES_PER_SECOND = VAD_SAMPLE_RATE * BYTES_PER_SAMPLE;

export interface SpeechRegion {
  /** Seconds from the start of the track. */
  start: number;
  end: number;
}

export interface ChunkPiece {
  /** Where this piece starts inside the encoded chunk (seconds). */
  chunkStart: number;
  /** Original track time range covered by this piece (seconds). */
  start: number;
  end: number;
}

export interface AudioChunk {
  pieces: ChunkPiece[];
  /** Total encoded duration, including the short gaps between pieces (seconds). */
  duration: number;
}

export interface VadOptions {
  /** Frame length used for energy measurement. */
  frameMs?: number;
  /** Frames louder than this (dBFS, RMS) count as speech. */
  thresholdDbfs?: number;
  /** Padding kept around each speech region so words aren't clipped. */
  padSeconds?: number;
  /** Silence shorter than this between two regions merges them into one. */
  mergeGapSeconds?: number;
  /** Regions shorter than this (after merging) are dropped as noise/clicks. */
  minRegionSeconds?: number;
}

const DEFAULT_VAD: Required<VadOptions> = {
  frameMs: 30,
  thresholdDbfs: -45,
  padSeconds: 0.3,
  mergeGapSeconds: 1.0,
  minRegionSeconds: 0.4,
};

/** Run ffmpeg with the given args; resolves when it exits 0. */
export function runFfmpeg(args: string[], stdinData?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: [stdinData ? 'pipe' : 'ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg failed to start (is it installed?): ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
    if (stdinData && proc.stdin) {
      proc.stdin.on('error', () => { /* ffmpeg may close stdin early on error; reported via close */ });
      proc.stdin.end(stdinData);
    }
  });
}

/** Convert raw Discord PCM (48 kHz, s16le, stereo) to 16 kHz mono s16le PCM. */
export function discordPcmTo16kMono(inputPath: string, outputPath: string): Promise<void> {
  return runFfmpeg([
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', inputPath,
    '-ar', String(VAD_SAMPLE_RATE), '-ac', '1', '-f', 's16le', outputPath,
  ]);
}

/** Convert any audio/video file ffmpeg understands to 16 kHz mono s16le PCM. */
export function anyAudioTo16kMono(inputPath: string, outputPath: string): Promise<void> {
  return runFfmpeg([
    '-i', inputPath, '-vn',
    '-ar', String(VAD_SAMPLE_RATE), '-ac', '1', '-f', 's16le', outputPath,
  ]);
}

/** Duration in seconds of a 16 kHz mono s16le PCM file. */
export function pcm16kDuration(pcmPath: string): number {
  return fs.statSync(pcmPath).size / BYTES_PER_SECOND;
}

/**
 * Turn a per-frame "is speech" mask into padded, merged speech regions.
 * Pure function so it can be unit-tested without audio files.
 */
export function regionsFromFrames(
  speechFrames: boolean[],
  frameSeconds: number,
  totalSeconds: number,
  opts: VadOptions = {},
): SpeechRegion[] {
  const o = { ...DEFAULT_VAD, ...opts };
  const raw: SpeechRegion[] = [];
  let runStart = -1;
  for (let i = 0; i <= speechFrames.length; i++) {
    const isSpeech = i < speechFrames.length && speechFrames[i];
    if (isSpeech && runStart < 0) runStart = i;
    if (!isSpeech && runStart >= 0) {
      raw.push({ start: runStart * frameSeconds, end: i * frameSeconds });
      runStart = -1;
    }
  }

  const merged: SpeechRegion[] = [];
  for (const r of raw) {
    const padded = {
      start: Math.max(0, r.start - o.padSeconds),
      end: Math.min(totalSeconds, r.end + o.padSeconds),
    };
    const last = merged[merged.length - 1];
    if (last && padded.start - last.end <= o.mergeGapSeconds) {
      last.end = Math.max(last.end, padded.end);
    } else {
      merged.push(padded);
    }
  }

  return merged.filter((r) => r.end - r.start >= o.minRegionSeconds);
}

/**
 * Energy VAD over a 16 kHz mono s16le PCM file, streamed so memory stays flat
 * even for multi-hour tracks.
 */
export async function detectSpeechRegions(pcmPath: string, opts: VadOptions = {}): Promise<SpeechRegion[]> {
  const o = { ...DEFAULT_VAD, ...opts };
  const frameBytes = Math.round((VAD_SAMPLE_RATE * o.frameMs) / 1000) * BYTES_PER_SAMPLE;
  const threshold = 32768 * Math.pow(10, o.thresholdDbfs / 20);
  const thresholdSq = threshold * threshold;
  const speechFrames: boolean[] = [];

  let leftover: Buffer = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(pcmPath, { highWaterMark: frameBytes * 512 });
    stream.on('data', (chunk) => {
      const buf = leftover.length ? Buffer.concat([leftover, chunk as Buffer]) : (chunk as Buffer);
      let offset = 0;
      while (offset + frameBytes <= buf.length) {
        let sumSq = 0;
        for (let i = offset; i < offset + frameBytes; i += 2) {
          const s = buf.readInt16LE(i);
          sumSq += s * s;
        }
        speechFrames.push(sumSq / (frameBytes / 2) >= thresholdSq);
        offset += frameBytes;
      }
      leftover = buf.subarray(offset);
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  const total = pcm16kDuration(pcmPath);
  return regionsFromFrames(speechFrames, o.frameMs / 1000, total, o);
}

/**
 * Pack speech regions into chunks no longer than `maxChunkSeconds`, separated
 * by `gapSeconds` of silence inside the chunk (helps Whisper split sentences).
 * A single region longer than the limit is split into several pieces.
 */
export function buildChunks(regions: SpeechRegion[], maxChunkSeconds: number, gapSeconds = 0.5): AudioChunk[] {
  const chunks: AudioChunk[] = [];
  let current: AudioChunk = { pieces: [], duration: 0 };

  const flush = () => {
    if (current.pieces.length) chunks.push(current);
    current = { pieces: [], duration: 0 };
  };

  for (const region of regions) {
    let start = region.start;
    while (start < region.end) {
      const gap = current.pieces.length ? gapSeconds : 0;
      const room = maxChunkSeconds - current.duration - gap;
      if (room <= 1) {
        flush();
        continue;
      }
      const end = Math.min(region.end, start + room);
      const chunkStart = current.duration + gap;
      current.pieces.push({ chunkStart, start, end });
      current.duration = chunkStart + (end - start);
      start = end;
      if (current.duration >= maxChunkSeconds - 1) flush();
    }
  }
  flush();
  return chunks;
}

/**
 * Map a timestamp inside an encoded chunk back to original track time.
 * Times that fall in the artificial gap between two pieces snap to the next
 * piece's start (for segment starts) or the previous piece's end (for segment
 * ends), so an utterance is never placed in the silence that was cut out.
 */
export function mapChunkTime(chunk: AudioChunk, t: number, bias: 'start' | 'end' = 'start'): number {
  const pieces = chunk.pieces;
  if (pieces.length === 0) return t;
  let idx = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].chunkStart <= t) idx = i;
    else break;
  }
  const piece = pieces[idx];
  const within = Math.max(0, t - piece.chunkStart);
  const pieceLen = piece.end - piece.start;
  if (within > pieceLen && bias === 'start' && idx + 1 < pieces.length) {
    return pieces[idx + 1].start; // inside the gap after this piece
  }
  return Math.min(piece.end, piece.start + within);
}

/**
 * Write one chunk as a compact Ogg/Opus file (mono, 16 kHz, 32 kbps), reading
 * only the needed byte ranges from the 16 kHz PCM source.
 */
export async function encodeChunk(pcmPath: string, chunk: AudioChunk, outPath: string, gapSeconds = 0.5): Promise<void> {
  const parts: Buffer[] = [];
  const fd = fs.openSync(pcmPath, 'r');
  try {
    chunk.pieces.forEach((piece, i) => {
      if (i > 0) parts.push(Buffer.alloc(Math.round(gapSeconds * VAD_SAMPLE_RATE) * BYTES_PER_SAMPLE));
      const startByte = Math.floor(piece.start * VAD_SAMPLE_RATE) * BYTES_PER_SAMPLE;
      const endByte = Math.floor(piece.end * VAD_SAMPLE_RATE) * BYTES_PER_SAMPLE;
      const len = Math.max(0, endByte - startByte);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, startByte);
      parts.push(buf.subarray(0, read));
    });
  } finally {
    fs.closeSync(fd);
  }

  await runFfmpeg([
    '-f', 's16le', '-ar', String(VAD_SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', outPath,
  ], Buffer.concat(parts));
}

/** Duration of any media file in seconds, via ffprobe (0 if unknown). */
export function probeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}
