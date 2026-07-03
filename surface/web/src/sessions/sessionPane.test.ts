import { describe, expect, it, vi } from 'vitest';
import {
  notifyUnseenOutputsChange,
  seenOutputCountsAfterOpeningTab,
  unseenOutputsForCounts,
} from './SessionPane';

const zeroCounts = {
  conflicts: 0,
  changes: 0,
  sideEffects: 0,
  artifacts: 0,
};

describe('SessionPane unseen output tracking', () => {
  it('marks growing closed strips unseen, clears when opened, then marks new growth unseen again', () => {
    let seen = zeroCounts;

    const firstGrowth = { ...zeroCounts, changes: 1 };
    expect(unseenOutputsForCounts(seen, firstGrowth, null)).toMatchObject({ changes: true });

    seen = seenOutputCountsAfterOpeningTab(seen, firstGrowth, 'changes');
    expect(unseenOutputsForCounts(seen, firstGrowth, 'changes')).toMatchObject({
      changes: false,
      artifacts: false,
    });

    const whileOpenGrowth = { ...firstGrowth, changes: 2, artifacts: 1 };
    seen = seenOutputCountsAfterOpeningTab(seen, whileOpenGrowth, 'changes');
    expect(unseenOutputsForCounts(seen, whileOpenGrowth, 'changes')).toMatchObject({
      changes: false,
      artifacts: false,
    });

    expect(unseenOutputsForCounts(seen, whileOpenGrowth, null)).toMatchObject({
      changes: false,
      artifacts: false,
    });

    const secondGrowth = { ...whileOpenGrowth, changes: 3 };
    expect(unseenOutputsForCounts(seen, secondGrowth, null)).toMatchObject({
      changes: true,
      artifacts: false,
    });
  });

  it('dedupes unseen callback notifications', () => {
    const onUnseenOutputs = vi.fn();
    let last: boolean | null = null;

    last = notifyUnseenOutputsChange(last, false, onUnseenOutputs);
    last = notifyUnseenOutputsChange(last, false, onUnseenOutputs);
    last = notifyUnseenOutputsChange(last, true, onUnseenOutputs);
    last = notifyUnseenOutputsChange(last, true, onUnseenOutputs);
    last = notifyUnseenOutputsChange(last, false, onUnseenOutputs);

    expect(last).toBe(false);
    expect(onUnseenOutputs).toHaveBeenCalledTimes(3);
    expect(onUnseenOutputs.mock.calls.map(([value]) => value)).toEqual([false, true, false]);
  });
});
