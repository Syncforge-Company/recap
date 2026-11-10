import { Config } from '../config';
import { escapeHtml, markdownToHtml } from './markdown-html';

export interface SessionEmailInput {
  callName: string;
  durationSec: number;
  speakerCount: number;
  participants: string[];
  links: string[];
  warnings: string[];
  /** Full summary document (title + roster + minutes), used for the plain-text part. */
  summaryText: string | null;
  /** Just the minutes written by the model; preferred for the HTML part. */
  summaryBody?: string | null;
  transcriptText: string;
}

/** Subject from EMAIL_SUBJECT_TEMPLATE ({callName}, {botName}); upstream format when unset. */
export function emailSubject(callName: string): string {
  const template = Config.EMAIL_SUBJECT_TEMPLATE;
  if (!template) return `[${Config.BOT_NAME}] ${callName} — notes & transcript`;
  return template.replace(/\{callName\}/g, callName).replace(/\{botName\}/g, Config.BOT_NAME);
}

function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}min`;
  if (m) return `${m}min ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// Calm, light layout with navy accents. Inline styles only: Gmail strips <style>.
const NAVY = '#0b2545';
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const MD_STYLES = {
  h1: `margin:0 0 12px;font-size:20px;color:${NAVY};`,
  h2: `margin:24px 0 8px;padding-bottom:6px;border-bottom:1px solid ${LINE};font-size:16px;color:${NAVY};`,
  h3: `margin:16px 0 6px;font-size:14px;color:${NAVY};`,
  p: `margin:0 0 10px;font-size:14px;line-height:1.6;color:${TEXT};`,
  ul: `margin:0 0 10px;padding-left:20px;`,
  ol: `margin:0 0 10px;padding-left:20px;`,
  li: `margin:0 0 6px;font-size:14px;line-height:1.6;color:${TEXT};`,
  hr: `border:none;border-top:1px solid ${LINE};margin:20px 0;`,
  code: `background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:13px;`,
};

function htmlEmail(input: SessionEmailInput, pt: boolean): string {
  const participants = input.participants.length ? input.participants.join(', ') : (pt ? 'não identificados' : 'not detected');
  const minutes = input.summaryBody ?? input.summaryText;
  const warnings = input.warnings.filter(Boolean);
  const meta = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0;font-size:13px;color:${MUTED};white-space:nowrap;">${escapeHtml(label)}</td>` +
    `<td style="padding:2px 0;font-size:13px;color:${TEXT};">${escapeHtml(value)}</td></tr>`;

  const sections: string[] = [];
  if (warnings.length) {
    sections.push(
      `<div style="margin:0 0 16px;padding:10px 12px;background:#fff7ed;border-left:3px solid #f59e0b;font-size:13px;color:${TEXT};">` +
      warnings.map((w) => escapeHtml(w.replace(/^⚠️\s*/, ''))).join('<br>') + `</div>`,
    );
  }
  sections.push(
    minutes
      ? markdownToHtml(minutes, MD_STYLES)
      : `<p style="${MD_STYLES.p}">${pt ? 'Nenhuma ata foi gerada para esta reunião.' : 'No AI summary was generated for this session.'}</p>`,
  );
  if (input.links.length) {
    sections.push(
      `<h2 style="${MD_STYLES.h2}">${pt ? 'Arquivos' : 'Downloads'}</h2><ul style="${MD_STYLES.ul}">` +
      input.links.map((l) => `<li style="${MD_STYLES.li}">${escapeHtml(l)}</li>`).join('') + `</ul>`,
    );
  }
  if (Config.EMAIL_INCLUDE_TRANSCRIPT && input.transcriptText) {
    sections.push(
      `<h2 style="${MD_STYLES.h2}">${pt ? 'Transcrição completa' : 'Full transcript'}</h2>` +
      `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.5;color:${TEXT};margin:0;">${escapeHtml(input.transcriptText)}</pre>`,
    );
  }

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f7fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid ${LINE};border-radius:8px;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="height:4px;background:${NAVY};border-radius:8px 8px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 8px;">
<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">${pt ? 'Ata de reunião' : 'Meeting notes'} · ${escapeHtml(Config.BOT_NAME)}</div>
<div style="margin:6px 0 14px;font-size:20px;font-weight:bold;color:${NAVY};">${escapeHtml(input.callName)}</div>
<table role="presentation" cellpadding="0" cellspacing="0">
${meta(pt ? 'Duração' : 'Duration', formatDuration(input.durationSec))}
${meta(pt ? 'Participantes' : 'Participants', participants)}
</table>
</td></tr>
<tr><td style="padding:8px 28px 24px;">
${sections.join('\n')}
</td></tr>
<tr><td style="padding:14px 28px;border-top:1px solid ${LINE};font-size:12px;color:${MUTED};">
${pt ? 'Gerado automaticamente pelo' : 'Generated automatically by'} ${escapeHtml(Config.BOT_NAME)}${pt ? ' a partir da transcrição da reunião. Confira decisões e prazos com os participantes.' : ' from the meeting transcript.'}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/**
 * Email for a finished session: an HTML version for people and a plain-text
 * version (the summary first) for clients and automations that read text.
 */
export function buildSessionEmail(input: SessionEmailInput): { subject: string; body: string; html: string } {
  const pt = Config.SUMMARY_TEMPLATE === 'ata-pt';
  const participants = input.participants.join(', ') || (pt ? '(não identificados)' : '(names not detected)');

  const lines: string[] = [
    input.callName,
    '',
    `${pt ? 'Duração' : 'Duration'}: ${formatDuration(input.durationSec)}`,
    `${pt ? 'Participantes' : 'Participants'}: ${participants}`,
  ];
  if (input.links.length) lines.push('', pt ? 'Arquivos:' : 'Downloads:', ...input.links.map((l) => `  ${l}`));
  const warnings = input.warnings.filter(Boolean);
  if (warnings.length) lines.push('', ...warnings);

  lines.push(
    '',
    '---',
    '',
    (input.summaryBody ?? input.summaryText) || (pt ? '(Nenhuma ata gerada para esta reunião.)' : '(No AI summary was generated for this session.)'),
  );

  if (Config.EMAIL_INCLUDE_TRANSCRIPT) {
    lines.push('', '---', pt ? 'Transcrição completa:' : 'Full transcript:', '', input.transcriptText);
  }

  return { subject: emailSubject(input.callName), body: lines.join('\n'), html: htmlEmail(input, pt) };
}
