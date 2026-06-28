import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserRef } from '@atrium/surface-client';

type TypingEntry = { user: UserRef; until: number };

export function useTypingIndicators({
  activeChannelId,
  meId,
}: {
  activeChannelId: string | null;
  meId: string;
}) {
  const activeChannelIdRef = useRef(activeChannelId);
  activeChannelIdRef.current = activeChannelId;

  const [typing, setTyping] = useState<Record<string, TypingEntry>>({});
  const [sessionTyping, setSessionTyping] = useState<Record<string, Record<string, TypingEntry>>>(
    {},
  );

  const onTyping = useCallback(
    (channelId: string, user: UserRef) => {
      if (user.id === meId || channelId !== activeChannelIdRef.current) return;
      setTyping((prev) => ({ ...prev, [user.id]: { user, until: Date.now() + 4000 } }));
    },
    [meId],
  );

  const onSessionTyping = useCallback(
    (sessionId: string, user: UserRef) => {
      if (user.id === meId) return;
      setSessionTyping((prev) => ({
        ...prev,
        [sessionId]: {
          ...(prev[sessionId] ?? {}),
          [user.id]: { user, until: Date.now() + 4000 },
        },
      }));
    },
    [meId],
  );

  const clearTypingUser = useCallback((userId: string) => {
    setTyping((prev) => {
      if (!prev[userId]) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        const live = Object.entries(prev).filter(([, value]) => value.until > now);
        return live.length === Object.keys(prev).length ? prev : Object.fromEntries(live);
      });
      setSessionTyping((prev) => {
        let changed = false;
        const next: Record<string, Record<string, TypingEntry>> = {};
        for (const [sessionId, typers] of Object.entries(prev)) {
          const live = Object.entries(typers).filter(([, value]) => value.until > now);
          if (live.length !== Object.keys(typers).length) changed = true;
          if (live.length > 0) next[sessionId] = Object.fromEntries(live);
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => setTyping({}), [activeChannelId]);

  return {
    clearTypingUser,
    onSessionTyping,
    onTyping,
    sessionTyping,
    typing,
  };
}
