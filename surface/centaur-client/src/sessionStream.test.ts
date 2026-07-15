import { describe, expect, it } from 'vitest';
import {
  createSessionStreamMachine,
  type SessionStreamCallbacks,
  type SessionStreamHandle,
  type SessionStreamScheduler,
  type SessionStreamTransport,
} from './sessionStream.js';
import type { CentaurEventFrame } from './types.js';

class FakeScheduler implements SessionStreamScheduler {
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; interval: number | null; callback: () => void }>();
  private readonly flushes = new Map<number, () => void>();
  private time = 0;

  now(): number {
    return this.time;
  }

  schedule(delayMs: number, callback: () => void): () => void {
    return this.addTimer(delayMs, null, callback);
  }

  repeat(intervalMs: number, callback: () => void): () => void {
    return this.addTimer(intervalMs, intervalMs, callback);
  }

  scheduleFlush(callback: () => void): () => void {
    const id = this.nextId++;
    this.flushes.set(id, callback);
    return () => this.flushes.delete(id);
  }

  flush(): void {
    const callbacks = [...this.flushes.values()];
    this.flushes.clear();
    for (const callback of callbacks) callback();
  }

  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.time = timer.at;
      if (timer.interval === null) {
        this.timers.delete(id);
      } else {
        timer.at += timer.interval;
      }
      timer.callback();
    }
    this.time = target;
  }

  private addTimer(delayMs: number, interval: number | null, callback: () => void): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, interval, callback });
    return () => this.timers.delete(id);
  }
}

interface Attempt {
  sessionId: string;
  afterEventId: number;
  callbacks: SessionStreamCallbacks;
  handle: SessionStreamHandle & { closed: boolean };
}

class FakeTransport implements SessionStreamTransport {
  readonly attempts: Attempt[] = [];

  open(sessionId: string, afterEventId: number, callbacks: SessionStreamCallbacks): SessionStreamHandle {
    const handle = {
      closed: false,
      close() {
        handle.closed = true;
      },
    };
    this.attempts.push({ sessionId, afterEventId, callbacks, handle });
    return handle;
  }
}

function rawFrame(eventId: number): CentaurEventFrame {
  return { event: 'amp_raw_event', event_id: eventId, data: {} } as unknown as CentaurEventFrame;
}

function executionFrame(eventId: number, status: 'running' | 'completed'): CentaurEventFrame {
  return {
    event: 'execution_state',
    event_id: eventId,
    data: { type: 'execution.state', status, thread_key: 't', execution_id: 'e' },
  } as CentaurEventFrame;
}

describe('session stream machine', () => {
  it('folds frames, resumes from the cursor, and deduplicates replay except execution_state', () => {
    const scheduler = new FakeScheduler();
    const transport = new FakeTransport();
    const machine = createSessionStreamMachine(transport, scheduler);
    machine.start('s-1');

    transport.attempts[0]!.callbacks.onFrame(rawFrame(7));
    scheduler.flush();
    expect(machine.getState().stream.lastEventId).toBe(7);
    expect(machine.getState().stream.frameSeq).toBe(1);

    transport.attempts[0]!.callbacks.onError();
    scheduler.advance(999);
    expect(transport.attempts).toHaveLength(1);
    scheduler.advance(1);
    expect(transport.attempts[1]!.afterEventId).toBe(7);

    transport.attempts[1]!.callbacks.onFrame(rawFrame(7));
    scheduler.flush();
    expect(machine.getState().stream.frameSeq).toBe(1);

    transport.attempts[1]!.callbacks.onFrame(executionFrame(7, 'completed'));
    scheduler.flush();
    expect(machine.getState().stream.lastEventId).toBe(7);
    expect(machine.getState().stream.frameSeq).toBe(2);
    expect(machine.getState().stream.status).toBe('completed');
  });

  it('resets all published state and cancels the run when the session detaches', () => {
    const scheduler = new FakeScheduler();
    const transport = new FakeTransport();
    const machine = createSessionStreamMachine(transport, scheduler);
    machine.start('s-1');
    const first = transport.attempts[0]!;
    first.callbacks.onOpen();
    scheduler.advance(1_000);
    first.callbacks.onPing(new Date(0).toISOString());
    first.callbacks.onFrame(rawFrame(2));
    scheduler.flush();

    machine.start(null);

    expect(first.handle.closed).toBe(true);
    expect(machine.getState()).toMatchObject({ connected: false, lastFrameAt: null, clockSkewMs: null });
    expect(machine.getState().stream.lastEventId).toBe(0);
    expect(machine.getState().stream.items).toEqual([]);
    scheduler.advance(300_000);
    expect(transport.attempts).toHaveLength(1);
  });

  it('stops reconnecting on a terminal fold and reopens when active flips true', () => {
    const scheduler = new FakeScheduler();
    const transport = new FakeTransport();
    const machine = createSessionStreamMachine(transport, scheduler);
    machine.start('s-1');
    transport.attempts[0]!.callbacks.onFrame(executionFrame(4, 'completed'));
    scheduler.flush();
    transport.attempts[0]!.callbacks.onError();

    scheduler.advance(10_000);
    expect(transport.attempts).toHaveLength(1);

    machine.setActive(true);
    machine.ensureConnected();
    expect(transport.attempts).toHaveLength(2);
    expect(transport.attempts[1]!.afterEventId).toBe(4);

    // Active is also an override for the retry guard if the forced reopen
    // fails before a new running execution_state has arrived.
    transport.attempts[1]!.callbacks.onError();
    scheduler.advance(1_000);
    expect(transport.attempts).toHaveLength(3);
  });

  it('still stops a terminal replay when active was already true before the fold', () => {
    const scheduler = new FakeScheduler();
    const transport = new FakeTransport();
    const machine = createSessionStreamMachine(transport, scheduler);
    machine.setActive(true);
    machine.start('s-1');
    transport.attempts[0]!.callbacks.onFrame(executionFrame(4, 'completed'));
    scheduler.flush();
    transport.attempts[0]!.callbacks.onError();

    scheduler.advance(10_000);
    expect(transport.attempts).toHaveLength(1);
  });

  it('recycles at 45s with ping proof but uses the 4m fallback without it', () => {
    const provenScheduler = new FakeScheduler();
    const provenTransport = new FakeTransport();
    const proven = createSessionStreamMachine(provenTransport, provenScheduler);
    proven.start('with-ping');
    provenScheduler.advance(5_000);
    provenTransport.attempts[0]!.callbacks.onPing(null);
    provenScheduler.advance(44_999);
    expect(provenTransport.attempts).toHaveLength(1);
    provenScheduler.advance(1);
    expect(provenTransport.attempts[0]!.handle.closed).toBe(true);
    expect(provenTransport.attempts).toHaveLength(2);

    const fallbackScheduler = new FakeScheduler();
    const fallbackTransport = new FakeTransport();
    const fallback = createSessionStreamMachine(fallbackTransport, fallbackScheduler);
    fallback.start('without-ping');
    fallbackScheduler.advance(239_999);
    expect(fallbackTransport.attempts).toHaveLength(1);
    fallbackScheduler.advance(1);
    expect(fallbackTransport.attempts[0]!.handle.closed).toBe(true);
    expect(fallbackTransport.attempts).toHaveLength(2);
  });
});
