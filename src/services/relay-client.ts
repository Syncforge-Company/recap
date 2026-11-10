import { Config } from '../config';

/**
 * Client for the optional "relay" HTTP service at Config.RELAY_URL. The relay
 * bridges to an LLM provider (for summaries) and an email gateway, so this bot
 * needs no third-party LLM/email API keys directly. If RELAY_TOKEN is unset the
 * bot still records and transcribes; summaries + email are simply skipped.
 *
 * Expected relay API (you provide the implementation):
 *   POST /summarize { system, prompt, model?, maxTokens } -> { text, truncated? }
 *   POST /email     { to, subject, body }                 -> 200 OK
 * Both authenticated with the `X-Relay-Token` header.
 */
export class RelayClient {
  static isConfigured(): boolean {
    return !!Config.RELAY_TOKEN && !!Config.RELAY_URL;
  }

  private static async post(path: string, body: any, timeoutMs: number): Promise<any> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${Config.RELAY_URL}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Relay-Token': Config.RELAY_TOKEN,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(`relay ${path} ${res.status}: ${data?.error || 'unknown error'}`);
        }
        return data;
      } catch (err) {
        lastError = err;
        if (attempt === 3) break;
        console.warn(`[RelayClient] ${path} attempt ${attempt}/3 failed; retrying:`, err);
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /**
   * Generate a summary via the LLM Gateway. Returns the Markdown text plus
   * whether the model hit the hard `maxTokens` cap (output cut off).
   * `maxTokens` is the hard API cap; callers that state a soft length target
   * in the prompt should pass headroom above that target so the cap never
   * truncates output mid-sentence. Relays that don't report `truncated` are
   * treated as not truncated.
   */
  static async summarize(
    system: string,
    prompt: string,
    maxTokens = 2500
  ): Promise<{ text: string; truncated: boolean }> {
    const data = await this.post('/summarize', {
      system,
      prompt,
      model: Config.SUMMARY_MODEL || undefined,
      maxTokens,
    }, 120_000);
    return { text: (data.text || '').trim(), truncated: data.truncated === true };
  }

  /** Send a plain-text email via the relay's email gateway. */
  static async email(to: string, subject: string, body: string, html?: string): Promise<void> {
    await this.post('/email', { to, subject, body, ...(html ? { html } : {}) }, 30_000);
  }
}
