# Recap — SyncForge

Bot de Discord da SyncForge que grava reuniões, transcreve cada participante separadamente e gera a **ata automática** (decisões, pendências com responsável, ressalvas), enviada por e-mail. Também processa áudios de **reuniões presenciais**.

Fork do [OpenRecapper](https://github.com/The-Yak-Collective/openrecapper) (MIT), adaptado para rodar **sem custo**:

| Etapa | Original | Recap |
|---|---|---|
| Transcrição | Deepgram (pago por uso) | **Whisper no Groq** (plano gratuito) — Deepgram continua opcional |
| Silêncio | enviado junto | **cortado antes do envio** (economiza o limite do Groq) |
| Limite do provedor | — | **fila que respeita segundos de áudio por hora/dia e requisições por minuto** |
| Ata | inglês, clube de leitura | **português, formato de ata** + contexto da equipe |
| Resumo + e-mail | relay só para exe.dev | **relay próprio**: Groq/OpenRouter/Gemini/Anthropic + Gmail (SMTP) |
| Presencial | — | **áudio enviado num canal** (anexo ou link) vira ata |

## Como funciona

```
/record ──► bot grava uma faixa por pessoa ──► /stop (ou todos saem)
                                                  │
              ffmpeg: 16 kHz mono ─► detector de silêncio ─► trechos com fala
                                                  │
                      fila do Groq (respeita limites) ─► Whisper (pt)
                                                  │
              transcrição com nome de quem falou ─► relay ─► LLM gera a ata
                                                  │
                    Discord (ata + transcrição) + e-mail "[REUNIÃO] ..."
```

Cada pessoa vem numa faixa separada do Discord, então o nome de quem falou é exato — mesmo quando duas pessoas falam ao mesmo tempo, cada faixa tem só uma voz. O corte de silêncio faz uma reunião de 1 hora com 4 pessoas custar perto de 1 hora de áudio (não 4).

O e-mail sai com o assunto `[REUNIÃO] <nome da reunião> <data>` para o `SUMMARY_EMAIL_TO`, no formato que a automação semanal de resumo já lê.

## Configuração

Você precisa de:

1. **App do Discord** — siga o [DISCORD_SETUP.md](DISCORD_SETUP.md) (ative *Message Content Intent* e convide com a permissão `3263488`).
2. **Chave do Groq** — https://console.groq.com/keys (grátis, sem cartão).
3. **Senha de app do Gmail** — na conta que envia: Conta Google → Segurança → Verificação em duas etapas → *Senhas de app*.
4. **Docker** (recomendado; no Windows use Docker Desktop ou WSL). O bot compila módulos nativos de áudio, e o Docker evita essa dor de cabeça.

```bash
cp .env.example .env
# preencha DISCORD_TOKEN, DISCORD_CLIENT_ID, GROQ_API_KEY, RELAY_TOKEN (openssl rand -hex 24),
# SMTP_PASS e, para reuniões presenciais, IN_PERSON_CHANNEL_IDS

docker compose up -d --build
docker compose run --rm bot node dist/register-commands.js   # registra os comandos (uma vez)
docker compose logs -f bot                                   # deve mostrar "Logged in" e os health checks
```

Sem Docker: Node 22+, ffmpeg no PATH, `npm install`, `npm run register`, `npm run dev`, e o relay em outro terminal com `cd relay-syncforge && npm install && node server.mjs`.

O bot só precisa estar ligado **durante as reuniões**. Rodar no seu PC funciona; para gravações agendadas (`/schedule`) ele precisa ficar ligado o tempo todo (VPS).

## Uso

**Reunião no Discord**
- `/record channel:#voz name:SyncForge - SIGEM` para começar.
- `/stop channel:#voz` para terminar — ou o bot para sozinho quando todo mundo sai do canal.
- A ata aparece no canal de texto (ou no definido com `/set-summary-channel`) e vai por e-mail.
- Quem não é admin precisa de liberação: `/record-access grant`.

**Reunião presencial** — duas formas:
1. **Celular no canal de voz** (mais simples): um celular entra no canal de voz com o microfone ligado, os demais ficam fora ou mutados, e alguém dá `/record` com o nome `SyncForge - Presencial`. A ata já sabe que foi um microfone só.
2. **Enviar o áudio depois**: grave com o gravador do celular e mande no canal configurado em `IN_PERSON_CHANNEL_IDS`, com o nome da reunião no texto e os participantes mencionados:
   `SyncForge - Planejamento @Alessandra @William` + `gravacao.m4a`
   - Aceita vários arquivos na mesma mensagem (são juntados na ordem) e links diretos (Google Drive público, Dropbox).
   - O limite de upload do Discord é baixo (cerca de 10 MB sem Nitro). Para reuniões longas, grave em qualidade baixa (voz, mono) ou mande um link.

## Limites e custos

- **Groq (Whisper)**: o plano gratuito limita segundos de áudio por hora e por dia e requisições por minuto (valores na sua conta: https://console.groq.com/settings/limits). O bot conta o que já enviou e **espera a janela liberar** em vez de falhar — no pior caso, a ata chega mais tarde.
- **Resumo (LLM)**: o padrão é o Groq (`LLM_PROVIDER=groq`). Planos gratuitos têm limite de tokens por minuto, então reuniões muito longas podem precisar de outro provedor (OpenRouter ou Gemini gratuitos, ou Anthropic com `LLM_PROVIDER=anthropic` e `ANTHROPIC_API_KEY`, usando o Claude Haiku por padrão).
- **Privacidade (LGPD)**: avise e obtenha o consentimento de quem for gravado. Áudios ficam em `recordings/` e são apagados após `RECORDING_RETENTION_DAYS` (transcrições e atas ficam).

## Ajustes finos

- **Fala cortada ou ruído enviado**: ajuste `VAD_THRESHOLD_DBFS` (padrão `-45`).
- **Nomes e termos errados na transcrição**: complete `GROQ_WHISPER_PROMPT` e `SUMMARY_CONTEXT`.
- **Testes**: `npm test` (o teste do pipeline do Groq precisa de ffmpeg).

## Créditos e licença

Baseado no [OpenRecapper](https://github.com/The-Yak-Collective/openrecapper), © 2026 The Yak Collective, licença MIT. As modificações da SyncForge seguem a mesma licença ([LICENSE](LICENSE)).

---

<details>
<summary>README original do OpenRecapper (inglês)</summary>

# OpenRecapper

An open-source Discord bot that **records voice channels**, produces
**speaker-labeled transcripts**, and writes a structured **AI call summary** —
overview, key points, open questions, references, and action items — then
optionally emails it to your group.

> **Self-hosted.** There is no shared/hosted instance, and **no “Add to
> Discord” invite link** — by design. You run your own bot with your own Discord
> application, Deepgram account, and (optional) storage and summarization
> services. Installing OpenRecapper means creating your own Discord app and
> inviting *that* (see [Setup](#setup) and [DISCORD_SETUP.md](DISCORD_SETUP.md)),
> not clicking an invite to someone else's bot.

## Features

- **`/record`** — Start recording a voice channel (required `channel:` and `name:` picker). Usable by server managers or users granted access with `/record-access grant`.
- **`/record-access`** — Admin command to grant/list/revoke non-admin users who may use `/record`.
- **`/stop`** — Stop recording a voice channel (required `channel:`), transcribe, and post results.
- **Concurrent recordings** *(optional)* — Record several meetings in the same server at once by supplying extra bot tokens via `DISCORD_TOKENS`.
- **`/status`** — Show active recording sessions.
- **`/set-summary-channel`** — Choose which text channel session summaries are posted in (`set`/`clear`/`show`); defaults to the channel where `/record` ran.
- **`/openrecapper-issue`** — Describe a bug, feature, or idea and have it filed as a GitHub issue.
- **Real-time transcription** — Live transcript streamed to a text channel as people talk.
- **Batch transcription** — High-quality Deepgram Nova-3 transcription with speaker diarization on stop.
- **AI session summary** *(optional)* — A structured Markdown recap after the call (overview, key points, questions/disagreements, references, action items, quotes).
- **Email delivery** *(optional)* — Emails the summary + transcript links to a configured address.
- **Cloud archival** *(optional)* — Uploads recordings/transcripts to any S3-compatible bucket (e.g. Cloudflare R2) with download links.
- **Auto-stop** — Stops automatically when everyone leaves the voice channel.
- **Scheduled recording** *(optional)* — Auto-join standing calls on a schedule, managed at runtime with `/schedule`.
- **Silence timeout** — Auto-leaves and cleans up if a call has no voice activity for a configurable window (default 20 min).
- **Recording cleanup** — Prunes old audio files on a retention schedule while keeping transcripts/summaries.
- **DAVE E2EE** — Supports Discord's end-to-end encryption for voice.
- **Startup health check** — Validates the Deepgram key on boot and can DM an alert if it's dead.
- **Grapevine** *(optional)* — Cross-server reaction forwarding via webhook. See [`docs/GRAPEVINE.md`](docs/GRAPEVINE.md).

## How it works

1. The bot joins the voice channel and subscribes to each user's audio stream.
2. Opus packets are decoded to 48kHz 16-bit stereo PCM.
3. **While recording:** PCM is streamed to per-user Deepgram WebSockets for live transcription, posted to Discord every few seconds with speaker names.
4. **On stop:** Per-user tracks are combined into a single WAV and sent to Deepgram Nova-3 for high-quality batch transcription with diarization.
5. Artifacts (WAV, transcript) are optionally uploaded to your S3-compatible bucket.
6. Results are posted to Discord; an AI summary + email are sent if a relay is configured.

## What you need to bring

Each operator runs and pays for their own:

- **Discord application + bot token** (free) — see [DISCORD_SETUP.md](DISCORD_SETUP.md).
- **Deepgram account + API key** — speech-to-text (live + batch). Usage-billed.
- **Hosting** — anywhere that runs Node.js 22 (your laptop, a VPS, a container).
- *(optional)* **S3-compatible storage** (e.g. Cloudflare R2) for archival + download links.
- *(optional)* **A “relay” service** you run for AI summaries + email (see below).

## Setup

**Requirements:** Node.js 22+ (required by `@discordjs/voice` 0.19+) and a
toolchain able to build native modules (`@discordjs/opus`, `sodium-native`,
`@snazzah/davey`).

1. **Clone and install**
   ```bash
   git clone https://github.com/The-Yak-Collective/openrecapper.git
   cd openrecapper
   npm install
   ```

2. **Configure**
   ```bash
   cp .env.example .env
   # edit .env — see comments there for required vs optional vars
   ```
   Required: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEEPGRAM_API_KEY`.
   Everything else is optional. See [DISCORD_SETUP.md](DISCORD_SETUP.md) for
   creating the Discord app and inviting the bot.

   **Multiple concurrent recordings per server** *(optional)*: Discord allows
   each bot identity only one voice connection per server, so recording N
   meetings in the same server at once requires N bot tokens. Set
   `DISCORD_TOKENS` (comma-separated, primary first) instead of
   `DISCORD_TOKEN` — the token count is the per-server concurrency limit.
   The primary token handles all slash commands and delivery (and can record
   too); the rest are voice-only recorder identities. For each extra token:
   create another bot application in the Discord Developer Portal and invite
   it to your server(s) with Connect + Speak permissions (a recorder not
   invited to a server simply doesn't count toward that server's capacity).
   Single-token setups can keep using `DISCORD_TOKEN` unchanged.

   **Meeting names for `/record`**: set `RECORD_MEETING_NAMES` to a
   comma-separated list of names shown in the required `name:` picker. The list
   is a hard allow-list — `/record` validates the chosen name against it
   server-side and rejects anything not on the list, so only these names can
   ever be recorded. The recording date is appended automatically, e.g.
   `RECORD_MEETING_NAMES=SIG-FPT,SIG-P4B,SIG-MRG,SIG-DRG`.
   R2 uploads are grouped under folders named for these meetings, e.g.
   `recordings/SIG-FPT/YYYY-MM-DD/...`.

3. **Register slash commands** (against your own app)
   ```bash
   npm run register
   ```

4. **Run**
   ```bash
   npm run dev     # development (tsx, no build step)
   # or, for production:
   npm run build   # compile TypeScript to dist/
   npm start       # node dist/index.js
   ```

## Bot permissions

Permissions integer `3263488`: View Channel, Connect, Speak (required even
though the bot is muted), Send Messages, Attach Files, Embed Links, Read Message
History. (Use Slash Commands is granted by the `applications.commands` scope, not
a permission bit.)

OAuth2 scopes: `bot`, `applications.commands`.

Intents (all requested on startup): `Guilds`, `GuildVoiceStates`,
`GuildMessages`, `GuildMessageReactions`, and `MessageContent`. The last is a
**privileged** intent, so **Message Content Intent must be enabled** in the
Developer Portal or login fails — see [DISCORD_SETUP.md](DISCORD_SETUP.md).
`GuildMessageReactions` + `MessageContent` are only actually used by Grapevine,
but are requested regardless.

## AI summaries & email (optional)

Summaries and email are produced by a small **companion “relay” HTTP service**
that you run and point at your own LLM provider and email gateway. This keeps
LLM/email credentials out of the bot. If `RELAY_TOKEN` is unset, the bot still
records and transcribes — summaries and email are simply skipped.

The bot calls two authenticated endpoints (header `X-Relay-Token`):

```
POST /summarize  { system, prompt, model?, maxTokens }  ->  { text }
POST /email      { to, subject, body }                  ->  200 OK
```

Implement those against whatever LLM/email services you prefer, set `RELAY_URL`
and `RELAY_TOKEN`, and the bot will post AI summaries and send email after each
call. Tune `SUMMARY_GROUP_NAME` to fit your context (e.g. “engineering
standup”, “book club”).

**Reference implementation:** a ready-made relay ships in
[`relay-exedev/`](relay-exedev/) — a small Node service that bridges these two
endpoints to [exe.dev](https://exe.dev)'s LLM and email gateways, so the bot
gets summaries and email without you holding any third-party API keys. It must
run on an exe.dev VM (the gateways are link-local). See
[`relay-exedev/README.md`](relay-exedev/README.md) for its env vars and
endpoint reference, and `relay-exedev/relay.service.example` for a sample
systemd unit. On any other host, use it as a template for your own relay.

## Scheduled recording (optional)

The bot can auto-join and record standing calls on a schedule, managed at
runtime with the **`/schedule`** command (requires Manage Server):

```
/schedule add voice_channel:#standup days:mon,fri time:11:15 text_channel:#transcriptions
/schedule list
/schedule edit | remove | pause | resume
```

`days` accepts names/aliases (`mon,fri`, `weekdays`, `weekends`, `daily`),
`time` is 24-hour `HH:MM`, and `timezone` is any IANA zone (default
`America/New_York`). Schedules persist to `data/schedules.json` and survive
restarts. Each active schedule must have an explicit text channel for live
transcript/results (`/schedule add text_channel:...` or `/schedule edit ...
text_channel:...`). Use `/test-schedule` to trigger one manually.

The legacy `SCHEDULED_*` env vars (see `.env.example`) are still honored as a
**one-time seed**: if no `data/schedules.json` exists on first start, they create
the first schedule, after which the JSON store is authoritative.

A configurable **silence timeout** (`SILENCE_TIMEOUT_MINUTES`, default 20) makes
the bot auto-leave a call with no voice activity, and old audio files are pruned
after `RECORDING_RETENTION_DAYS` (default 7) while transcripts are kept.

## Privacy & consent

This bot records and transcribes voice conversations. **You are responsible**
for obtaining participant consent and complying with your server's rules and
applicable laws. Be aware that:

- Recordings are written to local disk (`RECORDINGS_DIR`).
- If storage is configured, recordings/transcripts are uploaded to your bucket
  and may be reachable via public download links.
- Session folders and metadata include Discord user IDs and display names.
- Retention, access control, and deletion are entirely up to you.

## Deployment

OpenRecapper is a standard Node.js app and runs anywhere Node 22 does. Common
options:

- **[exe.dev](https://exe.dev/i/rlTIGN3KYBROR72) VM (recommended):** OpenRecapper is developed and
  run on an exe.dev VM and it's a great fit — a persistent Node 22 box with
  systemd, SSH, and an HTTPS proxy, so you can `npm run build`, drop in a systemd
  unit, and leave the bot running 24/7. This is what the maintainers use.
- **Local / VPS:** `npm run build` then run `node dist/index.js` under a process
  manager (systemd, pm2, etc.).
- **Docker:** a [`Dockerfile`](Dockerfile) is included.

Keep secrets in environment variables (or your platform's secret store), never
in the repo. There is no shared hosting or shared credentials — each fork runs
its own instance and pays for its own Discord app, Deepgram, storage, and host.

## Architecture

```
src/
├── index.ts                          # Bot entry, interaction router, auto-stop, reaction handler
├── client.ts                         # Shared Discord client reference
├── config.ts                         # Environment config
├── register-commands.ts              # Slash command registration script
├── commands/                         # /record /record-access /stop /status /schedule
│                                     #   /test-schedule /set-summary-channel
│                                     #   /openrecapper-issue /grapevine
├── workers/
│   └── voice-worker.ts               # Voice channel recorder (per-user streams)
└── services/
    ├── worker-manager.ts             # Session orchestration, transcription, upload, summary, email
    ├── recorder-pool.ts              # Leases recorder identities for concurrent recordings
    ├── opus-decoder.ts               # Opus → PCM transform stream
    ├── silence-filler.ts             # Pads gaps so per-user tracks stay time-aligned
    ├── transcription-service.ts      # Deepgram batch transcription (REST)
    ├── live-transcription-service.ts # Deepgram real-time streaming (WebSocket)
    ├── storage-service.ts            # S3-compatible (R2) upload
    ├── recording-cleanup.ts          # Prunes old audio files on a retention schedule
    ├── scheduler.ts                  # node-cron auto-join for standing calls
    ├── schedule-store.ts             # Persists standing-call schedules (data/schedules.json)
    ├── cron-format.ts                # Translates /schedule inputs ↔ 5-field cron expressions
    ├── call-naming.ts                # Call naming + ISO-date slugs
    ├── record-permission-store.ts    # Per-guild /record access allow-list
    ├── summary-channel-store.ts      # Per-guild override for where summaries are posted
    ├── summary-service.ts            # AI session summary
    ├── relay-client.ts               # Relay client (LLM summary + email)
    ├── issue-draft-service.ts        # Turns /openrecapper-issue text into an issue draft (via relay)
    ├── github-issue-client.ts        # Files GitHub issues via a fine-grained PAT
    ├── health-check.ts               # Startup Deepgram/relay health probes
    └── grapevine-service.ts          # Cross-server reaction forwarding
```

## Tech stack

- [discord.js](https://discord.js.org/) v14 + [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) (dev build with DAVE receive fix)
- [@snazzah/davey](https://github.com/Snazzah/davey) — DAVE E2EE native module
- [Deepgram Nova-3](https://deepgram.com/) — batch + streaming transcription
- [node-cron](https://github.com/node-cron/node-cron) — scheduled auto-join
- Optional: any S3-compatible store (e.g. [Cloudflare R2](https://developers.cloudflare.com/r2/)) for archival
- Node.js 22, TypeScript

## License

[MIT](LICENSE).

</details>
