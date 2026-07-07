import { useMemo, useState } from 'react';
import {
  containsCriticMarkup,
  parseCriticMarkup,
  parseMarkupSteer,
  type ParsedMarkupSteer,
} from '@atrium/surface-client';
import { CriticMarkupView } from './CriticMarkupView';
import { MessageText } from './MessageText';

function RawToggle({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        className="rounded border border-edge bg-surface-raised px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-fg-muted hover:border-edge-hover hover:text-fg"
        onClick={() => setShowRaw((value) => !value)}
        aria-expanded={showRaw}
      >
        {showRaw ? 'hide raw' : 'view raw'}
      </button>
      {showRaw && (
        <pre className="mt-2 whitespace-pre-wrap rounded-md border border-edge bg-surface-raised p-2 font-mono text-2xs leading-relaxed text-fg-body">
          {text}
        </pre>
      )}
    </div>
  );
}

function SteerHeader({ steer }: { steer: ParsedMarkupSteer }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
      <div className="min-w-0 flex-1 text-sm font-semibold text-fg">
        {steer.intent === 'response' ? (
          <>Marked up &quot;{steer.title ?? 'Untitled'}&quot;</>
        ) : (
          <>
            Marked up <code className="font-mono text-xs text-fg-body">{steer.path}</code>
          </>
        )}
      </div>
      <span className="rounded border border-warning-border bg-warning-tint px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-warning-text-strong">
        markup
      </span>
    </div>
  );
}

function MarkupSteerBody({ steer }: { steer: ParsedMarkupSteer }) {
  const blocks = useMemo(() => parseCriticMarkup(steer.doc), [steer.doc]);
  return (
    <div className="space-y-2 px-3 py-2.5">
      <CriticMarkupView blocks={blocks} />
      {steer.truncated && (
        <div className="rounded-md border border-edge bg-surface-raised px-2.5 py-1.5 text-2xs text-fg-muted">
          Excerpt of <code className="font-mono text-fg-secondary">{steer.path ?? 'document'}</code> — full document in Files
        </div>
      )}
      {steer.note && (
        <div className="rounded-md border border-edge bg-surface-raised px-2.5 py-1.5 text-2xs">
          <span className="mr-2 font-semibold text-fg-secondary">Note</span>
          <span className="whitespace-pre-wrap text-fg-body">{steer.note}</span>
        </div>
      )}
      {steer.conflict && (
        <div className="rounded-md border border-warning-border bg-warning-tint px-2.5 py-1.5 text-2xs font-medium text-warning-text-strong">
          Conflict recorded against a newer version. Inspect the file conflict before producing the clean revision.
        </div>
      )}
    </div>
  );
}

export function MarkupSteerCard({ text }: { text: string }) {
  const steer = useMemo(() => parseMarkupSteer(text), [text]);
  const hasMarkup = useMemo(() => containsCriticMarkup(text), [text]);

  if (steer) {
    return (
      <div className="overflow-hidden rounded-md border border-edge bg-surface text-sm shadow-sm">
        <SteerHeader steer={steer} />
        <MarkupSteerBody steer={steer} />
        <div className="border-t border-edge px-3 py-2">
          <RawToggle text={text} />
        </div>
      </div>
    );
  }

  if (hasMarkup) {
    return (
      <div className="text-sm leading-relaxed text-fg-body">
        <CriticMarkupView text={text} />
        <RawToggle text={text} />
      </div>
    );
  }

  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg-body">
      <MessageText text={text} />
    </div>
  );
}
