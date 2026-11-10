/**
 * Minimal Markdown -> HTML for the meeting minutes the summarizer writes:
 * headings, bullet and numbered lists, bold/italic, inline code, horizontal
 * rules and paragraphs. Everything is HTML-escaped first, so model output can
 * never inject markup into the email.
 *
 * `styles` lets the email template inline CSS (most mail clients ignore <style>).
 */

export interface MarkdownStyles {
  h1?: string;
  h2?: string;
  h3?: string;
  p?: string;
  ul?: string;
  ol?: string;
  li?: string;
  hr?: string;
  code?: string;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attr(style?: string): string {
  return style ? ` style="${style}"` : '';
}

function inline(text: string, s: MarkdownStyles): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_m, c) => `<code${attr(s.code)}>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
}

export function markdownToHtml(markdown: string, styles: MarkdownStyles = {}): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const flushPara = () => {
    if (para.length) out.push(`<p${attr(styles.p)}>${para.map((l) => inline(l, styles)).join('<br>')}</p>`);
    para = [];
  };

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      const style = level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3;
      out.push(`<h${level}${attr(style)}>${inline(heading[2], styles)}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      closeList();
      out.push(`<hr${attr(styles.hr)}>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}${attr(kind === 'ul' ? styles.ul : styles.ol)}>`);
        list = kind;
      }
      out.push(`<li${attr(styles.li)}>${inline((bullet || numbered)![1], styles)}</li>`);
      continue;
    }

    closeList();
    para.push(trimmed);
  }
  flushPara();
  closeList();
  return out.join('\n');
}
