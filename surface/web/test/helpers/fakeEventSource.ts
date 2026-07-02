// Minimal EventSource stand-in for tests: lets a test feed Centaur fixture
// frames into code that consumes the real SSE wire shape
// (`event: <name>` / `data: <json incl event_id>`).

import type { CentaurEventFrame } from '@atrium/centaur-client';

type Listener = (e: MessageEvent<string>) => void;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  static last(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!last) throw new Error('no FakeEventSource instantiated');
    return last;
  }

  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: Listener): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn);
  }

  removeEventListener(name: string, fn: Listener): void {
    this.listeners.get(name)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  error(): void {
    this.onerror?.();
  }

  /** Deliver one frame the way the server proxy would. */
  emit(frame: CentaurEventFrame): void {
    const fns = this.listeners.get(frame.event);
    if (!fns) return;
    const e = {
      data: JSON.stringify({
        event_id: frame.event_id,
        data: frame.data,
        ...(frame.ts ? { atrium_ts: frame.ts } : {}),
      }),
    } as MessageEvent<string>;
    for (const fn of fns) fn(e);
  }

  emitAll(frames: CentaurEventFrame[]): void {
    for (const f of frames) this.emit(f);
  }
}

/** Point `globalThis.EventSource` at the fake (jsdom has none). */
export function installFakeEventSource(): void {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
}
