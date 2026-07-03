// Frame-order observability for the Centaur event mirror (addressable-entries H1).
//
// OBSERVABILITY ONLY — no behavior change to the live tail.
//
// Centaur's `event_id` is a global identity in its `session_events` table, then
// filtered by `thread_key` for a session stream. Therefore per-session event ids
// are replay watermarks, not contiguous sequence numbers: a healthy thread can
// observe ids like 10, 14, 22 when other threads wrote 11-13 and 15-21.
//
// The raw mirror (`session_events`) is loss-free on the Atrium side by
// construction: `mirrorFrame` runs before both the batched cursor flush and
// `foldFrame`'s GREATEST writes, so the resume cursor can never advance past an
// un-mirrored frame. A true per-session gap signal needs a separate Centaur wire
// field such as `thread_event_seq`; do not infer it from `event_id`.

export type FrameOrder = 'ok' | 'late';

/**
 * Classify a frame's `event_id` against the next high watermark.
 * `expected === null` means no baseline yet (first frame of a fresh session),
 * which is always `ok`. Forward jumps are also `ok` because `event_id` is a
 * global replay watermark, not a session-local sequence.
 */
export function classifyFrameOrder(expected: number | null, eventId: number): FrameOrder {
  if (expected === null) return 'ok';
  if (eventId < expected) return 'late';
  return 'ok';
}

export interface FrameGapStats {
  /** Frames at or below an already-passed id (should be ~never given mirror dedup). */
  lateCount: number;
  /** event_id at which the most recent late frame was observed. */
  lastLateAt: number | null;
}

const stats = new Map<string, FrameGapStats>();

function ensure(sessionId: string): FrameGapStats {
  let s = stats.get(sessionId);
  if (!s) {
    s = { lateCount: 0, lastLateAt: null };
    stats.set(sessionId, s);
  }
  return s;
}

/**
 * Record one frame observation against the expected id. Returns the classified
 * order plus `firstOfKind` — true the first time a late frame is seen for this
 * session — so the caller can log once and avoid unbounded warn-spam.
 */
export function recordFrameObservation(
  sessionId: string,
  expected: number | null,
  eventId: number,
): { order: FrameOrder; firstOfKind: boolean } {
  const order = classifyFrameOrder(expected, eventId);
  if (order === 'ok') return { order, firstOfKind: false };

  const s = ensure(sessionId);
  const firstOfKind = s.lateCount === 0;
  s.lateCount += 1;
  s.lastLateAt = eventId;
  return { order, firstOfKind };
}

export function getFrameGapStats(sessionId: string): FrameGapStats | undefined {
  return stats.get(sessionId);
}

/** Test/maintenance hook — clear one session's stats, or all when omitted. */
export function resetFrameGapStats(sessionId?: string): void {
  if (sessionId === undefined) stats.clear();
  else stats.delete(sessionId);
}
