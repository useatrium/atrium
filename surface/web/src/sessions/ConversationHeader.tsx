import type { ReactNode } from 'react';
import { deriveSessionGlance, formatOutcome, isTerminalSessionStatus } from '@atrium/surface-client';
import { Avatar } from '../components/Avatar';
import { sessionElapsedMs } from './SessionCard';
import { GlanceChip } from './GlanceChip';
import type { Session, SessionGlanceKind } from './types';

/**
 * One step of the zoom trail — `#channel ▸ thread ▸ work`. The last crumb is
 * where you are (emphasized, inert); the rest zoom back out.
 */
export type IdentityCrumb = { label: string; onClick?: () => void };

/**
 * Who this conversation *is*, independent of how far in you've zoomed. An
 * agent-backed conversation is named by its session (glance chip · title); a
 * human thread is named by the message that started it (author · snippet).
 * The same identity renders on the feed card, in the thread, and in the pane —
 * that's what makes those three the same object at three zooms.
 */
export type ConversationIdentity =
  | {
      kind: 'session';
      /** Pass the display session — the pane overrides `status` from its stream. */
      session: Session;
      /** Caller's 1s ticker (cards/panes already run one). */
      now?: number;
      /** Live-transcript stall verdict — only the pane can know this. */
      stuck?: boolean;
      /** Rare display exception, e.g. a dead optimistic card's "spawn failed". */
      glanceOverride?: { kind: SessionGlanceKind; label: string };
      /**
       * One clock per row. A terminal card already says "Done in 4m" next
       * to the chip, so the chip drops its own clock rather than printing the
       * same duration twice.
       */
      showClock?: boolean;
    }
  | { kind: 'thread'; authorId: string; authorName: string; snippet: string };

/**
 * The identity header. ONE component, one instance per zoom state: the feed
 * card's identity row, the thread panel's header, and the session pane's
 * header are all this. Zooming in swaps the surface around it, but the row
 * itself is the same row saying the same thing in the same place — which is
 * the whole point of the spine.
 *
 * `variant='card'` is the in-feed identity row (multi-line title, meta line
 * under the body); `variant='panel'` is the pinned right-panel header (single
 * calm row + crumb line).
 */
