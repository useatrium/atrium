// Desktop notifications: quiet by default. Fired only for mentions, DMs, and
// your own agent sessions finishing — and only while the tab is hidden.
// Permission is requested from the bell toggle, never on page load.

const PREF_KEY = 'atrium:notifications';

export type NotifyState = 'unsupported' | 'denied' | 'off' | 'on';

export function notificationState(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && localStorage.getItem(PREF_KEY) === 'on'
    ? 'on'
    : 'off';
}

/** Flip the pref, requesting browser permission on first enable. */
export async function toggleNotifications(): Promise<NotifyState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (notificationState() === 'on') {
    localStorage.setItem(PREF_KEY, 'off');
    return 'off';
  }
  const perm =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  localStorage.setItem(PREF_KEY, 'on');
  return 'on';
}

export function showNotification(
  title: string,
  body: string,
  tag: string,
  onClick: () => void,
): void {
  if (notificationState() !== 'on' || !document.hidden) return;
  try {
    const n = new Notification(title, { body, tag, icon: '/favicon.svg' });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // Some platforms require a service worker for Notification(); fail quiet.
  }
}
