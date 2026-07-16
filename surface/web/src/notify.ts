// Desktop notifications: quiet by default. Fired only for mentions, DMs, and
// your own agent sessions finishing — and only while the tab is hidden.
// Permission is requested from the bell toggle, never on page load.

import { api } from './api';
import { desktopApiOptions } from './desktop';
import { NOTIFICATIONS_STORAGE_KEY } from './storageKeys';

export type NotifyState = 'unsupported' | 'denied' | 'off' | 'on';

type VapidResponse = {
  key: string | null;
};

function notificationApi(): typeof Notification | null {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined' ? window.Notification : null;
}

function webPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

function vapidKeyToUint8Array(key: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (key.length % 4)) % 4);
  const base64 = `${key}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function fetchVapidPublicKey(): Promise<string | null> {
  const options = desktopApiOptions();
  const base = (options?.baseUrl ?? '').replace(/\/+$/, '');
  const token = options?.getToken ? options.getToken() : null;
  const res = await fetch(`${base}/api/push/vapid-public-key`, {
    credentials: 'same-origin',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) return null;
  const body = (await res.json()) as VapidResponse;
  return typeof body.key === 'string' && body.key ? body.key : null;
}

function subscriptionJson(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} | null {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

async function enableWebPush(): Promise<void> {
  const key = await fetchVapidPublicKey().catch(() => null);
  if (!key || !webPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.pushManager) return;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToUint8Array(key),
      }));
    const json = subscriptionJson(subscription);
    if (!json) return;
    await api.registerPush({
      token: json.endpoint,
      platform: 'web',
      kind: 'webpush',
      subscription: json,
    });
  } catch {
    // Web Push is optional; local hidden-tab notifications still work.
  }
}

async function disableWebPush(): Promise<void> {
  if (!webPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager?.getSubscription();
    const endpoint = subscription?.endpoint;
    if (!subscription || !endpoint) return;
    await subscription.unsubscribe().catch(() => false);
    await api.unregisterPush(endpoint).catch(() => undefined);
  } catch {
    // Disabling local notifications should not depend on PushManager health.
  }
}

export function notificationState(): NotifyState {
  const NotificationApi = notificationApi();
  if (!NotificationApi) return 'unsupported';
  if (NotificationApi.permission === 'denied') return 'denied';
  try {
    return NotificationApi.permission === 'granted' && window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === 'on'
      ? 'on'
      : 'off';
  } catch {
    return 'off';
  }
}

/** Flip the pref, requesting browser permission on first enable. */
export async function toggleNotifications(): Promise<NotifyState> {
  const NotificationApi = notificationApi();
  if (!NotificationApi) return 'unsupported';
  if (notificationState() === 'on') {
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, 'off');
    await disableWebPush();
    return 'off';
  }
  const perm = NotificationApi.permission === 'granted' ? 'granted' : await NotificationApi.requestPermission();
  if (perm !== 'granted') return 'denied';
  window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, 'on');
  await enableWebPush();
  return 'on';
}

export function showNotification(title: string, body: string, tag: string, onClick: () => void): void {
  const NotificationApi = notificationApi();
  if (!NotificationApi || notificationState() !== 'on' || !window.document.hidden) return;
  try {
    const n = new NotificationApi(title, { body, tag, icon: '/favicon.svg' });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // Some platforms require a service worker for Notification(); fail quiet.
  }
}
