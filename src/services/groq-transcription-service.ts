import fs from 'fs';
import path from 'path';
import { Config } from '../config';
import type { Segment, TranscriptResult, Transcriber, UserTrackInput } from './transcription-service';
import {
  AudioChunk,
  anyAudioTo16kMono,
  buildChunks,
  detectSpeechRegions,
  discordPcmTo16kMono,
  encodeChunk,
  mapChunkTime,
} from './audio-utils';
import { GroqRateLimiter } from './groq-rate-limiter';
import { sortSegments, toPlainText, toSRT } from './transcript-format';

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const CHUNK_GAP_SECONDS = 0.5;

/** One limiter for the whole process so concurrent jobs queue instead of colliding. */
let sharedLimiter: GroqRateLimiter | null = null;
export function getGroqLimiter(): GroqRateLimiter {
  if (!sharedLimiter) {
    sharedLimiter = new GroqRateLimiter({
      audioSecondsPerHour: Config.GROQ_AUDIO_SECONDS_PER_HOUR,
      audioSecondsPerDay: Config.GROQ_AUDIO_SECONDS_PER_DAY,
      requestsPerMinute: Config.GROQ_REQUESTS_PER_MINUTE,
    });
  }
  return sharedLimiter;
}

/**
 * Phrases Whisper is known to "hallucinate" on near-silent audio (subtitle
 * credits and video outros from its training data). Matched against whole
 * segments only, case-insensitively.
 */
const HALLUCINATIONS = [
  /^legendas? (pela|por|da) comunidade amara\.org\.?$/i,
  /^(obrigad[oa]|valeu) (por|pela) (assistir|atenção)[.!]*$/i,
  /^inscreva-se no canal[.!]*$/i,
  /^tchau[.!]*$/i,
  /^subtitles by the amara\.org community\.?$/i,
  /^thanks? (you )?for watching[.!]*$/i,
  /^\.+$/,
];

/**
 * Letters that never appear in Portuguese (Icelandic/Nordic/German/Polish
 * letters, Cyrillic, Greek, Arabic/Hebrew, CJK, Hangul). When Whisper is
 * forced to Portuguese and still emits these, it is decoding noise.
 */
