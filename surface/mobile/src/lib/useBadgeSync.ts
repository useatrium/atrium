import { useEffect, useMemo, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';

export function unreadBadgeCount(unread: Record<string, unknown>): number {
  return Object.values(unread).filter(Boolean).length;
}

function setBadgeCount(count: number): void {
  void Notifications.setBadgeCountAsync(count).catch((err: unknown) => {
    console.warn('failed to sync app badge', err);
  });
}

export function useBadgeSync(unread: Record<string, unknown>): void {
  const count = useMemo(() => unreadBadgeCount(unread), [unread]);
  const countRef = useRef(count);
  const activeRef = useRef(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      activeRef.current = status === 'active';
      if (activeRef.current) setBadgeCount(countRef.current);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    countRef.current = count;
    if (activeRef.current) setBadgeCount(count);
  }, [count]);
}
