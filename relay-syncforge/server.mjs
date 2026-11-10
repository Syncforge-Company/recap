// SyncForge relay for Recap.
//
// Implements the two endpoints the bot calls (see src/services/relay-client.ts):
//   POST /summarize { system, prompt, model?, maxTokens } -> { text, truncated }
//   POST /email     { to, subject, body }                 -> { ok: true }
//   GET  /health                                          -> { ok: true }
// Both POSTs require the X-Relay-Token header.
//
// Summaries go to any OpenAI-compatible chat API (Groq, OpenRouter, Gemini...)
// or to Anthropic's Messages API. Email is sent over SMTP (Gmail with an app
// password works out of the box).
import http from 'node:http';
import nodemailer from 'nodemailer';

const env = process.env;
const PORT = parseInt(env.RELAY_PORT || '8787', 10);
const HOST = env.RELAY_HOST || '127.0.0.1';
const RELAY_TOKEN = env.RELAY_TOKEN || '';

// ── LLM ──────────────────────────────────────────────────────────────────────
// LLM_PROVIDER: groq | openrouter | gemini | openai-compatible | anthropic
const PROVIDER = (env.LLM_PROVIDER || 'groq').toLowerCase();
const PRESETS = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', key: env.GROQ_API_KEY },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free', key: env.OPENROUTER_API_KEY },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', key: env.GEMINI_API_KEY },
  'openai-compatible': { url: env.LLM_BASE_URL, model: env.LLM_MODEL, key: env.LLM_API_KEY },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5', key: env.ANTHROPIC_API_KEY },
};
const preset = PRESETS[PROVIDER];
const LLM_URL = env.LLM_BASE_URL || preset?.url;
const LLM_MODEL = env.LLM_MODEL || preset?.model;
const LLM_KEY = env.LLM_API_KEY || preset?.key;

// ── SMTP ─────────────────────────────────────────────────────────────────────
const SMTP_HOST = env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(env.SMTP_PORT || '465', 10);
const SMTP_USER = env.SMTP_USER || '';
const SMTP_PASS = env.SMTP_PASS || '';
const SMTP_FROM = env.SMTP_FROM || SMTP_USER;

function fatal(msg) {
  console.error(`[relay] FATAL: ${msg}`);
  process.exit(1);
}
if (!RELAY_TOKEN) fatal('RELAY_TOKEN not set');
if (!preset) fatal(`unknown LLM_PROVIDER "${PROVIDER}" (use groq, openrouter, gemini, openai-compatible or anthropic)`);
if (!LLM_URL || !LLM_MODEL || !LLM_KEY) fatal(`LLM_PROVIDER=${PROVIDER} needs an API key (and LLM_BASE_URL/LLM_MODEL for openai-compatible)`);
if (!SMTP_USER || !SMTP_PASS) console.warn('[relay] SMTP_USER/SMTP_PASS not set: /email will fail until configured');

const mailer = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function postJson(url, headers, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    // Free tiers rate-limit: honor Retry-After a couple of times before failing.
    if (res.status === 429 && attempt < 4) {
      const wait = Math.min(120, parseFloat(res.headers.get('retry-after') || '') || attempt * 20);
      console.warn(`[relay] LLM 429; retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`LLM ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
}

async function summarize({ system, prompt, model, maxTokens }) {
  const max = Math.min(maxTokens || 2500, parseInt(env.LLM_MAX_TOKENS || '6000', 10));
  if (PROVIDER === 'anthropic') {
    const data = await postJson(LLM_URL, { 'x-api-key': LLM_KEY, 'anthropic-version': '2023-06-01' }, {
      model: model || LLM_MODEL,
      max_tokens: max,
      system: system || undefined,
      messages: [{ role: 'user', content: prompt || '' }],
    });
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text: text.trim(), truncated: data.stop_reason === 'max_tokens' };
  }

  const useModel = model || LLM_MODEL;
  // Reasoning models (gpt-oss, qwen3...) spend part of max_tokens thinking.
  const reasoning = env.LLM_REASONING_EFFORT || (/gpt-oss/i.test(useModel) ? 'medium' : '');
  const data = await postJson(LLM_URL, { authorization: `Bearer ${LLM_KEY}` }, {
    model: useModel,
    max_tokens: max,
    temperature: 0.2,
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt || '' },
    ],
  });
  const choice = data.choices?.[0];
  // Some models inline their reasoning as <think>...</think>; keep only the answer.
  const text = String(choice?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { text, truncated: choice?.finish_reason === 'length' };
}

async function sendEmail({ to, subject, body }) {
  if (!mailer) throw new Error('SMTP is not configured (SMTP_USER/SMTP_PASS)');
  if (!to || !subject) throw new Error('email requires "to" and "subject"');
  await mailer.sendMail({ from: SMTP_FROM, to, subject, text: body || '' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (req.headers['x-relay-token'] !== RELAY_TOKEN) return send(res, 401, { error: 'unauthorized' });

    if (req.url === '/summarize') {
      const body = await readJson(req);
      const out = await summarize(body);
      console.log(`[relay] /summarize ok (${out.text.length} chars${out.truncated ? ', truncated' : ''})`);
      return send(res, 200, out);
    }
    if (req.url === '/email') {
      const body = await readJson(req);
      await sendEmail(body);
      console.log(`[relay] /email ok -> ${body?.to}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[relay] error:', err);
    return send(res, 500, { error: String(err?.message || err) });
  }
});

// Fail loudly at startup if the configured model was retired by the provider.
async function checkModel() {
  if (PROVIDER === 'anthropic' || !/\/chat\/completions$/.test(LLM_URL)) return;
  try {
    const res = await fetch(LLM_URL.replace(/\/chat\/completions$/, '/models'), { headers: { authorization: `Bearer ${LLM_KEY}` } });
    if (!res.ok) return;
    const ids = ((await res.json()).data || []).map((m) => m.id);
    if (ids.length && !ids.includes(LLM_MODEL)) {
      console.error(`[relay] ⚠️  model "${LLM_MODEL}" is not available for this key. Set LLM_MODEL to one of: ${ids.filter((i) => !/whisper|guard|tts|orpheus/i.test(i)).join(', ')}`);
    }
  } catch { /* offline at boot: /summarize will report the real error */ }
}

server.listen(PORT, HOST, () => {
  checkModel();
  console.log(`[relay] listening on http://${HOST}:${PORT} (LLM: ${PROVIDER} / ${LLM_MODEL})`);
});
