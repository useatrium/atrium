import { useCallback, useEffect, useRef, useState } from 'react';
import {
  randomId,
  reconcileDraftSnapshot,
  type DraftDeletionSnapshot,
  type DraftSnapshot,
  type EnqueueOpInput,
} from '@atrium/surface-client';
import { eventCache } from './cacheIdb';

type DraftEnqueue = (input: EnqueueOpInput<'draft.set'>) => Promise<unknown>;

export function useDraftState({
  activeDraftKeysForSync,
  activeDraftKey,
  enqueueOp,
  threadDraftKey,
}: {
  activeDraftKeysForSync: ReadonlySet<string>;
  activeDraftKey: string;
  enqueueOp: DraftEnqueue;
  threadDraftKey: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const touchedDraftKeysRef = useRef<Set<string>>(new Set());
  const activeDraftKeysRef = useRef<ReadonlySet<string>>(new Set());

  activeDraftKeysRef.current = activeDraftKeysForSync;

  const reconcileDraftsFromSnapshot = useCallback(
    (snapshot: DraftSnapshot, deletions: DraftDeletionSnapshot = {}) => {
      void eventCache
        .listDrafts()
        .then(async (local) => {
          const { hydrate, remove } = reconcileDraftSnapshot({
            snapshot,
            deletions,
            local,
            touchedThisSession: touchedDraftKeysRef.current,
            activeDraftKeys: activeDraftKeysRef.current,
          });
          const entries = Object.entries(hydrate);
          await Promise.all(
            entries
              .map(([draftKey, draft]) =>
                eventCache.setDraft(draftKey, draft.text, draft.updatedAt),
              )
              .concat(remove.map((draftKey) => eventCache.setDraft(draftKey, ''))),
          );
          if (entries.length === 0 && remove.length === 0) return;
          setDrafts((prev) => {
            let next = prev;
            for (const [draftKey, draft] of entries) {
              if (!(draftKey in prev) || prev[draftKey] === draft.text) continue;
              if (next === prev) next = { ...prev };
              next[draftKey] = draft.text;
            }
            for (const draftKey of remove) {
              if (!(draftKey in prev) || prev[draftKey] === '') continue;
              if (next === prev) next = { ...prev };
              next[draftKey] = '';
            }
            return next;
          });
        })
        .catch((err: unknown) => {
          console.warn('failed to reconcile draft snapshot', err);
        });
    },
    [],
  );

  const loadDraft = useCallback((key: string, label: string) => {
    let disposed = false;
    setDrafts((prev) => ({ ...prev, [key]: '' }));
    void eventCache
      .getDraft(key)
      .then((draft) => {
        if (!disposed) setDrafts((prev) => ({ ...prev, [key]: draft ?? '' }));
      })
      .catch((err: unknown) => {
        console.warn(`failed to load ${label} draft`, err);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!activeDraftKey) return;
    return loadDraft(activeDraftKey, 'channel');
  }, [activeDraftKey, loadDraft]);

  useEffect(() => {
    if (!threadDraftKey) return;
    return loadDraft(threadDraftKey, 'thread');
  }, [loadDraft, threadDraftKey]);

  const saveDraft = useCallback((key: string, text: string) => eventCache.setDraft(key, text), []);

  const markDraftTouched = useCallback((key: string) => {
    touchedDraftKeysRef.current.add(key);
  }, []);

  const putTextInComposer = useCallback(
    (text: string) => {
      if (!activeDraftKey) return;
      markDraftTouched(activeDraftKey);
      setDrafts((prev) => ({ ...prev, [activeDraftKey]: text }));
      void saveDraft(activeDraftKey, text);
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message input"]');
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
        el.setSelectionRange(text.length, text.length);
      });
    },
    [activeDraftKey, markDraftTouched, saveDraft],
  );

  const enqueueDraft = useCallback(
    (key: string, text: string) => {
      markDraftTouched(key);
      void enqueueOp({
        opId: randomId(),
        opType: 'draft.set',
        payload: { draftKey: key, text },
      }).catch((err: unknown) => {
        console.warn('failed to queue draft sync', err);
      });
    },
    [enqueueOp, markDraftTouched],
  );

  return {
    drafts,
    enqueueDraft,
    markDraftTouched,
    putTextInComposer,
    reconcileDraftsFromSnapshot,
    saveDraft,
  };
}
