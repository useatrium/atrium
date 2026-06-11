import { Fragment, type ReactNode } from 'react';
import { tokenizeMessage, type Segment } from '@atrium/surface-client';

// Minimal message formatting for an engineering team: fenced code blocks,
// `inline code`, and clickable links. Everything else stays plain text —
// React escaping keeps it XSS-safe by construction.

function renderSegment(segment: Segment, key: string, meHandle?: string): ReactNode {
  switch (segment.kind) {
    case 'text':
      return <Fragment key={key}>{segment.text}</Fragment>;
    case 'code':
      return (
        <code
          key={key}
          className="rounded bg-zinc-800/80 px-1 py-px font-mono text-[0.85em] text-rose-300/90"
        >
          {segment.code}
        </code>
      );
    case 'link':
      return (
        <a
          key={key}
          href={segment.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 hover:underline"
        >
          {segment.href}
        </a>
      );
    case 'mention': {
      const isMe = meHandle != null && segment.handle.toLowerCase() === meHandle.toLowerCase();
      return (
        <span
          key={key}
          className={
            isMe
              ? 'rounded bg-amber-400/20 px-0.5 font-medium text-amber-200'
              : 'rounded bg-indigo-500/10 px-0.5 text-indigo-300'
          }
        >
          @{segment.handle}
        </span>
      );
    }
    case 'codeblock':
      return (
        <pre
          key={key}
          className="my-1 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2 font-mono text-[12px] leading-relaxed text-zinc-300"
        >
          {segment.code}
        </pre>
      );
  }
}

export function MessageText({ text, meHandle }: { text: string; meHandle?: string }) {
  return (
    <>{tokenizeMessage(text).map((segment, i) => renderSegment(segment, `s${i}`, meHandle))}</>
  );
}
