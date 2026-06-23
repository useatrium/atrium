// Desktop notifications: quiet by default. Fired only for mentions, DMs, and
// your own agent sessions finishing — and only while the tab is hidden.
// Permission is requested from the bell toggle, never on page load.

const PREF_KEY = 'atrium:notifications';

export type NotifyState = 'unsupported' | 'denied' | 'off' | 'on';

function notificationApi(): typeof Notification | null {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined'
    ? window.Notification
    : null;
}

export function notificationState(): NotifyState {
  const NotificationApi = notificationApi();
  if (!NotificationApi) return 'unsupported';
  if (NotificationApi.permission === 'denied') return 'denied';
  try {
    return NotificationApi.permission === 'granted' && window.localStorage.getItem(PREF_KEY) === 'on'
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
    window.localStorage.setItem(PREF_KEY, 'off');
    return 'off';
  }
  const perm =
    NotificationApi.permission === 'granted'
      ? 'granted'
      : await NotificationApi.requestPermission();
  if (perm !== 'granted') return 'denied';
  window.localStorage.setItem(PREF_KEY, 'on');
  return 'on';
}

export function showNotification(
  title: string,
  body: string,
  tag: string,
  onClick: () => void,
): void {
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
