import { config } from 'dotenv';
import path from 'path';

// Load .env from project root (ignored in production if not present)
config({ path: path.join(__dirname, '..', '.env') });

// Comma-separated bot tokens. tokens[0] is the "primary" (slash commands,
// delivery, member resolution — and it can record too). Additional tokens are
// voice-only recorder identities. Number of tokens = max concurrent
// recordings per server. Falls back to the legacy single DISCORD_TOKEN.
const tokens = (process.env.DISCORD_TOKENS || process.env.DISCORD_TOKEN || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const recordMeetingNames = (process.env.RECORD_MEETING_NAMES || 'UNNAMED-MEETING')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
if (recordMeetingNames.length === 0) recordMeetingNames.push('UNNAMED-MEETING');

function parseNameMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (value || '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim().toLowerCase();
    const name = pair.slice(i + 1).trim();
    if (key && name) map.set(key, name);
  }
  return map;
}

/** Preferred display name for a Discord user: SPEAKER_NAMES by id, username or nickname. */
export function aliasFor(candidates: Array<string | null | undefined>, fallback: string): string {
  for (const c of candidates) {
    const hit = c ? Config.SPEAKER_NAMES.get(c.trim().toLowerCase()) : undefined;
    if (hit) return hit;
  }
  return fallback;
}

const csv = (value: string | undefined) =>
  (value || '').split(',').map((t) => t.trim()).filter(Boolean);
