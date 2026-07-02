import { describe, expect, it, vi } from 'vitest';
import { FilesChangedDebouncer, type FilesChangedTimerApi } from '../src/files-nudge.js';

class FakeTimers implements FilesChangedTimerApi {
  private nextId = 1;
  private nowMs = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  advanceBy(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId == null || nextAt > target) break;
      this.nowMs = nextAt;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      timer?.callback();
    }
    this.nowMs = target;
  }
}

function debouncer(publish: (event: unknown) => void) {
  const timers = new FakeTimers();
  return { timers, debouncer: new FilesChangedDebouncer({ publish, timers }) };
}

describe('FilesChangedDebouncer', () => {
  it('coalesces a burst for one workspace into one publish after the window', async () => {
    const publish = vi.fn();
    const setup = debouncer(publish);

    for (let i = 0; i < 5; i++) setup.debouncer.nudge('ws-1');
    setup.timers.advanceBy(999);
    expect(publish).not.toHaveBeenCalled();

    setup.timers.advanceBy(1);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      type: 'files.changed',
      workspaceId: 'ws-1',
      channelId: null,
      payload: { workspaceId: 'ws-1' },
    });
  });

  it('publishes once per workspace in the same debounce window', async () => {
    const publish = vi.fn();
    const setup = debouncer(publish);

    setup.debouncer.nudge('ws-1');
    setup.debouncer.nudge('ws-2');
    setup.debouncer.nudge('ws-1');

    setup.timers.advanceBy(1000);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map(([event]) => event.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
  });

  it('does nothing while quiet', async () => {
    const publish = vi.fn();
    const setup = debouncer(publish);

    setup.timers.advanceBy(5000);
    expect(publish).not.toHaveBeenCalled();
  });

  it('starts a fresh timer for a second burst after the first fires', async () => {
    const publish = vi.fn();
    const setup = debouncer(publish);

    setup.debouncer.nudge('ws-1');
    setup.timers.advanceBy(1000);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);

    setup.debouncer.nudge('ws-1');
    setup.debouncer.nudge('ws-1');
    setup.timers.advanceBy(999);
    expect(publish).toHaveBeenCalledTimes(1);

    setup.timers.advanceBy(1);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
