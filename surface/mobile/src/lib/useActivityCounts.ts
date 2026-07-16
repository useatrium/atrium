import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { ActivityCounts } from '@atrium/surface-client';
import { useChat } from './chat';

/**
 * Server-computed Inbox badge counts. Unlike the live WS session map
 * (empty on a cold boot), this is correct from first render: fetched on
 * mount, on app foreground, and re-fetched (debounced) whenever the live
 * session map changes so in-app state transitions reflect quickly.
 */
export function useActivityCounts(): ActivityCounts {
  const { api, state } = useChat();
  const [counts, setCounts] = useState<ActivityCounts>({
    attention: 0,
    unread: 0,
    needsYou: 0,
    running: 0,
    toReview: 0,
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    // Promise.resolve() guard + decode-with-default: a sync-throwing transport
    // or a deploy-skewed server without counts must not break the tab bar.
    void Promise.resolve()
      .then(() => api.getActivityCounts())
      .then((next) =>
        setCounts({
          attention: Number(next?.attention) || 0,
          unread: Number(next?.unread) || 0,
          needsYou: Number(next?.needsYou) || 0,
          running: Number(next?.running) || 0,
          toReview: Number(next?.toReview) || 0,
        }),
      )
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(refresh, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [state.sessions, refresh]);

  return counts;
}