export function ConversationHeader({
  identity,
  variant = 'panel',
  onOpenTitle,
  openTitleHint,
  hideTitle = false,
  actions,
  crumbs = [],
  crumbNote,
  meta,
  children,
  className = '',
}: {
  identity: ConversationIdentity;
  variant?: 'card' | 'panel';
  /** Title becomes a button that zooms in one level (card → thread → work). */
  onOpenTitle?: () => void;
  openTitleHint?: string;
  /**
   * Feed cards only. A session's title IS its first prompt, and on the card the
   * spawner's ask is already rendered as their own message directly above —
   * so printing it again as a title is a pure echo. The thread and the pane
   * keep the title: there, nothing sits above it and it's what names the
   * conversation. The identity is still the same object at every zoom; the card
   * just doesn't re-say what the message above it already said.
   */
  hideTitle?: boolean;
  /** Trailing controls for this zoom state (close, stop, overflow…). */
  actions?: ReactNode;
  crumbs?: IdentityCrumb[];
  /** Muted tail on the crumb line, e.g. the thread's reply count. */
  crumbNote?: ReactNode;
  /**
   * Optional identity metadata, rendered whole below the row. It is passed as
   * a NODE so callers retain control of their own layout semantics.
   */
  meta?: ReactNode;
  /** Card body between the identity row and the meta line (presence, question). */
  children?: ReactNode;
  className?: string;
}) {
  const panel = variant === 'panel';
  const title = identity.kind === 'session' ? identity.session.title : identity.authorName;
  const openerLabel =
    identity.kind === 'session'
      ? (() => {
          const terminal = isTerminalSessionStatus(identity.session.status);
          const glanceLabel =
            identity.glanceOverride?.label ?? deriveSessionGlance(identity.session, identity.now ?? Date.now()).label;
          return `${title} — ${glanceLabel}${
            terminal
              ? `, ${formatOutcome(identity.session.status, Math.max(0, sessionElapsedMs(identity.session, identity.now ?? Date.now())))}`
              : ''
          }`;
        })()
      : undefined;
  // In a panel the identity IS the region's heading (screen readers and the
  // e2e suite both navigate by it); on a card it's a row in the feed, not a
  // document landmark.
  const titleClass = panel
    ? 'min-w-0 truncate text-left'
    : 'min-w-0 flex-1 whitespace-pre-wrap break-words text-left text-sm font-medium leading-snug text-fg';
  const titleNode = onOpenTitle ? (
    <button
      type="button"
      data-testid="conversation-title"
      onClick={onOpenTitle}
      title={openTitleHint ?? title}
      className={`${titleClass} hover:underline focus-visible:underline`}
    >
      {title}
    </button>
  ) : (
    <span data-testid="conversation-title" className={titleClass} title={panel ? title : undefined}>
      {title}
    </span>
  );

  // With the title hidden the chip inherits its job as the row's keyboard path
  // into the conversation — otherwise suppressing the title would silently take
  // the only focusable "open" affordance off the card.
  const chipNode =
    identity.kind === 'session' ? (
      <GlanceChip
        session={identity.session}
        now={identity.now}
        stuck={identity.stuck}
        override={identity.glanceOverride}
        {...(identity.showClock === false ? { showClock: false } : {})}
      />
    ) : null;
  const chip =
    hideTitle && onOpenTitle && chipNode ? (
      <button
        type="button"
        data-testid="conversation-title"
        onClick={onOpenTitle}
        aria-label={openTitleHint ?? openerLabel}
        className="rounded-full focus-visible:underline"
      >
        {chipNode}
      </button>
    ) : (
      chipNode
    );

  const Container = panel ? 'header' : 'div';

  return (
    // `data-zoom-anchor` holds this row still while the panel around it expands
    // (see `.pane-zoom-in` in index.css) — the identity is what does NOT change
    // when you zoom in.
    <Container
      data-testid={panel ? 'conversation-header' : undefined}
      data-zoom-anchor={panel ? '' : undefined}
      className={panel ? 'shrink-0 border-b border-edge bg-surface' : ''}
    >
      <div
        className={
          panel
            ? `flex h-12 items-center gap-2 px-3 max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:gap-1 max-md:px-2 max-md:py-1.5 ${className}`
            : `flex items-start gap-2 ${className}`
        }
      >
        {identity.kind === 'session' ? chip : <Avatar name={identity.authorName} seed={identity.authorId} size={20} />}
        {hideTitle ? null : panel ? (
          <h2 className="flex min-w-0 flex-1 items-center text-sm font-semibold text-fg">{titleNode}</h2>
        ) : (
          titleNode
        )}
        {identity.kind === 'thread' && (
          <span className="min-w-0 flex-[2] truncate text-xs text-fg-muted max-md:hidden" title={identity.snippet}>
            {identity.snippet}
          </span>
        )}
        {actions}
      </div>

      {children}

      {(crumbs.length > 0 || crumbNote != null) && (
        <nav
          aria-label="Zoom level"
          data-testid="conversation-crumb"
          className="flex h-6 shrink-0 items-center gap-1 border-t border-edge bg-surface-overlay/60 px-3 text-3xs text-fg-muted"
        >
          {crumbs.map((crumb, i) => (
            <span key={crumb.label} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span aria-hidden>▸</span>}
              {crumb.onClick ? (
                <button
                  type="button"
                  onClick={crumb.onClick}
                  className="max-w-40 truncate hover:text-fg-body hover:underline"
                >
                  {crumb.label}
                </button>
              ) : (
                <span aria-current="page" className="truncate font-semibold text-fg-secondary">
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
          {crumbNote != null && (
            <span className="truncate">
              {crumbs.length > 0 && <span className="mr-1 text-fg-faint">·</span>}
              {crumbNote}
            </span>
          )}
        </nav>
      )}

      {meta}
    </Container>
  );
}
