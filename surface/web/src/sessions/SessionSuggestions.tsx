import { useState } from 'react';
import { randomId } from '@atrium/surface-client';
import { ApiError } from '../api';
import { sessionsApi } from './api';
import type { SessionSuggestion } from './types';

/**
 * The suggestion queue: one quiet grouped object above the composer. Visible to
 * everyone (the queue teaches good steers); only the driver gets the Send /
 * Edit / Dismiss actions. Send is an outline button — blue stays scarce.
 */
export function SuggestionStrip({
  sessionId,
  suggestions,
  isDriver,
  nameFor,
  onActionError = () => {},
}: {
  sessionId: string;
  suggestions: SessionSuggestion[];
  isDriver: boolean;
  nameFor: (id: string | null) => string;
  onActionError?: (err: unknown) => void;
}) {
  return (
    <div
      data-testid="suggestion-strip"
      className="shrink-0 border-t border-edge bg-surface-raised/40 px-3 py-2"
    >
      <div className="mb-1.5 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
        Suggestions · {suggestions.length}
      </div>
      <div className="space-y-2">
        {suggestions.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            sessionId={sessionId}
            suggestion={suggestion}
            isDriver={isDriver}
            authorName={suggestion.authorName ?? nameFor(suggestion.authorId)}
            onActionError={onActionError}
          />
        ))}
      </div>
    </div>
  );
}

function SuggestionRow({
  sessionId,
  suggestion,
  isDriver,
  authorName,
  onActionError,
}: {
  sessionId: string;
  suggestion: SessionSuggestion;
  isDriver: boolean;
  authorName: string;
  onActionError: (err: unknown) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'editing' | 'dismissing'>('idle');
  const [draft, setDraft] = useState(suggestion.text);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switch sub-modes and drop any prior resolve error — it no longer describes
  // the visible state.
  const switchMode = (next: 'idle' | 'editing' | 'dismissing') => {
    setMode(next);
    setError(null);
  };

  // On success the row leaves the pending queue and unmounts; reset `busy`
  // either way (via finally) so a dropped/missed resolve event can't strand the
  // row disabled with no way to retry.
  const resolve = (action: 'send' | 'dismiss', opts: { text?: string; note?: string } = {}) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    sessionsApi
      .resolveSuggestion(sessionId, suggestion.id, action, opts, randomId())
      .catch((err: unknown) => {
        onActionError(err);
        const fallback = action === 'send' ? "Couldn't send — try again." : "Couldn't dismiss — try again.";
        setError(err instanceof ApiError && err.message ? err.message : fallback);
      })
      .finally(() => setBusy(false));
  };

  const outlineBtn =
    'rounded border border-edge-strong px-2 py-0.5 text-2xs font-medium text-fg-body hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-50';
  const quietBtn =
    'rounded px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body';

  return (
    <div data-testid="suggestion-row" className="text-xs">
      <div className="leading-relaxed">
        <span className="font-semibold text-fg">{authorName}</span>{' '}
        {mode !== 'editing' && (
          <span className="whitespace-pre-wrap break-words text-fg-body">{suggestion.text}</span>
        )}
      </div>

      {mode === 'editing' ? (
        <div className="mt-1 space-y-1">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            aria-label="Edit suggestion"
            className="w-full resize-none rounded-md border border-edge-strong bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-edge-focus"
          />
          <div className="flex items-center gap-2">
            <button
              disabled={busy || draft.trim().length === 0}
              onClick={() => resolve('send', { text: draft })}
              className={outlineBtn}
            >
              Send edited
            </button>
            <button
              onClick={() => {
                switchMode('idle');
                setDraft(suggestion.text);
              }}
              className={quietBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : mode === 'dismissing' ? (
        <div className="mt-1 space-y-1">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="why? (optional)"
            aria-label="Dismiss reason"
            className="w-full rounded-md border border-edge-strong bg-surface px-2 py-1 text-2xs text-fg outline-none focus:border-edge-focus"
          />
          <div className="flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() => resolve('dismiss', note.trim() ? { note: note.trim() } : {})}
              className={outlineBtn}
            >
              Dismiss
            </button>
            <button
              onClick={() => {
                switchMode('idle');
                setNote('');
              }}
              className={quietBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : isDriver ? (
        <div className="mt-0.5 flex items-center gap-2">
          <button disabled={busy} onClick={() => resolve('send')} className={outlineBtn}>
            Send
          </button>
          <button onClick={() => switchMode('editing')} className={quietBtn}>
            Edit
          </button>
          <button onClick={() => switchMode('dismissing')} className={quietBtn}>
            Dismiss
          </button>
        </div>
      ) : null}

      {error && (
        <div role="alert" className="mt-0.5 text-2xs text-danger-text">
          {error}
        </div>
      )}
    </div>
  );
}