const int = (value: string | undefined, fallback: number) => {
  const n = parseInt(value || '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

// Treat template placeholders ("your-...-key", "change-me") as unset.
const secret = (value: string | undefined) => {
  const v = (value || '').trim();
  return /^(your[-_]|change[-_]?me$|xxx)/i.test(v) ? '' : v;
};
const deepgramKey = secret(process.env.DEEPGRAM_API_KEY);
const groqKey = secret(process.env.GROQ_API_KEY);
// Default provider: Groq when a Groq key is present, otherwise Deepgram (upstream behaviour).
const provider = ((process.env.TRANSCRIPTION_PROVIDER || (groqKey ? 'groq' : 'deepgram')).toLowerCase()) as
  'groq' | 'deepgram';

export const Config = {
  DISCORD_TOKENS: tokens,
  // Primary token — kept so existing single-token call sites
  // (register-commands.ts, index.ts) stay unchanged.
  DISCORD_TOKEN: tokens[0] ?? '',
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID!,
  // ── Transcription ──────────────────────────────────────────────────────────
  // "groq" (Whisper on Groq, free tier) or "deepgram" (upstream default).
  TRANSCRIPTION_PROVIDER: provider,
  DEEPGRAM_API_KEY: deepgramKey,
  GROQ_API_KEY: groqKey,
  // whisper-large-v3 is noticeably more accurate (and hallucinates less) in Portuguese
  // than the turbo variant; both fit Groq's free tier.
  GROQ_WHISPER_MODEL: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3',
  // ISO-639-1 language passed to Whisper ("pt" for Portuguese). Empty = auto-detect.
  TRANSCRIPTION_LANGUAGE: (process.env.TRANSCRIPTION_LANGUAGE ?? 'pt').trim(),
  // Client-side pacing, kept a little under Groq's free-tier limits
  // (7,200 audio-s/hour, 28,800 audio-s/day, 20 req/min at the time of writing).
  GROQ_AUDIO_SECONDS_PER_HOUR: int(process.env.GROQ_AUDIO_SECONDS_PER_HOUR, 7000),
  GROQ_AUDIO_SECONDS_PER_DAY: int(process.env.GROQ_AUDIO_SECONDS_PER_DAY, 28000),
  GROQ_REQUESTS_PER_MINUTE: int(process.env.GROQ_REQUESTS_PER_MINUTE, 18),
  // Voice activity detection: frames quieter than this (dBFS) are treated as silence.
  VAD_THRESHOLD_DBFS: int(process.env.VAD_THRESHOLD_DBFS, -45),
  // Max audio per request sent to Whisper (seconds of speech, silence removed).
  TRANSCRIPTION_CHUNK_SECONDS: Math.max(30, int(process.env.TRANSCRIPTION_CHUNK_SECONDS, 600)),
  // Live transcript in Discord while recording. Needs Deepgram (Whisper has no
  // streaming mode). Opt-in: on by default only when Deepgram is the provider.
  LIVE_TRANSCRIPTION: bool(process.env.LIVE_TRANSCRIPTION, provider === 'deepgram') && !!deepgramKey,
  // ── In-person meetings ─────────────────────────────────────────────────────
  // Text channels where an uploaded audio file (or a direct link to one) is
  // transcribed, summarized and emailed like a recorded call.
  IN_PERSON_CHANNEL_IDS: csv(process.env.IN_PERSON_CHANNEL_IDS),
  // Max size of a downloaded in-person recording (MB).
  IN_PERSON_MAX_MB: int(process.env.IN_PERSON_MAX_MB, 200),
  // ── Names ──────────────────────────────────────────────────────────────────
  // How people appear in transcripts and minutes, overriding Discord nicknames.
  // "username_or_id=Nome" pairs separated by commas, e.g. "th1=Théo,ronaldyop65=Ronald".
  SPEAKER_NAMES: parseNameMap(process.env.SPEAKER_NAMES),
  // Deepgram smart formatting turns numbers into digits. In Portuguese that also
  // rewrites the article "um" as "1" ("1 troca de provedor"), so it is off by
  // default outside English; punctuation stays on either way.
  DEEPGRAM_SMART_FORMAT: bool(process.env.DEEPGRAM_SMART_FORMAT, /^en/i.test((process.env.TRANSCRIPTION_LANGUAGE ?? 'pt').trim())),
  // Deepgram language code; defaults from TRANSCRIPTION_LANGUAGE ("pt" -> "pt-BR").
  DEEPGRAM_LANGUAGE: process.env.DEEPGRAM_LANGUAGE
    ?? ({ pt: 'pt-BR' } as Record<string, string>)[(process.env.TRANSCRIPTION_LANGUAGE ?? 'pt').trim()]
    ?? (process.env.TRANSCRIPTION_LANGUAGE ?? 'pt').trim(),
  // Display name used in health-check alerts and email subjects.
  BOT_NAME: process.env.BOT_NAME || 'OpenRecapper',
  // Meeting names offered by /record's name option. Date is appended automatically.
  RECORD_MEETING_NAMES: recordMeetingNames,
  RECORDINGS_DIR: process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'recordings'),
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || '',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
  R2_BUCKET: process.env.R2_BUCKET || '',
  R2_ENDPOINT: process.env.R2_ENDPOINT || '',
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || '',
  // User to DM when a startup health check fails (optional).
  ALERT_DISCORD_USER_ID: process.env.ALERT_DISCORD_USER_ID || '',
  // AI summary + email are routed through a small companion "relay" HTTP
  // service that bridges to an LLM provider (for summaries) and an email
  // gateway. Summarization/email are skipped gracefully if RELAY_TOKEN is unset,
  // so the bot still records and transcribes without a relay configured.
  // See README “AI summaries & email (optional)” for the expected relay API.
  RELAY_URL: process.env.RELAY_URL || 'http://127.0.0.1:8787',
  RELAY_TOKEN: process.env.RELAY_TOKEN || '',
  // Gateway model used for summaries (cost-optimal default). Empty => relay default.
  SUMMARY_MODEL: process.env.SUMMARY_MODEL || '',
  // What the group reads/discusses — tunes the summary template wording.
  SUMMARY_GROUP_NAME: process.env.SUMMARY_GROUP_NAME || 'study group',
  // Summary template: "ata-pt" (meeting minutes in Portuguese: decisions,
  // action items, caveats) or "study-group" (upstream English reading notes).
  SUMMARY_TEMPLATE: (process.env.SUMMARY_TEMPLATE || 'ata-pt') as 'ata-pt' | 'study-group',
  // Free-text context given to the summarizer (team members, roles, projects).
  SUMMARY_CONTEXT: (process.env.SUMMARY_CONTEXT || '').replace(/\\n/g, '\n'),
  // Where to email the summary + transcript links after each call (optional).
  SUMMARY_EMAIL_TO: process.env.SUMMARY_EMAIL_TO || '',
  // Email subject. Placeholders: {callName}, {botName}. Empty = upstream format.
  EMAIL_SUBJECT_TEMPLATE: process.env.EMAIL_SUBJECT_TEMPLATE || '',
  // Append the full transcript to the email body (it can be long).
  EMAIL_INCLUDE_TRANSCRIPT: bool(process.env.EMAIL_INCLUDE_TRANSCRIPT, true),
  // Number of days to keep raw audio files (.pcm, .wav) before auto-cleanup.
  // Transcripts and metadata are always preserved. Default: 7 days.
  RECORDING_RETENTION_DAYS: parseInt(process.env.RECORDING_RETENTION_DAYS || '7', 10),
  // Minutes of silence (no opus packets from any user) before the bot
  // auto-leaves the voice channel. Generous default (20 min) to accommodate
  // study-group silent reading periods. Set to 0 to disable.
  SILENCE_TIMEOUT_MINUTES: parseInt(process.env.SILENCE_TIMEOUT_MINUTES || '20', 10),
  // Optional override for where standing-call schedules are persisted.
  // Defaults to ./data/schedules.json (managed via the /schedule command).
  SCHEDULES_FILE: process.env.SCHEDULES_FILE || '',
  // Optional override for where per-guild /record grants are persisted.
  // Defaults to ./data/record-permissions.json (managed via /record-access).
  RECORD_PERMISSIONS_FILE: process.env.RECORD_PERMISSIONS_FILE || '',
  SUMMARY_CHANNELS_FILE: process.env.SUMMARY_CHANNELS_FILE || '',
  // GitHub issue filing via the /openrecapper-issue command (optional). The
  // command self-disables when token/owner/repo are unset. Use a fine-grained
  // PAT scoped to "Issues: Read & Write" on the single target repo.
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  GITHUB_OWNER: process.env.GITHUB_OWNER || '',
  GITHUB_REPO: process.env.GITHUB_REPO || '',
  // Comma-separated recipients emailed when an issue is filed. Standalone — if
  // unset, no issue emails are sent (no fallback to SUMMARY_EMAIL_TO). Requires
  // the relay to be configured for delivery.
  ISSUE_EMAIL_TO: process.env.ISSUE_EMAIL_TO || '',
  // Discord user IDs (comma-separated) to cc/@-mention at the end of the public
  // reply when an issue is filed. Empty = no cc line.
  ISSUE_CC_USER_IDS: process.env.ISSUE_CC_USER_IDS || '',
};

export function validateConfig() {
  const missing: string[] = [];
  if (Config.DISCORD_TOKENS.length === 0) missing.push('DISCORD_TOKENS (or DISCORD_TOKEN)');
  if (!Config.DISCORD_CLIENT_ID) missing.push('DISCORD_CLIENT_ID');
  if (Config.TRANSCRIPTION_PROVIDER === 'groq') {
    if (!Config.GROQ_API_KEY) missing.push('GROQ_API_KEY');
  } else if (Config.TRANSCRIPTION_PROVIDER === 'deepgram') {
    if (!Config.DEEPGRAM_API_KEY) missing.push('GROQ_API_KEY (or DEEPGRAM_API_KEY with TRANSCRIPTION_PROVIDER=deepgram)');
  } else {
    throw new Error(`TRANSCRIPTION_PROVIDER must be "groq" or "deepgram" (got "${Config.TRANSCRIPTION_PROVIDER}")`);
  }
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
