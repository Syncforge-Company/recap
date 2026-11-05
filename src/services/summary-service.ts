import { Config } from '../config';
import { RelayClient } from './relay-client';

/**
 * AI session summary tailored for a recurring study group that meets to read
 * and discuss a particular reading (book chapter, paper, essay, etc.).
 *
 * Summaries are generated via the optional relay service (see RelayClient).
 * Skips gracefully when the relay is not configured so the rest of the
 * pipeline is unaffected.
 */
/**
 * Soft length target for summaries, stated in the prompt so the model aims for
 * it and ends cleanly. The relay's hard max_tokens cap gets 2x headroom so the
 * API limit never truncates output mid-sentence.
 */
const TARGET_TOKENS = 3000;
const TARGET_WORDS = 2250; // ~0.75 words per token
// Meeting minutes are meant to be read in a couple of minutes.
const ATA_TARGET_WORDS = 600;

export interface SummaryOptions {
  callName?: string;
  /** The whole room was captured by one microphone (in-person meeting): no per-speaker labels. */
  singleMicrophone?: boolean;
}

export class SummaryService {
  static isConfigured(): boolean {
    return RelayClient.isConfigured();
  }

  /** Heading used for the saved summary document. */
  static documentTitle(callName: string): string {
    return Config.SUMMARY_TEMPLATE === 'ata-pt' ? `Ata — ${callName}` : `${callName} — Session Notes`;
  }

  /** Meeting names containing "presencial"/"in person" were captured by a single room microphone. */
  static looksInPerson(callName: string): boolean {
    return /presencial|in[- ]person/i.test(callName || '');
  }

  /** System prompt for Portuguese meeting minutes (decisions, action items, caveats). */
  private static ataSystemPrompt(opts: SummaryOptions): string {
    return [
      `Você redige atas de reunião em português do Brasil para uma equipe de desenvolvimento de software.`,
      Config.SUMMARY_CONTEXT ? `Contexto da equipe e da empresa (use para entender papéis, nomes e projetos):\n${Config.SUMMARY_CONTEXT}` : '',
      opts.singleMicrophone
        ? `A reunião foi presencial e gravada por um único microfone: a transcrição NÃO separa quem falou. Atribua falas, decisões e tarefas a uma pessoa apenas quando o próprio texto deixar isso claro (por exemplo, alguém dizendo o nome de quem fica com a tarefa); caso contrário, não atribua.`
        : `A transcrição é separada por participante; cada bloco começa com o nome de quem falou.`,
      `Seja fiel ao que foi dito. Nunca invente decisões, prazos, responsáveis ou números. Se algo ficou ambíguo ou o áudio estava ruim, diga isso em vez de supor.`,
      `IMPORTANTE — nomes: a mensagem do usuário traz a lista oficial de participantes. A transcrição automática costuma errar a grafia de nomes; use sempre a grafia da lista e corrija silenciosamente variações que claramente se referem a um participante.`,
      `Priorize o que é acionável: decisões tomadas, tarefas com responsável e prazo, riscos e ressalvas. Seja direto e fácil de escanear.`,
      `Use exatamente a estrutura Markdown pedida. Se uma seção não tiver conteúdo, escreva "Nada registrado."`,
      `Tamanho: no máximo cerca de ${ATA_TARGET_WORDS} palavras. Se a reunião foi longa, comprima os pontos menos importantes em vez de passar do limite, e sempre termine frases e seções.`,
    ].filter(Boolean).join('\n');
  }

  /** User prompt for Portuguese meeting minutes. */
  private static ataUserPrompt(transcriptText: string, participants: string[], opts: SummaryOptions): string {
    const roster = participants.length ? participants.join(', ') : '(não identificados)';
    return [
      `Gere a ata usando EXATAMENTE esta estrutura e estes títulos:`,
      ``,
      `## 🧭 Resumo`,
      `2 a 4 frases sobre o objetivo da reunião e o que foi tratado.`,
      ``,
      `## ✅ Decisões`,
      `Lista do que foi decidido. Uma decisão por linha.`,
      ``,
      `## 📌 Pendências`,
      `Lista no formato "- Tarefa — Responsável — Prazo". Use "sem responsável definido" ou "sem prazo" quando não for dito.`,
      ``,
      `## ⚠️ Ressalvas e riscos`,
      `Pontos de atenção, bloqueios, dependências e preocupações levantadas.`,
      ``,
      `## 💬 Pontos discutidos`,
      `Principais assuntos e argumentos, de forma curta. Atribua ao participante quando estiver claro (ex.: "**Davi:** ...").`,
      ``,
      `## ❓ Em aberto`,
      `Perguntas sem resposta e assuntos que ficaram para depois.`,
      ``,
      `---`,
      opts.callName ? `Reunião: ${opts.callName}` : `Reunião: (sem nome)`,
      `Participantes (grafia OFICIAL dos nomes): ${roster}`,
      ``,
      `Transcrição:`,
      `"""`,
      transcriptText,
      `"""`,
    ].join('\n');
  }

