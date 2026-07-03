import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_PUSH_ENABLED_STORAGE_KEY,
  loadDevicePushEnabled,
  registerForPush,
  setDevicePushEnabled,
} from '../src/lib/notifications';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  getExpoPushTokenAsync: vi.fn(),
  registerPush: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(mocks.store.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      mocks.store.set(key, value);
      return Promise.resolve();
    }),
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: { eas: { projectId: 'project-id' } },
    },
  },
}));

vi.mock('expo-device', () => ({
  isDevice: true,
}));

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  IosAuthorizationStatus: {
    DENIED: 1,
    AUTHORIZED: 2,
    PROVISIONAL: 3,
    EPHEMERAL: 4,
  },
  getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
  setNotificationHandler: vi.fn(),
}));

describe('mobile push notification preference', () => {
  beforeEach(() => {
    mocks.store.clear();
    vi.clearAllMocks();
    mocks.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[test]' });
    mocks.registerPush.mockResolvedValue(undefined);
    mocks.requestPermissionsAsync.mockResolvedValue({
      granted: true,
      ios: { status: 2 },
      status: 'granted',
    });
    mocks.setNotificationChannelAsync.mockResolvedValue(null);
  });

  it('defaults device push to enabled and persists explicit opt-out', async () => {
    await expect(loadDevicePushEnabled()).resolves.toBe(true);

    await setDevicePushEnabled(false);

    await expect(loadDevicePushEnabled()).resolves.toBe(false);
    expect(mocks.store.get(DEVICE_PUSH_ENABLED_STORAGE_KEY)).toBe('false');
  });

  it('does not request or register push when the device preference is off', async () => {
    await setDevicePushEnabled(false);

    const api = { registerPush: mocks.registerPush } as unknown as Parameters<
      typeof registerForPush
    >[0];
    await expect(registerForPush(api)).resolves.toBeNull();

    expect(mocks.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mocks.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mocks.registerPush).not.toHaveBeenCalled();
  });
});
