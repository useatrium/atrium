import { Fragment, type ReactNode } from 'react';
import { tokenizeMessage, type Segment } from '@atrium/surface-client';
import { extractEntryHandles } from '../lib/entryLinks';
import { EntryQuoteCards } from './EntryQuoteCard';

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
          className="rounded bg-surface-overlay/80 px-1 py-px font-mono text-[0.85em] text-code/90"
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
          className="text-accent-text hover:underline"
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
              ? 'rounded bg-warning-hover/20 px-0.5 font-medium text-warning-text'
              : 'rounded bg-accent-hover/10 px-0.5 text-accent-text-strong'
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
          className="my-1 overflow-x-auto rounded-md border border-edge bg-surface-raised/70 px-3 py-2 font-mono text-xs leading-relaxed text-fg-secondary"
        >
          {segment.code}
        </pre>
      );
  }
}

export function MessageText({ text, meHandle }: { text: string; meHandle?: string }) {
  const entryHandles = extractEntryHandles(text).slice(0, 3);

  return (
    <>
      {tokenizeMessage(text).map((segment, i) => renderSegment(segment, `s${i}`, meHandle))}
      <EntryQuoteCards handles={entryHandles} />
    </>
  );
}
