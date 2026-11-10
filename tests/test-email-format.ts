#!/usr/bin/env npx tsx
/**
 * test-email-format.ts — Markdown -> HTML for the minutes email: structure,
 * escaping of model output, and the text/html pair from buildSessionEmail.
 *
 * Run:  npx tsx tests/test-email-format.ts
 */
process.env.SUMMARY_TEMPLATE = 'ata-pt';
process.env.EMAIL_SUBJECT_TEMPLATE = '[REUNIÃO] {callName}';
process.env.EMAIL_INCLUDE_TRANSCRIPT = 'false';


function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
// Imports are dynamic so the env vars above are set before Config loads.
const { markdownToHtml } = await import('../src/services/markdown-html');
const { buildSessionEmail } = await import('../src/services/email-format');

const md = `## ✅ Decisões
- Usar **Groq** no resumo
- Testar antes do merge

## 📌 Pendências
1. Headline — William — sexta

Texto com <img src=x onerror=alert(1)> e *ênfase*.
---`;
const html = markdownToHtml(md);
assert(html.includes('<h2>✅ Decisões</h2>'), 'h2 rendered');
assert(html.includes('<ul>') && html.includes('<li>Usar <strong>Groq</strong> no resumo</li>'), 'bullets + bold');
assert(html.includes('<ol>') && html.includes('<li>Headline — William — sexta</li>'), 'numbered list');
assert(html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img'), 'model output is escaped');
assert(html.includes('<em>ênfase</em>'), 'italic');
assert(html.includes('<hr>'), 'horizontal rule');
console.log('✅ markdownToHtml renders the minutes structure and escapes HTML');

const email = buildSessionEmail({
  callName: 'SyncForge - Geral 2026-11-10',
  durationSec: 62,
  speakerCount: 1,
  participants: ['Davi Peterson'],
  links: [],
  warnings: [''],
  summaryText: '# Ata — SyncForge - Geral 2026-11-10\n\n**Participantes:** Davi Peterson\n\n## 🧭 Resumo\nTeste.',
  summaryBody: '## 🧭 Resumo\nTeste.',
  transcriptText: 'x',
});
assert(email.subject === '[REUNIÃO] SyncForge - Geral 2026-11-10', `subject: ${email.subject}`);
assert(email.body.includes('Duração: 1min 02s') && email.body.includes('## 🧭 Resumo'), 'plain-text part keeps the minutes');
assert(!/cloud storage/i.test(email.body + email.html), 'no cloud-storage warning');
assert(email.html.includes('Ata de reunião') && email.html.includes('🧭 Resumo</h2>'), 'html part has header and sections');
assert(!email.html.includes('# Ata —'), 'html uses the minutes body, not the raw markdown title');
console.log('✅ buildSessionEmail returns subject, text and formatted HTML');
console.log('\nAll email format tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