const NON_PT_LETTERS = /[þðæøåßłœ\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/i;

export function isLikelyHallucination(
  seg: { text: string; no_speech_prob?: number; avg_logprob?: number; compression_ratio?: number },
  language = '',
): boolean {
  const text = (seg.text || '').trim();
  if (!text) return true;
  if (HALLUCINATIONS.some((re) => re.test(text))) return true;
  if (language === 'pt' && NON_PT_LETTERS.test(text)) return true;
  if ((seg.avg_logprob ?? 0) < -1.2) return true; // very low confidence: usually garbage
  if ((seg.no_speech_prob ?? 0) > 0.6 && (seg.avg_logprob ?? 0) < -1) return true;
  if ((seg.compression_ratio ?? 0) > 2.6) return true; // repetitive loops ("e aí e aí e aí ...")
  return false;
}

/**
 * Whisper (via Groq) transcription.
 *
 * Discord gives us one track per speaker, so speaker labels come from Discord
 * and no diarization is needed. Each track has its silence removed by a VAD
 * before upload (Discord pads tracks with silence to keep them aligned), which
 * keeps a 1-hour, 4-person call near 1 hour of billed audio instead of 4.
 */
export class GroqTranscriptionService implements Transcriber {
  readonly providerName = 'Whisper (Groq)';

  constructor(
    private readonly apiKey: string,
    private readonly model = Config.GROQ_WHISPER_MODEL,
    private readonly language = Config.TRANSCRIPTION_LANGUAGE,
    private readonly limiter: GroqRateLimiter = getGroqLimiter(),
  ) {}

  async transcribeUserTracks(tracks: UserTrackInput[], sessionStartedAt: number): Promise<TranscriptResult> {
    const valid = tracks.filter((t) => fs.existsSync(t.filePath) && fs.statSync(t.filePath).size >= 1000);
    if (valid.length === 0) {
      console.log('[Groq] No usable per-user audio files, skipping');
      return { srt: '', text: 'No audio captured.', segments: [] };
    }

    const names = valid.map((t) => t.speakerName);
    const segments: Segment[] = [];
    for (const track of valid) {
      const offset = Math.max(0, (track.startedAt - sessionStartedAt) / 1000);
      const pcm16k = `${track.filePath}.16k.pcm`;
      try {
        await discordPcmTo16kMono(track.filePath, pcm16k);
        segments.push(...await this.transcribePcm16k(pcm16k, track.speakerName, offset, names));
      } finally {
        fs.rmSync(pcm16k, { force: true });
      }
    }

    sortSegments(segments);
    console.log(`[Groq] Got ${segments.length} segment(s) across ${valid.length} track(s)`);
    return { srt: toSRT(segments), text: toPlainText(segments), segments };
  }

  async transcribeFile(filePath: string, speakerName: string): Promise<TranscriptResult> {
    const pcm16k = `${filePath}.16k.pcm`;
    try {
      await anyAudioTo16kMono(filePath, pcm16k);
      const segments = sortSegments(await this.transcribePcm16k(pcm16k, speakerName, 0, []));
      return { srt: toSRT(segments), text: toPlainText(segments), segments };
    } finally {
      fs.rmSync(pcm16k, { force: true });
    }
  }

  private async transcribePcm16k(pcm16k: string, speakerName: string, offsetSeconds: number, names: string[]): Promise<Segment[]> {
    const regions = await detectSpeechRegions(pcm16k, { thresholdDbfs: Config.VAD_THRESHOLD_DBFS });
    const speech = regions.reduce((s, r) => s + (r.end - r.start), 0);
    const chunks = buildChunks(regions, Config.TRANSCRIPTION_CHUNK_SECONDS, CHUNK_GAP_SECONDS);
    console.log(
      `[Groq] model=${this.model} language=${this.language || 'auto'} | ` +
      `${path.basename(pcm16k)} (${speakerName}): ${regions.length} speech region(s), ` +
      `${speech.toFixed(0)}s of speech in ${chunks.length} chunk(s)`,
    );

    const out: Segment[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const oggPath = `${pcm16k}.chunk${i}.ogg`;
      try {
        await encodeChunk(pcm16k, chunk, oggPath, CHUNK_GAP_SECONDS);
        const result = await this.requestWithRetry(oggPath, chunk.duration, names);
        out.push(...this.toSegments(result, chunk, speakerName, offsetSeconds));
      } finally {
        fs.rmSync(oggPath, { force: true });
      }
    }
    return out;
  }

  private toSegments(result: any, chunk: AudioChunk, speakerName: string, offsetSeconds: number): Segment[] {
    const raw: any[] = Array.isArray(result?.segments) ? result.segments : [];
    if (raw.length === 0 && typeof result?.text === 'string' && result.text.trim()) {
      const start = chunk.pieces[0]?.start ?? 0;
      return [{ speaker: speakerName, start: start + offsetSeconds, end: start + chunk.duration + offsetSeconds, text: result.text.trim() }];
    }
    const kept = raw.filter((s) => !isLikelyHallucination(s, this.language));
    if (kept.length < raw.length) {
      console.log(`[Groq] Dropped ${raw.length - kept.length}/${raw.length} low-confidence or wrong-language segment(s) for ${speakerName}`);
    }
    return kept
      .map((s) => ({
        speaker: speakerName,
        start: mapChunkTime(chunk, s.start ?? 0, 'start') + offsetSeconds,
        end: mapChunkTime(chunk, s.end ?? s.start ?? 0, 'end') + offsetSeconds,
        text: String(s.text).trim(),
      }));
  }

  /** Speaker names + context help Whisper spell names and jargon correctly. */
  private whisperPrompt(names: string[]): string {
    const extra = process.env.GROQ_WHISPER_PROMPT || '';
    return [names.length ? `Participantes: ${names.join(', ')}.` : '', extra].filter(Boolean).join(' ').slice(0, 800);
  }

  private async requestWithRetry(filePath: string, audioSeconds: number, names: string[]): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await this.limiter.acquire(audioSeconds, (ms) =>
        console.log(`[Groq] Rate limit reached; waiting ${Math.ceil(ms / 1000)}s before sending more audio`),
      );
      try {
        return await this.request(filePath, names);
      } catch (err: any) {
        lastErr = err;
        if (err?.retryAfterMs) {
          this.limiter.blockFor(err.retryAfterMs);
          console.warn(`[Groq] 429 from API; backing off ${Math.ceil(err.retryAfterMs / 1000)}s (attempt ${attempt}/5)`);
          continue;
        }
        if (err?.status && err.status < 500) throw err; // bad key, bad file: retrying won't help
        console.warn(`[Groq] Request failed (attempt ${attempt}/5):`, err?.message || err);
        await new Promise((r) => setTimeout(r, attempt * 5_000));
      }
    }
    throw lastErr;
  }

  private async request(filePath: string, names: string[]): Promise<any> {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'audio/ogg' }), path.basename(filePath));
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (this.language) form.append('language', this.language);
    const prompt = this.whisperPrompt(names);
    if (prompt) form.append('prompt', prompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      const res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (res.ok) return res.json();

      const body = await res.text();
      const err: any = new Error(`Groq API error ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') || '');
        err.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
