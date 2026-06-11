import { Fragment, type ReactNode } from 'react';

// Minimal message formatting for an engineering team: fenced code blocks,
// `inline code`, and clickable links. Everything else stays plain text —
// React escaping keeps it XSS-safe by construction.

const FENCE_RE = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;
const MENTION_RE = /@([a-z0-9][a-z0-9_-]{1,31})/gi;

function renderInline(text: string, keyBase: string, meHandle?: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  INLINE_CODE_RE.lastIndex = 0;
  for (let m = INLINE_CODE_RE.exec(text); m; m = INLINE_CODE_RE.exec(text)) {
    if (m.index > last)
      out.push(...renderLinks(text.slice(last, m.index), `${keyBase}-t${i}`, meHandle));
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
  if (last < text.length)
    out.push(...renderLinks(text.slice(last), `${keyBase}-tail`, meHandle));
  return out;
}

function renderLinks(text: string, keyBase: string, meHandle?: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    if (m.index > last)
      out.push(...renderMentions(text.slice(last, m.index), `${keyBase}-m${i}`, meHandle));
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
  if (last < text.length)
    out.push(...renderMentions(text.slice(last), `${keyBase}-mtail`, meHandle));
  return out;
}

function renderMentions(text: string, keyBase: string, meHandle?: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(text); m; m = MENTION_RE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const isMe = meHandle != null && m[1]!.toLowerCase() === meHandle.toLowerCase();
    out.push(
      <span
        key={`${keyBase}-at${i}`}
        className={
          isMe
            ? 'rounded bg-amber-400/20 px-0.5 font-medium text-amber-200'
            : 'rounded bg-indigo-500/10 px-0.5 text-indigo-300'
        }
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MessageText({ text, meHandle }: { text: string; meHandle?: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(text); m; m = FENCE_RE.exec(text)) {
    if (m.index > last) {
      parts.push(
        <Fragment key={`pre${i}`}>
          {renderInline(text.slice(last, m.index), `f${i}`, meHandle)}
        </Fragment>,
      );
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
    parts.push(<Fragment key="tail">{renderInline(text.slice(last), 'tail', meHandle)}</Fragment>);
  }
  return <>{parts}</>;
}
