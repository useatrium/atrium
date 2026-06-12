export interface DraftSnapshotEntry {
  text: string;
  updatedAt: string;
}

export type DraftSnapshot = Record<string, DraftSnapshotEntry>;
export type DraftDeletionSnapshot = Record<string, string>;

export interface DraftReconcileDecision {
  hydrate: DraftSnapshot;
  remove: string[];
}

function timestampMs(value: string | undefined): number {
  if (!value) return -Infinity;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : -Infinity;
}

export function reconcileDraftSnapshot(args: {
  snapshot: DraftSnapshot;
  deletions?: DraftDeletionSnapshot;
  local: DraftSnapshot;
  touchedThisSession: ReadonlySet<string>;
  activeDraftKeys: ReadonlySet<string>;
}): DraftReconcileDecision {
  const hydrate: DraftSnapshot = {};
  for (const [draftKey, remote] of Object.entries(args.snapshot)) {
    // Drafts are roaming backup, not collaborative editing: a server snapshot
    // hydrates only inactive composer keys that this app session has never
    // touched, and only when the server copy is newer than local cache. This
    // deliberately never overwrites the active composer while the user types.
    if (args.activeDraftKeys.has(draftKey) || args.touchedThisSession.has(draftKey)) {
      continue;
    }
    const local = args.local[draftKey];
    if (!local || timestampMs(remote.updatedAt) > timestampMs(local.updatedAt)) {
      hydrate[draftKey] = remote;
    }
  }
  const remove: string[] = [];
  for (const [draftKey, deletedAt] of Object.entries(args.deletions ?? {})) {
    if (args.activeDraftKeys.has(draftKey) || args.touchedThisSession.has(draftKey)) {
      continue;
    }
    const local = args.local[draftKey];
    if (local && timestampMs(local.updatedAt) < timestampMs(deletedAt)) {
      remove.push(draftKey);
    }
  }
  return { hydrate, remove };
}

export function createDraftChangeDebouncer(
  save: (key: string, text: string) => void | Promise<void>,
  delayMs = 400,
  afterSave?: (key: string, text: string) => void | Promise<void>,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const persist = (key: string, text: string) => {
    void Promise.resolve(save(key, text))
      .then(() => afterSave?.(key, text))
      .catch((err: unknown) => {
        console.warn('failed to persist draft', err);
      });
  };

  const clear = (key: string) => {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  };

  return {
    schedule(key: string, text: string) {
      clear(key);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          persist(key, text);
        }, delayMs),
      );
    },
    saveNow(key: string, text: string) {
      clear(key);
      persist(key, text);
    },
    cancel(key?: string) {
      if (key) {
        clear(key);
        return;
      }
      for (const draftKey of [...timers.keys()]) clear(draftKey);
    },
  };
}
