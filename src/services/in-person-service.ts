import fs from 'fs';
import path from 'path';
import { Message, PermissionFlagsBits } from 'discord.js';
import { Config } from '../config';
import { createTranscriber } from './transcriber';
import { SummaryService } from './summary-service';
import { RelayClient } from './relay-client';
import { buildSessionEmail } from './email-format';
import { adHocCallName } from './call-naming';
import { hasRecordPermission } from './record-permission-store';
import { runFfmpeg, anyAudioTo16kMono, probeDurationSeconds } from './audio-utils';
import { WorkerManager } from './worker-manager';

/**
 * In-person meetings: someone records the room on a phone and drops the audio
 * (one or more files, or a direct download link) into a configured channel.
 * The bot transcribes, writes the minutes and emails them exactly like a
 * recorded Discord call.
 *
 * Message text becomes the meeting name; @mentions become the participant
 * roster (so names are spelled right in the minutes). Example:
 *   "SyncForge - Planejamento @Alessandra @William" + recording.m4a
 */

const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|opus|aac|flac|webm|amr|3gp|mp4|mov|mkv)$/i;
const URL_RE = /https?:\/\/\S+/gi;

function isAudioAttachment(a: { name: string | null; contentType: string | null }): boolean {
  const type = a.contentType || '';
  return type.startsWith('audio/') || type.startsWith('video/') || AUDIO_EXT.test(a.name || '');
}

/** Google Drive share links -> direct download links (small files only; big ones need a confirm page). */
export function directDownloadUrl(url: string): string {
  const drive = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (drive) return `https://drive.google.com/uc?export=download&id=${drive[1]}`;
  const dropbox = url.match(/^(https:\/\/www\.dropbox\.com\/.+?)(\?.*)?$/);
  if (dropbox) return `${dropbox[1]}?dl=1`;
  return url;
}

/**
 * Only public https URLs: links come from chat, so don't let them point the bot
 * at localhost, the relay container or the LAN.
 */
export function isAllowedDownloadUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || !host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\[?[0-9a-f:]+\]?$/.test(host) && host.includes(':')) return false; // IPv6 literal
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

async function download(url: string, dest: string, maxBytes: number): Promise<void> {
  if (!isAllowedDownloadUrl(url)) throw new Error('only public https links are accepted');
  const res = await fetch(url, { redirect: 'follow' });
  if (res.url && !isAllowedDownloadUrl(res.url)) throw new Error('the link redirected to a non-public address');
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('text/html')) {
    throw new Error('the link returned a web page, not an audio file (is it public / a direct download link?)');
  }
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared > maxBytes) throw new Error(`file is larger than ${Config.IN_PERSON_MAX_MB} MB`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`file is larger than ${Config.IN_PERSON_MAX_MB} MB`);
  fs.writeFileSync(dest, buf);
}

export function isInPersonChannel(channelId: string): boolean {
  return Config.IN_PERSON_CHANNEL_IDS.includes(channelId);
}