  /** System prompt: defines the summarizer's role and output contract. */
  private static systemPrompt(): string {
    return [
      `You are a meticulous note-taker for a recurring ${Config.SUMMARY_GROUP_NAME} that meets to read and discuss a shared reading (e.g. a book chapter, paper, or essay).`,
      `You are given a speaker-diarized transcript of one session. Speakers may be labeled by name or as "Speaker N".`,
      ``,
      `Write notes that would help both attendees and people who missed the session. Be faithful to what was actually said — never invent points, citations, or conclusions. If something is unclear or the audio was garbled, say so rather than guessing.`,
      `Capture the substance of the discussion (ideas, arguments, disagreements), not just logistics. Attribute notable points to speakers when the transcript makes the attribution clear; otherwise keep it general.`,
      `IMPORTANT — names: the user message provides an authoritative "Participants" roster of attendee names. The transcript is auto-generated speech-to-text, so it often misspells names phonetically (e.g. a surname "Acks" may appear as "Aks"). Always spell every participant's name exactly as it appears in the roster, and silently correct any transcript spelling that clearly refers to a roster participant. Only use a name not in the roster if it plainly refers to a third party (e.g. a cited author) and not to an attendee.`,
      `Keep it concise and skimmable. Use the exact Markdown section structure requested by the user. Omit a section (with a short "None noted." line) if the transcript genuinely contains nothing for it.`,
      `Length: aim for no more than about ${TARGET_WORDS} words total. This is a soft target, not a hard cutoff — if the session was long, compress the less important points rather than running over, and always finish with complete sentences and sections.`,
    ].join('\n');
  }

  /** User prompt: the study-group reading-discussion template + transcript. */
  private static userPrompt(transcriptText: string, participants: string[]): string {
    const roster = participants.length ? participants.join(', ') : '(names not detected)';
    return [
      `Produce session notes using EXACTLY the following Markdown structure and headings:`,
      ``,
      `## 📖 The Reading`,
      `Name the specific reading under discussion (title/author/chapter) if it can be identified from the conversation. If it cannot be determined, write "Not clearly identified in the discussion."`,
      ``,
      `## 🧭 Overview`,
      `2–4 sentences summarizing what this session covered and the overall arc of the conversation.`,
      ``,
      `## 💡 Key Points & Themes`,
      `Bulleted list of the main ideas, arguments, and themes discussed. Attribute to a speaker when clear (e.g. "**Ben:** ..."). Group related points.`,
      ``,
      `## 🔀 Questions & Disagreements`,
      `Open questions raised, points of confusion, and any disagreements or competing interpretations among participants.`,
      ``,
      `## 🔗 References Mentioned`,
      `Any other books, papers, people, tools, or concepts referenced during the discussion. Bullet list. "None noted." if there were none.`,
      ``,
      `## ✅ Action Items & Next Time`,
      `Concrete follow-ups, who agreed to do what (if stated), and what the group plans to read or discuss next. "None noted." if none.`,
      ``,
      `## ⭐ Memorable Quotes`,
      `0–3 short, verbatim quotes that capture an interesting moment, with the speaker if known. Skip if nothing stands out.`,
      ``,
      `---`,
      `Participants (AUTHORITATIVE name spellings — use these exact spellings for attendees): ${roster}`,
      ``,
      `Transcript:`,
      `"""`,
      transcriptText,
      `"""`,
    ].join('\n');
  }

  /**
   * Generate a Markdown summary from the transcript text. Returns null if not
   * configured or on error (caller should treat summary as optional).
   * `truncated` means the model hit the hard token cap and the summary is cut
   * off mid-output.
   */
  static async summarize(
    transcriptText: string,
    participants: string[],
    opts: SummaryOptions = {},
  ): Promise<{ text: string; truncated: boolean } | null> {
    if (!this.isConfigured()) {
      console.warn('[Summary] Relay not configured (RELAY_TOKEN unset), skipping AI summary');
      return null;
    }
    const trimmed = (transcriptText || '').trim();
    if (trimmed.length < 200) {
      console.log('[Summary] Transcript too short to summarize, skipping');
      return null;
    }

    // Guard against very long transcripts blowing the context window. Keep the
    // start of the session but retain the tail (often action items / next read).
    const MAX_CHARS = 240_000;
    let body = trimmed;
    if (body.length > MAX_CHARS) {
      const head = body.slice(0, Math.floor(MAX_CHARS * 0.7));
      const tail = body.slice(-Math.floor(MAX_CHARS * 0.3));
      body = `${head}\n\n[... transcript truncated for length ...]\n\n${tail}`;
      console.log(`[Summary] Transcript truncated from ${trimmed.length} to ${body.length} chars`);
    }

    try {
      const ata = Config.SUMMARY_TEMPLATE === 'ata-pt';
      const { text, truncated } = await RelayClient.summarize(
        ata ? this.ataSystemPrompt(opts) : this.systemPrompt(),
        ata ? this.ataUserPrompt(body, participants, opts) : this.userPrompt(body, participants),
        TARGET_TOKENS * 2
      );
      if (!text) {
        console.error('[Summary] Relay returned no content');
        return null;
      }
      console.log(`[Summary] Generated summary (${text.length} chars${truncated ? ', TRUNCATED at hard cap' : ''}) via relay`);
      return { text, truncated };
    } catch (err: any) {
      console.error(`[Summary] Failed to generate summary: ${err?.message || err}`);
      return null;
    }
  }
}
