import { useEffect, useRef } from 'react';
import { formatCost, formatElapsed } from './types';

/** A small CSS spinner, accent-colored via `currentColor`. Used for the
 *  turn status line and per-tool "running" state. */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`}
    />
  );
}

export type TurnPhase = 'thinking' | 'tool' | 'waiting' | 'done';

/** How alive the turn actually is, judged from the stream (not assumed):
 *  - live: frames are arriving (or silence is expected, e.g. a tool is running)
 *  - quiet: thinking-phase silence past ~30s — suspicious but not alarming
 *  - stuck: thinking-phase silence past ~5m — offer the exit
 *  - reconnecting: our SSE to the server is down
 *  - reattaching: the server lost the sandbox stdout pipe and is re-attaching
 */
export type TurnLiveness = 'live' | 'quiet' | 'stuck' | 'reconnecting' | 'reattaching';

/**
 * Event-driven heartbeat: blips when `pulse` changes (a real frame arrived),
 * parks as a hollow ring while the stream is silent. Honest by construction —
 * unlike a spinner, nothing here animates on a timer, so a dead agent
 * literally stops moving. Blips are floored at ~4/s so dense delta streams
 * read as a heartbeat, not a strobe.
 */
function HeartbeatDot({ pulse, parked }: { pulse: number; parked: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const lastBlipRef = useRef(0);
  useEffect(() => {
    if (parked) return;
    const nowMs = performance.now();
    if (nowMs - lastBlipRef.current < 250) return;
    lastBlipRef.current = nowMs;
    const el = ref.current;
    if (!el) return;
    el.classList.remove('heartbeat-blip');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('heartbeat-blip');
  }, [pulse, parked]);
  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="heartbeat-dot"
      data-parked={parked || undefined}
      className={`size-2 shrink-0 rounded-full ${
        parked ? 'border-[1.5px] border-fg-faint bg-transparent' : 'bg-accent-text-strong'
      }`}
    />
  );
}

/**
 * One subtle status line pinned above the composer — the turn's meta, updating
 * in place (running → done) like the Claude/Codex CLIs, NOT a transcript entry.
 * Every element is a claim backed by the stream: the dot pulses on real frames,
 * the label carries the model's own narration when fresh, and the clock is
 * anchored to server-stamped frame times (so it survives reloads and reads the
 * same for every viewer). Harness-agnostic.
 */
export function TurnStatusLine({
  phase,
  liveness,
  label,
  elapsedMs,
  quietMs,
  pulse,
  tokens,
  costUsd,
  models,
  cancelLabel,
  onCancel,
}: {
  phase: TurnPhase;
  liveness: TurnLiveness;
  label: string;
  elapsedMs: number;
  /** Time since the stream last spoke; only meaningful for quiet/stuck. */
  quietMs: number;
  /** Monotonic frame counter; each change is one heartbeat blip. */
  pulse: number;
  /** Output tokens so far. The ticking number is a liveness instrument — it
   * freezing mid-thinking corroborates the quiet state. `estimated` (streamed
   * chars ÷ 4, for harnesses that never report usage) renders with ≈. */
  tokens?: { count: number; estimated: boolean } | null;
  costUsd: number;
  models: string[];
  cancelLabel?: string;
  onCancel?: () => void;
}) {
  const active = phase === 'thinking' || phase === 'tool';
  const showMeta = Boolean(tokens) || costUsd > 0 || models.length > 0;
  const clock = elapsedMs >= 1000 && (
    <span className="tabular-nums text-fg-faint">{formatElapsed(elapsedMs)}</span>
  );
  return (
    <div
      data-testid="turn-status"
      data-liveness={active ? liveness : undefined}
      className="flex shrink-0 items-center gap-2 border-t border-edge px-3.5 py-1.5 text-2xs text-fg-muted"
    >
      {!active ? (
        phase === 'waiting' ? (
          <span className="font-medium">{label}</span>
        ) : (
          <>
            <span className="font-medium text-fg-secondary">✓ {label}</span>
            {clock}
          </>
        )
      ) : liveness === 'reconnecting' || liveness === 'reattaching' ? (
        <>
          <Spinner className="text-warning-text" />
          <span className="font-medium text-warning-text">
            {liveness === 'reconnecting' ? 'Reconnecting…' : 'Reattaching to sandbox…'}
          </span>
          {clock}
        </>
      ) : liveness === 'stuck' ? (
        <>
          <HeartbeatDot pulse={pulse} parked />
          <span className="font-medium">
            Still working? No output for {formatElapsed(quietMs)}
          </span>
          {onCancel && (
            <button
              onClick={onCancel}
              className="font-medium text-accent-text hover:text-accent-text-strong"
            >
              {cancelLabel ?? 'Cancel'}
            </button>
          )}
          {clock}
        </>
      ) : liveness === 'quiet' ? (
        <>
          <HeartbeatDot pulse={pulse} parked />
          <span className="font-medium">{label}</span>
          <span className="text-fg-faint">— quiet for {formatElapsed(quietMs)}</span>
          {clock}
        </>
      ) : (
        <>
          <HeartbeatDot pulse={pulse} parked={false} />
          <span className="min-w-0 truncate font-medium text-accent-text-strong">{label}…</span>
          {clock}
        </>
      )}
      {showMeta && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-fg-faint">
          {tokens && (
            <span data-testid="token-count">
              {tokens.estimated ? '≈' : ''}
              {tokens.count.toLocaleString('en-US')} tok
            </span>
          )}
          {tokens && (costUsd > 0 || models.length > 0) && <span>·</span>}
          {costUsd > 0 && <span>{formatCost(costUsd)}</span>}
          {costUsd > 0 && models.length > 0 && <span>·</span>}
          {models.length > 0 && <span>{models.join(', ')}</span>}
        </span>
      )}
    </div>
  );
}
