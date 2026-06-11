export type Segment =
  | { kind: 'codeblock'; lang: string; code: string }
  | { kind: 'code'; code: string }
  | { kind: 'link'; href: string }
  | { kind: 'mention'; handle: string }
  | { kind: 'text'; text: string };

const FENCE_RE = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;
const MENTION_RE = /@([a-z0-9][a-z0-9_-]{1,31})/gi;

function tokenizeMentions(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(text); m; m = MENTION_RE.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'mention', handle: m[1] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

function tokenizeLinks(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    if (m.index > last) out.push(...tokenizeMentions(text.slice(last, m.index)));
    out.push({ kind: 'link', href: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...tokenizeMentions(text.slice(last)));
  return out;
}

function tokenizeInline(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  INLINE_CODE_RE.lastIndex = 0;
  for (let m = INLINE_CODE_RE.exec(text); m; m = INLINE_CODE_RE.exec(text)) {
    if (m.index > last) out.push(...tokenizeLinks(text.slice(last, m.index)));
    out.push({ kind: 'code', code: m[1] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...tokenizeLinks(text.slice(last)));
  return out;
}

export function tokenizeMessage(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(text); m; m = FENCE_RE.exec(text)) {
    if (m.index > last) out.push(...tokenizeInline(text.slice(last, m.index)));
    out.push({
      kind: 'codeblock',
      lang: m[1] ?? '',
      code: (m[2] ?? '').replace(/\n$/, ''),
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...tokenizeInline(text.slice(last)));
  return out;
}
