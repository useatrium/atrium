// Frame-gap observability for the Centaur event mirror (addressable-entries H1).
//
// OBSERVABILITY ONLY — no behavior change to the live tail.
//
// A 2026-06-24 hand-compute established that the raw mirror (`session_events`) is
// loss-free on the Atrium side by construction: `mirrorFrame` runs before both the
// batched cursor flush and `foldFrame`'s GREATEST writes, so the resume cursor can
// never advance past an un-mirrored frame. Therefore a gap in `centaur_event_id`
// can only originate Centaur-side — eviction beyond the resume point, or sparse ids
// by design — and reconnect-refill can't recover the eviction case.
//
// So before building any refill/alarm/hole-marker behavior (which the plan defers
// until Centaur's id-contiguity semantics are confirmed), this instrument simply
// DETECTS and COUNTS gaps and late frames. The counts tell us, from real data,
// whether ids are actually contiguous and whether real loss ever occurs.

export type FrameOrder = 'ok' | 'gap' | 'late';

/**
 * Classify a frame's `event_id` against the next expected id.
 * `expected === null` means no baseline yet (first frame of a fresh session),
 * which is always `ok`.
 */
export function classifyFrameOrder(expected: number | null, eventId: number): FrameOrder {
  if (expected === null) return 'ok';
  if (eventId > expected) return 'gap';
  if (eventId < expected) return 'late';
  return 'ok';
}

export interface FrameGapStats {
  /** Forward jumps observed (a frame whose id skipped past the expected one). */
  gapCount: number;
  /** Frames at or below an already-passed id (should be ~never given mirror dedup). */
  lateCount: number;
  /** Sum of skipped ids across all gaps — the count of potentially-missing frames. */
  missingTotal: number;
  /** event_id at which the most recent gap was observed. */
  lastGapAt: number | null;
}

const stats = new Map<string, FrameGapStats>();

function ensure(sessionId: string): FrameGapStats {
  let s = stats.get(sessionId);
  if (!s) {
    s = { gapCount: 0, lateCount: 0, missingTotal: 0, lastGapAt: null };
    stats.set(sessionId, s);
  }
  return s;
}

/**
 * Record one frame observation against the expected id. Returns the classified
 * order plus `firstOfKind` — true the first time a gap (or late frame) is seen for
 * this session — so the caller can log once and avoid unbounded warn-spam if a
 * stream turns out to be persistently non-contiguous.
 */
export function recordFrameObservation(
  sessionId: string,
  expected: number | null,
  eventId: number,
): { order: FrameOrder; firstOfKind: boolean } {
  const order = classifyFrameOrder(expected, eventId);
  if (order === 'ok') return { order, firstOfKind: false };

  const s = ensure(sessionId);
  if (order === 'gap') {
    const firstOfKind = s.gapCount === 0;
    s.gapCount += 1;
    s.missingTotal += eventId - (expected as number);
    s.lastGapAt = eventId;
    return { order, firstOfKind };
  }

  const firstOfKind = s.lateCount === 0;
  s.lateCount += 1;
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
