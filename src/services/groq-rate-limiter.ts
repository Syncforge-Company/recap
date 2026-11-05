/**
 * Client-side pacing for Groq's free-tier Whisper limits.
 *
 * Groq meters audio transcription by audio-seconds per hour and per day, plus
 * requests per minute (see console.groq.com/settings/limits for your account).
 * Rather than firing requests and eating 429s, every transcription request
 * reserves its audio duration here first and waits until it fits inside all
 * rolling windows. One limiter is shared by the whole process, so concurrent
 * meetings (or an in-person upload during a call) queue instead of colliding.
 *
 * Groq bills each request for at least 10 seconds of audio, so tiny chunks are
 * counted as 10s.
 */

export interface RateLimits {
  audioSecondsPerHour: number;
  audioSecondsPerDay: number;
  requestsPerMinute: number;
}

interface Entry {
  at: number;
  seconds: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINUTE = 60_000;
export const MIN_BILLED_SECONDS = 10;

export class GroqRateLimiter {
  private entries: Entry[] = [];
  private blockedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limits: RateLimits,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Billed seconds for a request carrying `audioSeconds` of audio. */
  static billed(audioSeconds: number): number {
    return Math.max(MIN_BILLED_SECONDS, Math.ceil(audioSeconds));
  }

  /**
   * How long (ms) a request of `audioSeconds` must wait before it fits, given
   * the current history. 0 means it can go now. Pure w.r.t. state — used by
   * acquire() and by tests.
   */
  waitTimeMs(audioSeconds: number): number {
    const t = this.now();
    const cost = GroqRateLimiter.billed(audioSeconds);
    let wait = Math.max(0, this.blockedUntil - t);

    const check = (windowMs: number, cap: number, weight: (e: Entry) => number, need: number) => {
      if (need > cap) return; // can never fit; let the API decide rather than wait forever
      const inWindow = this.entries.filter((e) => e.at > t - windowMs);
      let used = inWindow.reduce((sum, e) => sum + weight(e), 0);
      if (used + need <= cap) return;
      // Oldest entries expire first; find when enough has rolled off.
      for (const e of inWindow) {
        used -= weight(e);
        if (used + need <= cap) {
          wait = Math.max(wait, e.at + windowMs - t + 1);
          return;
        }
      }
    };

    check(HOUR, this.limits.audioSecondsPerHour, (e) => e.seconds, cost);
    check(DAY, this.limits.audioSecondsPerDay, (e) => e.seconds, cost);
    check(MINUTE, this.limits.requestsPerMinute, () => 1, 1);
    return wait;
  }

  /**
   * Wait until a request of `audioSeconds` fits in every window, then record
   * it. Calls are serialized so two callers can't both see the same headroom.
   */
  acquire(audioSeconds: number, onWait?: (ms: number) => void): Promise<void> {
    const run = async () => {
      for (;;) {
        const wait = this.waitTimeMs(audioSeconds);
        if (wait <= 0) break;
        onWait?.(wait);
        await this.sleep(Math.min(wait, 5 * MINUTE));
      }
      const t = this.now();
      this.entries.push({ at: t, seconds: GroqRateLimiter.billed(audioSeconds) });
      this.entries = this.entries.filter((e) => e.at > t - DAY);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Honor a server-side Retry-After (e.g. after an unexpected 429). */
  blockFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }
}