export async function handleInPersonMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.guild || !isInPersonChannel(message.channelId)) return;

  const attachments = [...message.attachments.values()].filter(isAudioAttachment);
  const links = (message.content.match(URL_RE) || []).map(directDownloadUrl);
  if (attachments.length === 0 && links.length === 0) return;

  const member = message.member;
  const allowed = member?.permissions.has(PermissionFlagsBits.ManageGuild) || hasRecordPermission(message.guild.id, message.author.id);
  if (!allowed) {
    await message.reply('❌ Você precisa da permissão Gerenciar Servidor ou de acesso via `/record-access` para enviar reuniões.');
    return;
  }

  const title = message.content.replace(URL_RE, '').replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim();
  const callName = adHocCallName(title || 'Reunião presencial');
  const participants = [
    member?.displayName || message.author.username,
    ...message.mentions.members?.map((m) => m.displayName) ?? [],
  ].filter((n, i, all) => all.indexOf(n) === i);

  const sessionDir = path.join(Config.RECORDINGS_DIR, `inperson_${message.guild.id}_${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  await message.react('⏳').catch(() => undefined);
  const status = await message.reply(`🎙️ Recebi a gravação de **${callName}**. Transcrevendo e gerando a ata — isso pode levar alguns minutos.`);

  try {
    // 1) Download every part, in the order it was sent.
    const maxBytes = Config.IN_PERSON_MAX_MB * 1024 * 1024;
    const parts: string[] = [];
    let n = 0;
    for (const a of attachments) {
      const dest = path.join(sessionDir, `part${n++}${path.extname(a.name || '') || '.audio'}`);
      await download(a.url, dest, maxBytes);
      parts.push(dest);
    }
    for (const url of links) {
      const dest = path.join(sessionDir, `part${n++}.audio`);
      await download(url, dest, maxBytes);
      parts.push(dest);
    }

    // 2) Several parts (phone recorders often split long recordings) become one track.
    const combined = path.join(sessionDir, 'recording.ogg');
    if (parts.length === 1) {
      await runFfmpeg(['-i', parts[0], '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', combined]);
    } else {
      const pcms: Buffer[] = [];
      for (const p of parts) {
        const pcm = `${p}.16k.pcm`;
        await anyAudioTo16kMono(p, pcm);
        pcms.push(fs.readFileSync(pcm));
        fs.rmSync(pcm, { force: true });
      }
      await runFfmpeg(['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', combined], Buffer.concat(pcms));
    }
    for (const p of parts) fs.rmSync(p, { force: true });

    // 3) Transcribe (one microphone for the whole room).
    const transcriber = createTranscriber();
    const transcript = await transcriber.transcribeFile(combined, 'Sala');
    const durationSec = Math.round(await probeDurationSeconds(combined));

    const roster = participants.length ? `Participants:\n${participants.map((p) => `  - ${p}`).join('\n')}\n\n---\n\n` : '';
    fs.writeFileSync(path.join(sessionDir, 'transcript.txt'), roster + transcript.text);
    fs.writeFileSync(path.join(sessionDir, 'transcript.srt'), transcript.srt);

    // 4) Minutes.
    let summaryText: string | null = null;
    let relayWarning = '';
    try {
      const generated = await SummaryService.summarize(roster + transcript.text, participants, { callName, singleMicrophone: true });
      if (generated) {
        summaryText = `# ${SummaryService.documentTitle(callName)}\n\n${roster}${generated.text}\n`;
        fs.writeFileSync(path.join(sessionDir, 'summary.md'), summaryText);
      }
    } catch (err) {
      relayWarning = '⚠️ A ata automática falhou; a transcrição está disponível.';
      console.error('[InPerson] Summary failed:', err);
    }

    // 5) Email (feeds the weekly report automation).
    let emailWarning = '';
    if (Config.SUMMARY_EMAIL_TO && RelayClient.isConfigured()) {
      try {
        const { subject, body } = buildSessionEmail({
          callName,
          durationSec,
          speakerCount: participants.length,
          participants,
          links: [],
          warnings: [relayWarning],
          summaryText,
          transcriptText: transcript.text,
        });
        await RelayClient.email(Config.SUMMARY_EMAIL_TO, subject, body);
      } catch (err) {
        emailWarning = '⚠️ O envio do e-mail falhou; a ata ficou só aqui no Discord.';
        console.error('[InPerson] Email failed:', err);
      }
    }

    // 6) Post results in the channel.
    const mins = Math.floor(durationSec / 60);
    const warnings = [relayWarning, emailWarning].filter(Boolean).join('\n');
    await status.edit(
      `📝 **${callName}** — transcrição concluída (${mins} min, ${transcript.segments.length} trechos).` +
      (warnings ? `\n\n${warnings}` : ''),
    );
    const files = [{ attachment: Buffer.from(transcript.text), name: 'transcricao.txt' }];
    if (summaryText) files.unshift({ attachment: Buffer.from(summaryText), name: 'ata.md' });
    await message.reply({ content: '📎 Arquivos da reunião:', files }).catch((err) => console.error('[InPerson] Failed to post files:', err));
    if (summaryText) {
      const channel = message.channel;
      if (channel.isSendable()) {
        for (const chunk of WorkerManager.chunkText(summaryText)) {
          await channel.send(chunk).catch((err) => console.error('[InPerson] Failed to post minutes chunk:', err));
        }
      }
    }
    await message.reactions.cache.get('⏳')?.users.remove(message.client.user!.id).catch(() => undefined);
    await message.react('✅').catch(() => undefined);
  } catch (err: any) {
    console.error('[InPerson] Failed to process recording:', err);
    await status.edit(`❌ Não consegui processar a gravação: ${err?.message || err}`).catch(() => undefined);
    await message.react('❌').catch(() => undefined);
  }
}
