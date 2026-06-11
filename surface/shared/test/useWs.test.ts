import { describe, expect, it, vi } from 'vitest';
import {
  createWsSequenceTracker,
  handleWsFrameSequence,
  resetWsSequenceTracker,
} from '../src/useWs';

describe('websocket sequence tracking', () => {
  it('fires the gap callback when a frame skips ahead', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    handleWsFrameSequence(tracker, { seq: 1 }, onGap);
    handleWsFrameSequence(tracker, { seq: 3 }, onGap);
    handleWsFrameSequence(tracker, { seq: 4 }, onGap);

    expect(onGap).toHaveBeenCalledTimes(1);
  });

  it('does not fire on contiguous frames', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    handleWsFrameSequence(tracker, { seq: 1 }, onGap);
    handleWsFrameSequence(tracker, { seq: 2 }, onGap);
    handleWsFrameSequence(tracker, { seq: 3 }, onGap);

    expect(onGap).not.toHaveBeenCalled();
  });

  it('resets expected sequence on reconnect', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    handleWsFrameSequence(tracker, { seq: 1 }, onGap);
    handleWsFrameSequence(tracker, { seq: 2 }, onGap);
    resetWsSequenceTracker(tracker);
    handleWsFrameSequence(tracker, { seq: 1 }, onGap);

    expect(onGap).not.toHaveBeenCalled();
  });

  it('disables gap detection for unstamped server frames', () => {
    const tracker = createWsSequenceTracker();
    const onGap = vi.fn();

    handleWsFrameSequence(tracker, {}, onGap);
    handleWsFrameSequence(tracker, { seq: 10 }, onGap);

    expect(onGap).not.toHaveBeenCalled();
  });
});
