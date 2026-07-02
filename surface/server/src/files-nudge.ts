import type { WireEvent } from './events.js';

export const FILES_CHANGED_EVENT_TYPE = 'files.changed';
export const FILES_CHANGED_DEBOUNCE_MS = 1000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface FilesChangedTimerApi {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  now(): Date;
}

export interface FilesChangedDebouncerOptions {
  delayMs?: number;
  timers?: FilesChangedTimerApi;
  publish(event: WireEvent): void | Promise<void>;
  onError?: (err: unknown) => void;
}

const realTimers: FilesChangedTimerApi = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle);
  },
  now() {
    return new Date();
  },
};

export function filesChangedEvent(workspaceId: string, createdAt: Date = new Date()): WireEvent {
  return {
    id: 0,
    workspaceId,
    channelId: null,
    threadRootEventId: null,
    type: FILES_CHANGED_EVENT_TYPE,
    actorId: null,
    payload: { workspaceId },
    createdAt: createdAt.toISOString(),
    author: null,
  };
}

export class FilesChangedDebouncer {
  private readonly delayMs: number;
  private readonly timers: FilesChangedTimerApi;
  private readonly pending = new Map<string, TimerHandle>();
  private readonly publish: FilesChangedDebouncerOptions['publish'];
  private readonly onError: (err: unknown) => void;

  constructor(options: FilesChangedDebouncerOptions) {
    this.delayMs = options.delayMs ?? FILES_CHANGED_DEBOUNCE_MS;
    this.timers = options.timers ?? realTimers;
    this.publish = options.publish;
    this.onError = options.onError ?? (() => {});
  }

  nudge(workspaceId: string): void {
    if (this.pending.has(workspaceId)) return;
    const timer = this.timers.setTimeout(() => this.fire(workspaceId), this.delayMs);
    this.pending.set(workspaceId, timer);
  }

  close(): void {
    for (const timer of this.pending.values()) this.timers.clearTimeout(timer);
    this.pending.clear();
  }

  private fire(workspaceId: string): void {
    this.pending.delete(workspaceId);
    Promise.resolve(this.publish(filesChangedEvent(workspaceId, this.timers.now()))).catch(this.onError);
  }
}
