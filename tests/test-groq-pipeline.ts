#!/usr/bin/env npx tsx
/**
 * test-groq-pipeline.ts — Unit tests for the Whisper/Groq path: silence
 * removal (VAD), chunk packing, chunk→track time mapping, hallucination
 * filtering and the rate limiter. Plain tsx script, like the other tests.
 *
 * The VAD + encode cases need ffmpeg on PATH (the Docker image has it).
 *
 * Run:  npx tsx tests/test-groq-pipeline.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  buildChunks,
  detectSpeechRegions,
  discordPcmTo16kMono,
  encodeChunk,
  mapChunkTime,
  regionsFromFrames,
} from '../src/services/audio-utils';
import { GroqRateLimiter } from '../src/services/groq-rate-limiter';
import { isLikelyHallucination } from '../src/services/groq-transcription-service';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
const near = (a: number, b: number, tol = 0.15) => Math.abs(a - b) <= tol;

async function main() {
  // ─── regionsFromFrames: padding, merging and dropping noise ───────────
  {
    const f = 0.1; // 100 ms frames
    // speech 1.0–2.0s, short gap (0.5s), speech 2.5–3.0s, long gap, blip 8.0–8.1s, speech 10–11s
    const frames = Array.from({ length: 120 }, (_, i) => {
      const t = i * f;
      return (t >= 1 && t < 2) || (t >= 2.5 && t < 3) || (t >= 8 && t < 8.1) || (t >= 10 && t < 11);
    });
    const regions = regionsFromFrames(frames, f, 12, { padSeconds: 0.2, mergeGapSeconds: 1, minRegionSeconds: 0.6 });
    assert(regions.length === 2, `expected 2 regions (merged + last; blip dropped), got ${JSON.stringify(regions)}`);
    assert(near(regions[0].start, 0.8) && near(regions[0].end, 3.2), `first region padded+merged: ${JSON.stringify(regions[0])}`);
    assert(near(regions[1].start, 9.8) && near(regions[1].end, 11.2), `second region padded: ${JSON.stringify(regions[1])}`);
    console.log('✅ regionsFromFrames pads, merges short gaps and drops blips');
  }

  // ─── buildChunks + mapChunkTime: silence removed, timestamps restored ─
  {
    const regions = [
      { start: 10, end: 20 },
      { start: 100, end: 130 },
      { start: 500, end: 520 },
    ];
    const chunks = buildChunks(regions, 45, 0.5);
    const total = chunks.reduce((s, c) => s + c.pieces.reduce((p, x) => p + (x.end - x.start), 0), 0);
    assert(near(total, 60, 0.01), `all 60s of speech kept, got ${total}`);
    assert(chunks.every((c) => c.duration <= 45 + 1e-9), 'no chunk exceeds the max');
    assert(chunks.length === 2, `expected 2 chunks, got ${chunks.length}`);
    // In chunk 0: piece A [0,10] -> 10..20, gap 0.5, piece B starts at 10.5 -> 100.
    assert(near(mapChunkTime(chunks[0], 5), 15, 0.001), 'time in first piece maps back');
    assert(near(mapChunkTime(chunks[0], 12), 101.5, 0.001), 'time in second piece maps back');
    assert(near(mapChunkTime(chunks[0], 10.2, 'start'), 100, 0.001), 'a start inside the gap snaps to the next piece');
    assert(near(mapChunkTime(chunks[0], 10.2, 'end'), 20, 0.001), 'an end inside the gap snaps to the previous piece');
    console.log('✅ buildChunks drops silence and mapChunkTime restores original timestamps');
  }

  // ─── A region longer than the chunk limit is split ────────────────────
  {
    const chunks = buildChunks([{ start: 0, end: 1500 }], 600, 0.5);
    assert(chunks.length === 3, `1500s region -> 3 chunks of <=600s, got ${chunks.length}`);
    assert(near(mapChunkTime(chunks[1], 0), 600, 0.001), 'second chunk starts at 600s of the track');
    console.log('✅ long speech regions are split across chunks');
  }

  // ─── Hallucination filter ─────────────────────────────────────────────
  {
    assert(isLikelyHallucination({ text: 'Legendas pela comunidade Amara.org' }), 'Amara credit is dropped');
    assert(isLikelyHallucination({ text: 'Obrigado por assistir!' }), 'outro is dropped');
    assert(isLikelyHallucination({ text: 'ok', no_speech_prob: 0.9, avg_logprob: -1.5 }), 'low-confidence silence is dropped');
    assert(!isLikelyHallucination({ text: 'Fechado, a Alessandra cuida do Instagram.', no_speech_prob: 0.05, avg_logprob: -0.2 }), 'real speech is kept');
    // From the first real test: Whisper drifted into Icelandic on noisy audio.
    assert(isLikelyHallucination({ text: 'Þau komið til þetta sjálf að verið við líka.', avg_logprob: -0.6 }, 'pt'), 'Icelandic letters dropped when language=pt');
    assert(isLikelyHallucination({ text: 'Pertí, hún er að vera það.', avg_logprob: -0.7 }, 'pt'), 'ð/þ dropped when language=pt');
    assert(!isLikelyHallucination({ text: 'Ação, coração, pão e informação já estão prontas.', avg_logprob: -0.3 }, 'pt'), 'Portuguese accents kept');
    assert(!isLikelyHallucination({ text: 'Þau komið til', avg_logprob: -0.3 }, ''), 'script filter only applies with a forced language');
    assert(isLikelyHallucination({ text: 'algo', avg_logprob: -1.5 }), 'very low confidence dropped');
    // From the fifth real test: Whisper read its own prompt back on a noisy track.
    const { echoesPrompt, hasWordLoop } = await import('../src/services/groq-transcription-service');
    const prompt = 'Davi Peterson, ronaldyop65, th1. Reunião da SyncForge sobre SIGEM, Operis, NestJS, Next.js e Prisma.';
    assert(echoesPrompt('Dami Pesce, ronaldyop65, Th1. Réunião da SyncForge sobre SIGEM, Operis, NestJS.', prompt), 'prompt echo dropped');
    assert(!echoesPrompt('Bora revisar a tela de login do SIGEM amanhã cedo com o William.', prompt), 'real speech mentioning one glossary word kept');
    assert(!echoesPrompt('qualquer coisa dita', ''), 'no prompt, no echo check');
    assert(hasWordLoop('NestJS, NestJS, NestJS, NestJS.'), 'word loop dropped');
    assert(!hasWordLoop('Teste, teste, teste, ok.'), 'three repeats is still plausible speech');
    console.log('✅ hallucination filter keeps real speech and drops known artifacts');
  }

  // ─── In-person links: share links become direct downloads ─────────────
  {
    const { directDownloadUrl } = await import('../src/services/in-person-service');
    assert(
      directDownloadUrl('https://drive.google.com/file/d/ABC123/view?usp=sharing') === 'https://drive.google.com/uc?export=download&id=ABC123',
      'Google Drive share link -> uc?export=download',
    );
    assert(directDownloadUrl('https://www.dropbox.com/s/xyz/reuniao.m4a?dl=0') === 'https://www.dropbox.com/s/xyz/reuniao.m4a?dl=1', 'Dropbox dl=1');
    assert(directDownloadUrl('https://example.com/a.mp3') === 'https://example.com/a.mp3', 'other links untouched');
    const { isAllowedDownloadUrl } = await import('../src/services/in-person-service');
    assert(isAllowedDownloadUrl('https://cdn.discordapp.com/attachments/1/2/a.m4a'), 'Discord CDN allowed');
    for (const bad of ['http://example.com/a.mp3', 'https://localhost/a', 'https://relay:8787/health', 'https://192.168.0.10/a', 'https://10.0.0.1/a', 'https://[::1]/a', 'file:///etc/passwd']) {
      assert(!isAllowedDownloadUrl(bad), `blocked: ${bad}`);
    }
    console.log('✅ share links are converted to direct downloads; private/non-https links are blocked');
  }

  // ─── Rate limiter (fake clock) ────────────────────────────────────────
  {
    let now = 0;
    const limiter = new GroqRateLimiter(
      { audioSecondsPerHour: 100, audioSecondsPerDay: 1000, requestsPerMinute: 3 },
      () => now,
      async (ms) => { now += ms; },
    );
    await limiter.acquire(60);
    assert(limiter.waitTimeMs(30) === 0, '60+30 fits in 100/hour');
    await limiter.acquire(30);
    assert(limiter.waitTimeMs(30) > 0, '90+30 exceeds 100/hour and must wait');
    assert(GroqRateLimiter.billed(2) === 10, 'tiny requests are billed as 10s');
    const before = now;
    await limiter.acquire(30); // must sleep until the first 60s entry leaves the hour window
    assert(now - before >= 3_600_000 - 1, `waited about an hour (waited ${now - before}ms)`);

    // requests per minute
    now = 10 * 86_400_000;
    const rpm = new GroqRateLimiter({ audioSecondsPerHour: 1e9, audioSecondsPerDay: 1e9, requestsPerMinute: 2 }, () => now, async (ms) => { now += ms; });
    await rpm.acquire(10);
    await rpm.acquire(10);
    const t0 = now;
    await rpm.acquire(10);
    assert(now - t0 >= 60_000 - 1, 'third request in a minute waits for the window');
    console.log('✅ rate limiter paces audio-seconds and requests per minute');
  }

  // ─── End to end with ffmpeg: Discord PCM -> 16k -> VAD -> ogg chunk ───
  {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch {
      console.log('⚠️  ffmpeg not found; skipping end-to-end audio case');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-test-'));
    try {
      // 12s of 48 kHz stereo s16le: tone at 2–4s and 8–9s, silence elsewhere.
      const sr = 48000;
      const total = 12 * sr;
      const buf = Buffer.alloc(total * 4);
      for (let i = 0; i < total; i++) {
        const t = i / sr;
        const on = (t >= 2 && t < 4) || (t >= 8 && t < 9);
        const v = on ? Math.round(8000 * Math.sin(2 * Math.PI * 220 * t)) : 0;
        buf.writeInt16LE(v, i * 4);
        buf.writeInt16LE(v, i * 4 + 2);
      }
      const raw = path.join(dir, 'user.pcm');
      fs.writeFileSync(raw, buf);
      const pcm16k = path.join(dir, 'user.16k.pcm');
      await discordPcmTo16kMono(raw, pcm16k);
      const regions = await detectSpeechRegions(pcm16k);
      assert(regions.length === 2, `VAD finds 2 regions, got ${JSON.stringify(regions)}`);
      assert(near(regions[0].start, 1.7, 0.2) && near(regions[0].end, 4.3, 0.2), `region 1 ~2–4s: ${JSON.stringify(regions[0])}`);
      const speech = regions.reduce((s, r) => s + r.end - r.start, 0);
      assert(speech < 5, `only ~4s of 12s is sent (got ${speech.toFixed(2)}s)`);
      const [chunk] = buildChunks(regions, 600);
      const ogg = path.join(dir, 'chunk.ogg');
      await encodeChunk(pcm16k, chunk, ogg);
      assert(fs.statSync(ogg).size > 500, 'ogg chunk written');
      console.log(`✅ ffmpeg pipeline: 12s track -> ${speech.toFixed(1)}s of speech, ${fs.statSync(ogg).size} byte ogg chunk`);

      // ─── Two Discord tracks through GroqTranscriptionService (mocked API) ─
      // Davi's track starts at session start (tone 2–4s, 8–9s). Alessandra's
      // track starts 3s later and has a tone at 1–2s of her track (=4–5s).
      const alessandraBuf = Buffer.alloc(6 * sr * 4);
      for (let i = 0; i < 6 * sr; i++) {
        const t = i / sr;
        const v = t >= 1 && t < 2 ? Math.round(8000 * Math.sin(2 * Math.PI * 330 * t)) : 0;
        alessandraBuf.writeInt16LE(v, i * 4);
        alessandraBuf.writeInt16LE(v, i * 4 + 2);
      }
      const rawA = path.join(dir, 'alessandra.pcm');
      fs.writeFileSync(rawA, alessandraBuf);

      const sent: number[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: any, init: any) => {
        const form = init.body as FormData;
        assert(form.get('language') === 'pt', 'language=pt is sent');
        assert(form.get('response_format') === 'verbose_json', 'verbose_json requested');
        sent.push(1);
        // Whisper reports one segment at the very start of the chunk.
        return new Response(JSON.stringify({ segments: [{ start: 0.35, end: 1.2, text: `fala ${sent.length}`, no_speech_prob: 0.01, avg_logprob: -0.2 }] }), { status: 200 });
      }) as any;
      try {
        const { GroqTranscriptionService } = await import('../src/services/groq-transcription-service');
        const limiter = new GroqRateLimiter({ audioSecondsPerHour: 1e6, audioSecondsPerDay: 1e6, requestsPerMinute: 1e6 });
        const svc = new GroqTranscriptionService('test-key', 'whisper-large-v3-turbo', 'pt', limiter);
        const t0 = 1_000_000;
        const result = await svc.transcribeUserTracks([
          { filePath: raw, userId: 'u1', speakerName: 'Davi', startedAt: t0 },
          { filePath: rawA, userId: 'u2', speakerName: 'Alessandra', startedAt: t0 + 3000 },
        ], t0);
        assert(sent.length === 2, `one request per track (speech fits one chunk), got ${sent.length}`);
        const [first, second] = result.segments;
        assert(first.speaker === 'Davi' && near(first.start, 2.05, 0.3), `Davi's first words ~2s: ${JSON.stringify(first)}`);
        assert(second.speaker === 'Alessandra' && near(second.start, 4.05, 0.3), `Alessandra ~4s (3s offset + 1s): ${JSON.stringify(second)}`);
        assert(result.text.includes('[Davi]:') && result.text.includes('[Alessandra]:'), 'speaker names in transcript text');
        assert(!fs.readdirSync(dir).some((f) => f.endsWith('.ogg') && f.includes('chunk0')), 'temporary chunks cleaned up');
        console.log('✅ per-user tracks keep speaker names and session-relative timestamps');
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().then(() => console.log('\nAll Groq pipeline tests passed.')).catch((err) => {
  console.error(err);
  process.exit(1);
});
