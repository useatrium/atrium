// Frame-order observability classifier + stats. Pure unit test — no DB, no tailer.

import { afterEach, describe, expect, it } from 'vitest';
import { classifyFrameOrder, getFrameGapStats, recordFrameObservation, resetFrameGapStats } from '../src/frame-gap.js';

afterEach(() => resetFrameGapStats());

describe('classifyFrameOrder', () => {
  it('is ok with no baseline', () => {
    expect(classifyFrameOrder(null, 999)).toBe('ok');
  });
  it('is ok when the id matches expected', () => {
    expect(classifyFrameOrder(5, 5)).toBe('ok');
  });
  it('treats a forward jump as ok because event ids are global watermarks', () => {
    expect(classifyFrameOrder(5, 8)).toBe('ok');
  });
  it('flags a backward id as late', () => {
    expect(classifyFrameOrder(5, 3)).toBe('late');
  });
});

describe('recordFrameObservation', () => {
  it('counts a contiguous stream as zero anomalies', () => {
    // first frame establishes baseline (expected null), then 2,3,4 are contiguous
    let expected: number | null = null;
    for (const id of [1, 2, 3, 4]) {
      recordFrameObservation('s1', expected, id);
      expected = Math.max(expected ?? 0, id + 1);
    }
    expect(getFrameGapStats('s1')).toBeUndefined(); // never created — no anomalies
  });

  it('does not count sparse global event ids as missing session frames', () => {
    recordFrameObservation('s2', null, 1); // baseline
    const r = recordFrameObservation('s2', 2, 5);
    expect(r.order).toBe('ok');
    expect(r.firstOfKind).toBe(false);
    expect(getFrameGapStats('s2')).toBeUndefined();
  });

  it('marks only the first late frame as firstOfKind', () => {
    recordFrameObservation('s3', 10, 5); // late 1 (firstOfKind true)
    const second = recordFrameObservation('s3', 10, 4); // late 2
    expect(second.firstOfKind).toBe(false);
    expect(getFrameGapStats('s3')!.lateCount).toBe(2);
    expect(getFrameGapStats('s3')!.lastLateAt).toBe(4);
  });

  it('counts late frames separately', () => {
    const r = recordFrameObservation('s4', 10, 7);
    expect(r.order).toBe('late');
    expect(getFrameGapStats('s4')!.lateCount).toBe(1);
    expect(getFrameGapStats('s4')!.lastLateAt).toBe(7);
  });

  it('isolates stats per session and resets', () => {
    recordFrameObservation('a', 10, 5);
    recordFrameObservation('b', 10, 9);
    expect(getFrameGapStats('a')!.lastLateAt).toBe(5);
    expect(getFrameGapStats('b')!.lastLateAt).toBe(9);
    resetFrameGapStats('a');
    expect(getFrameGapStats('a')).toBeUndefined();
    expect(getFrameGapStats('b')).toBeDefined();
  });
});
