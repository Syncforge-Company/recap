import { Config } from '../config';
import { StorageService } from './storage-service';
import { getSchedules } from './schedule-store';
import { invalidScheduleReason } from './scheduler';

export interface HealthResult {
  ok: boolean;
  detail: string;
}

/** Validate the Groq API key with a cheap, billing-free model listing. */
export async function checkGroq(): Promise<HealthResult> {
  const key = Config.GROQ_API_KEY;
  if (!key) return { ok: false, detail: 'GROQ_API_KEY is not set' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return { ok: true, detail: `Groq key valid (HTTP ${res.status})` };
    if (res.status === 401) return { ok: false, detail: 'Groq returned 401 — the API key is invalid or revoked' };
    return { ok: false, detail: `Groq returned unexpected HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, detail: `Could not reach Groq: ${err?.message || err}` };
  }
}

/** Check whichever transcription provider is configured. */
export function checkTranscription(): Promise<HealthResult> {
  return Config.TRANSCRIPTION_PROVIDER === 'groq' ? checkGroq() : checkDeepgram();
}

/**
 * Validate the Deepgram API key against Deepgram's REST API.
 * Hitting /v1/projects is a cheap, billing-free auth probe: a 200 means the
 * key is live, a 401 means it's been revoked/expired (the exact failure that
 * silently broke the June 8 call). Network/transient errors are reported but
 * not treated as a hard auth failure.
 */
export async function checkDeepgram(): Promise<HealthResult> {
  const key = Config.DEEPGRAM_API_KEY;
  if (!key) return { ok: false, detail: 'DEEPGRAM_API_KEY is not set' };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) return { ok: true, detail: `Deepgram key valid (HTTP ${res.status})` };
    if (res.status === 401) {
      return { ok: false, detail: 'Deepgram returned 401 INVALID_AUTH — the API key is revoked, expired, or the account is suspended' };
    }
    return { ok: false, detail: `Deepgram returned unexpected HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, detail: `Could not reach Deepgram: ${err?.message || err}` };
  }
}

/**
 * Validate the optional relay service (reached at Config.RELAY_URL).
 * Hitting its unauthenticated /health endpoint confirms both that the relay
 * process is up AND that the tunnel is connected — if the tunnel drops, AI
 * summaries and email degrade silently while Discord transcripts still post.
 * Skipped (treated as OK) when the relay isn't configured at all.
 */
export async function checkR2(): Promise<HealthResult> {
  if (!StorageService.isConfigured()) {
    return { ok: true, detail: 'R2 not configured — cloud archival disabled (skipped)' };
  }
  try {
    const storage = new StorageService();
    await storage.probe();
    return { ok: true, detail: `R2 bucket reachable: ${Config.R2_BUCKET}` };
  } catch (err: any) {
    return { ok: false, detail: `Could not reach R2 bucket ${Config.R2_BUCKET}: ${err?.message || err}` };
  }
}

export function checkSchedules(): HealthResult {
  const problems = getSchedules()
    .map((schedule) => {
      const reason = invalidScheduleReason(schedule);
      return reason && reason !== 'paused' ? `**${schedule.name}** \`${schedule.id}\`: ${reason}` : '';
    })
    .filter(Boolean);

  if (problems.length === 0) return { ok: true, detail: 'All active schedules have required config' };
  return { ok: false, detail: problems.join('; ') };
}

export async function checkRelay(): Promise<HealthResult> {
  if (!Config.RELAY_TOKEN || !Config.RELAY_URL) {
    return { ok: true, detail: 'Relay not configured — AI summary/email disabled (skipped)' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(`${Config.RELAY_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return { ok: true, detail: `Relay reachable at ${Config.RELAY_URL} (HTTP ${res.status})` };
    return { ok: false, detail: `Relay returned HTTP ${res.status} at ${Config.RELAY_URL}` };
  } catch (err: any) {
    return { ok: false, detail: `Could not reach relay at ${Config.RELAY_URL} (reverse SSH tunnel likely down): ${err?.message || err}` };
  }
}

/**
 * Run all startup health checks. Logs results loudly and DMs the alert user
 * if anything is wrong, so failures surface immediately on boot rather than
 * silently failing mid-call.
 *
 * Deepgram is CRITICAL (no transcription without it). Relay/R2 are DEGRADED.
 * Schedule config warnings are reported too, so an active schedule missing its
 * text channel is visible at startup instead of only at cron fire time.
 */
export async function runStartupHealthChecks(client: any): Promise<void> {
  const [dg, relay, r2] = await Promise.all([checkTranscription(), checkRelay(), checkR2()]);
  const schedules = checkSchedules();

  if (dg.ok) console.log(`[HealthCheck] ✅ ${dg.detail}`);
  else {
    console.error('========================================================');
    console.error(`[HealthCheck] ❌ TRANSCRIPTION (${Config.TRANSCRIPTION_PROVIDER}) CHECK FAILED: ${dg.detail}`);
    console.error('[HealthCheck] Transcription WILL NOT WORK until this is fixed.');
    console.error('========================================================');
  }

  if (relay.ok) console.log(`[HealthCheck] ✅ ${relay.detail}`);
  else console.error(`[HealthCheck] ⚠️  RELAY CHECK FAILED: ${relay.detail}`);

  if (r2.ok) console.log(`[HealthCheck] ✅ ${r2.detail}`);
  else console.error(`[HealthCheck] ⚠️  R2 CHECK FAILED: ${r2.detail}`);

  if (schedules.ok) console.log(`[HealthCheck] ✅ Schedules: ${schedules.detail}`);
  else console.error(`[HealthCheck] ⚠️  SCHEDULE CHECK FAILED: ${schedules.detail}`);

  if (dg.ok && relay.ok && r2.ok && schedules.ok) return;

  const userId = Config.ALERT_DISCORD_USER_ID;
  if (!userId) return;

  const lines: string[] = [`🚨 **${Config.BOT_NAME} startup health check failed**\n`];
  if (!dg.ok) {
    lines.push(
      `**❌ Transcription (${Config.TRANSCRIPTION_PROVIDER}, critical):** ${dg.detail}\n` +
      `Transcription will not work until the API key is replaced and the bot restarted. ` +
      `This is the failure that silently broke a scheduled call before — fix it before the next one.\n`
    );
  }
  if (!relay.ok) {
    lines.push(
      `**⚠️ Relay (degraded):** ${relay.detail}\n` +
      `Discord transcripts will still post, but AI summaries + email won't. ` +
      `Check that the relay service is running and reachable at \`RELAY_URL\`.`
    );
  }
  if (!r2.ok) {
    lines.push(
      `**⚠️ R2 (degraded):** ${r2.detail}\n` +
      `Discord transcripts may still post, but cloud audio/transcript links may be unavailable.`
    );
  }
  if (!schedules.ok) {
    lines.push(
      `**⚠️ Schedules:** ${schedules.detail}\n` +
      `Affected scheduled recordings will not start until fixed with \`/schedule edit\`.`
    );
  }

  try {
    const user = await client.users.fetch(userId);
    await user.send(lines.join('\n'));
    console.log(`[HealthCheck] Alerted user ${userId} via DM`);
  } catch (err) {
    console.error('[HealthCheck] Failed to DM alert user:', err);
  }
}
