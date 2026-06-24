// Frame-gap observability classifier + stats. Pure unit test — no DB, no tailer.

import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyFrameOrder,
  getFrameGapStats,
  recordFrameObservation,
  resetFrameGapStats,
} from '../src/frame-gap.js';

afterEach(() => resetFrameGapStats());

describe('classifyFrameOrder', () => {
  it('is ok with no baseline', () => {
    expect(classifyFrameOrder(null, 999)).toBe('ok');
  });
  it('is ok when the id matches expected', () => {
    expect(classifyFrameOrder(5, 5)).toBe('ok');
  });
  it('flags a forward jump as a gap', () => {
    expect(classifyFrameOrder(5, 8)).toBe('gap');
  });
  it('flags a backward id as late', () => {
    expect(classifyFrameOrder(5, 3)).toBe('late');
  });
});

describe('recordFrameObservation', () => {
  it('counts a contiguous stream as zero gaps', () => {
    // first frame establishes baseline (expected null), then 2,3,4 are contiguous
    let expected: number | null = null;
    for (const id of [1, 2, 3, 4]) {
      recordFrameObservation('s1', expected, id);
      expected = Math.max(expected ?? 0, id + 1);
    }
    expect(getFrameGapStats('s1')).toBeUndefined(); // never created — no anomalies
  });

  it('counts a gap and accumulates the missing total', () => {
    // baseline 1 -> expected 2; receive 5 => gap of 3 (ids 2,3,4 skipped)
    recordFrameObservation('s2', null, 1); // baseline
    const r = recordFrameObservation('s2', 2, 5);
    expect(r.order).toBe('gap');
    expect(r.firstOfKind).toBe(true);
    const stats = getFrameGapStats('s2')!;
    expect(stats.gapCount).toBe(1);
    expect(stats.missingTotal).toBe(3);
    expect(stats.lastGapAt).toBe(5);
  });

  it('marks only the first gap as firstOfKind', () => {
    recordFrameObservation('s3', 2, 5); // gap 1 (firstOfKind true)
    const second = recordFrameObservation('s3', 6, 9); // gap 2
    expect(second.firstOfKind).toBe(false);
    expect(getFrameGapStats('s3')!.gapCount).toBe(2);
    expect(getFrameGapStats('s3')!.missingTotal).toBe(3 + 3);
  });

  it('counts late frames separately', () => {
    const r = recordFrameObservation('s4', 10, 7);
    expect(r.order).toBe('late');
    expect(getFrameGapStats('s4')!.lateCount).toBe(1);
    expect(getFrameGapStats('s4')!.gapCount).toBe(0);
  });

  it('isolates stats per session and resets', () => {
    recordFrameObservation('a', 2, 5);
    recordFrameObservation('b', 2, 9);
    expect(getFrameGapStats('a')!.missingTotal).toBe(3);
    expect(getFrameGapStats('b')!.missingTotal).toBe(7);
    resetFrameGapStats('a');
    expect(getFrameGapStats('a')).toBeUndefined();
    expect(getFrameGapStats('b')).toBeDefined();
  });
});
