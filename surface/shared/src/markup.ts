const MARKDOWN_BLOCK_RE = /(^|\n)\s{0,3}(#{1,6}\s+\S|([-*+]|\d+[.)])\s+\S|>\s+\S|```)/;

export function isStructuredTextForMarkup(text: string): boolean {
  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return nonEmptyLines.length >= 2 || MARKDOWN_BLOCK_RE.test(text);
}

export function splitMarkdownFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: '', body: content };
  }
  const newline = content.startsWith('---\r\n') ? '\r\n' : '\n';
  const closeMarker = `${newline}---${newline}`;
  const closeIndex = content.indexOf(closeMarker, 3);
  if (closeIndex === -1) return { frontmatter: '', body: content };
  const frontmatterEnd = closeIndex + closeMarker.length;
  const bodyStart =
    content.slice(frontmatterEnd, frontmatterEnd + newline.length) === newline
      ? frontmatterEnd + newline.length
      : frontmatterEnd;
  return { frontmatter: content.slice(0, frontmatterEnd), body: content.slice(bodyStart) };
}

/** One-line plain-text preview: compact the blocks, then strip inline markup
 * (links/code/emphasis) so the string can render in a truncating Text node. */
export function plainMarkdownSnippet(text: string): string {
  return compactMarkdownSource(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)([*_])(?!\s)([^*_]+?)(?<=\S)\2(?=\s|[.,!?;:]|$)/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactMarkdownSource(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) => {
      const body = match
        .replace(/^```[^\n]*\n?/, '')
        .replace(/```$/, '')
        .trim();
      return body ? `\`${body.split(/\n/)[0]}\`` : '';
    })
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
