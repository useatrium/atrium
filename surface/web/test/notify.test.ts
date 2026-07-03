// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { toggleNotifications } from '../src/notify';

vi.mock('../src/api', () => ({
  api: {
    registerPush: vi.fn(async () => ({ ok: true })),
    unregisterPush: vi.fn(async () => ({ ok: true })),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'Notification', { configurable: true, value: undefined });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
});

function installNotification(
  permission: NotificationPermission,
  requested: NotificationPermission = 'granted',
) {
  class MockNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      MockNotification.permission = requested;
      return requested;
    });
  }
  Object.defineProperty(window, 'Notification', { configurable: true, value: MockNotification });
  return MockNotification;
}

function pushSubscription(endpoint = 'https://push.test/subscription') {
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({
      endpoint,
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    }),
  } as unknown as PushSubscription & { unsubscribe: ReturnType<typeof vi.fn> };
}

function installPushManager(existing: PushSubscription | null = null) {
  const subscription = existing ?? pushSubscription();
  const getSubscription = vi.fn(async () => existing);
  const subscribe = vi.fn(async () => subscription);
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription, subscribe },
      }),
    },
  });
  return { getSubscription, subscribe, subscription };
}

describe('notification push subscription flow', () => {
  it('enables local notifications and registers a web push subscription when configured', async () => {
    installNotification('default');
    const { subscribe } = installPushManager();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ key: 'AQID' }), { status: 200 })),
    );

    await expect(toggleNotifications()).resolves.toBe('on');

    expect(window.localStorage.getItem('atrium:notifications')).toBe('on');
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(api.registerPush).toHaveBeenCalledWith({
      token: 'https://push.test/subscription',
      platform: 'web',
      kind: 'webpush',
      subscription: {
        endpoint: 'https://push.test/subscription',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      },
    });
  });

  it('keeps local notifications on when the server has no VAPID key', async () => {
    installNotification('granted');
    installPushManager();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ key: null }), { status: 200 })),
    );

    await expect(toggleNotifications()).resolves.toBe('on');

    expect(window.localStorage.getItem('atrium:notifications')).toBe('on');
    expect(api.registerPush).not.toHaveBeenCalled();
  });

  it('unsubscribes and unregisters the endpoint when disabling', async () => {
    installNotification('granted');
    window.localStorage.setItem('atrium:notifications', 'on');
    const subscription = pushSubscription('https://push.test/existing');
    installPushManager(subscription);

    await expect(toggleNotifications()).resolves.toBe('off');

    expect(window.localStorage.getItem('atrium:notifications')).toBe('off');
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(api.unregisterPush).toHaveBeenCalledWith('https://push.test/existing');
  });
});
