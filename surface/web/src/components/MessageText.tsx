import { Fragment, type ReactNode } from 'react';

// Minimal message formatting for an engineering team: fenced code blocks,
// `inline code`, and clickable links. Everything else stays plain text —
// React escaping keeps it XSS-safe by construction.

const FENCE_RE = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  INLINE_CODE_RE.lastIndex = 0;
  for (let m = INLINE_CODE_RE.exec(text); m; m = INLINE_CODE_RE.exec(text)) {
    if (m.index > last) out.push(...renderLinks(text.slice(last, m.index), `${keyBase}-t${i}`));
    out.push(
      <code
        key={`${keyBase}-c${i}`}
        className="rounded bg-zinc-800/80 px-1 py-px font-mono text-[0.85em] text-rose-300/90"
      >
        {m[1]}
      </code>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(...renderLinks(text.slice(last), `${keyBase}-tail`));
  return out;
}

function renderLinks(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a
        key={`${keyBase}-a${i}`}
        href={m[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-indigo-400 hover:underline"
      >
        {m[0]}
      </a>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MessageText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(text); m; m = FENCE_RE.exec(text)) {
    if (m.index > last) {
      parts.push(<Fragment key={`pre${i}`}>{renderInline(text.slice(last, m.index), `f${i}`)}</Fragment>);
    }
    parts.push(
      <pre
        key={`code${i}`}
        className="my-1 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2 font-mono text-[12px] leading-relaxed text-zinc-300"
      >
        {m[2]?.replace(/\n$/, '')}
      </pre>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) {
    parts.push(<Fragment key="tail">{renderInline(text.slice(last), 'tail')}</Fragment>);
  }
  return <>{parts}</>;
}
