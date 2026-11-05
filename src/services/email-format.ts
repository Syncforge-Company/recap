import { Config } from '../config';

export interface SessionEmailInput {
  callName: string;
  durationSec: number;
  speakerCount: number;
  participants: string[];
  links: string[];
  warnings: string[];
  summaryText: string | null;
  transcriptText: string;
}

/** Subject from EMAIL_SUBJECT_TEMPLATE ({callName}, {botName}); upstream format when unset. */
export function emailSubject(callName: string): string {
  const template = Config.EMAIL_SUBJECT_TEMPLATE;
  if (!template) return `[${Config.BOT_NAME}] ${callName} — notes & transcript`;
  return template.replace(/\{callName\}/g, callName).replace(/\{botName\}/g, Config.BOT_NAME);
}

/**
 * Plain-text email for a finished session. With the Portuguese template the
 * labels are in Portuguese; the summary comes first so the email can be read
 * (and parsed by downstream automations) without scrolling past a transcript.
 */
export function buildSessionEmail(input: SessionEmailInput): { subject: string; body: string } {
  const pt = Config.SUMMARY_TEMPLATE === 'ata-pt';
  const mins = Math.floor(input.durationSec / 60);
  const secs = input.durationSec % 60;
  const participants = input.participants.join(', ') || (pt ? '(não identificados)' : '(names not detected)');

  const lines: string[] = [
    input.callName,
    '',
    `${pt ? 'Duração' : 'Duration'}: ${mins}m ${secs}s`,
    `${pt ? 'Falantes' : 'Speakers'}: ${input.speakerCount}`,
    `${pt ? 'Participantes' : 'Participants'}: ${participants}`,
  ];
  if (input.links.length) lines.push('', pt ? 'Arquivos:' : 'Downloads:', ...input.links.map((l) => `  ${l}`));
  const warnings = input.warnings.filter(Boolean);
  if (warnings.length) lines.push('', ...warnings);

  lines.push(
    '',
    '---',
    '',
    input.summaryText || (pt ? '(Nenhuma ata gerada para esta reunião.)' : '(No AI summary was generated for this session.)'),
  );

  if (Config.EMAIL_INCLUDE_TRANSCRIPT) {
    lines.push('', '---', pt ? 'Transcrição completa:' : 'Full transcript:', '', input.transcriptText);
  }

  return { subject: emailSubject(input.callName), body: lines.join('\n') };
}
