// Expo push wiring. Remote push requires a development build with an EAS
// projectId (Expo Go can't receive remote pushes since SDK 53) — everything
// here degrades to a no-op until `eas init` has stamped a projectId.

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import type { Api } from '@atrium/surface-client';

export const DEVICE_PUSH_ENABLED_STORAGE_KEY = 'atrium.push.enabled.v1';
export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

/** Suppress banners for the channel the user is currently reading. */
export function configureNotificationHandler(getFocusedChannelId: () => string | null) {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data as { channelId?: string } | undefined;
      const suppress = !!data?.channelId && data.channelId === getFocusedChannelId();
      return {
        shouldShowBanner: !suppress,
        shouldShowList: !suppress,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    },
  });
}

let registeredToken: string | null = null;
let registeredVoipToken: string | null = null;

export async function loadDevicePushEnabled(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(DEVICE_PUSH_ENABLED_STORAGE_KEY);
  return raw !== 'false';
}

export async function setDevicePushEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(DEVICE_PUSH_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
}

/** The token registered this app run — needed to unregister on logout. */
export function getRegisteredPushToken(): string | null {
  return registeredToken;
}

/** The VoIP token registered this app run — needed to unregister on logout. */
export function getRegisteredVoipPushToken(): string | null {
  return registeredVoipToken;
}

export function setRegisteredVoipPushToken(token: string | null): void {
  registeredVoipToken = token;
}

function easProjectId(): string | null {
  const id = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return typeof id === 'string' && id ? id : null;
}

function hasPushPermission(perm: Notifications.NotificationPermissionsStatus): boolean {
  const iosStatus = perm.ios?.status;
  return (
    perm.granted ||
    iosStatus === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    iosStatus === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    iosStatus === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

function pushPermissionStatus(perm: Notifications.NotificationPermissionsStatus): PushPermissionStatus {
  if (hasPushPermission(perm)) return 'granted';
  if (Platform.OS === 'ios') {
    return perm.ios?.status === Notifications.IosAuthorizationStatus.DENIED ? 'denied' : 'undetermined';
  }
  return perm.status === 'denied' ? 'denied' : 'undetermined';
}

export async function getPushPermissionStatus(): Promise<PushPermissionStatus> {
  return pushPermissionStatus(await Notifications.getPermissionsAsync());
}

/** Returns the registered Expo push token, or null when push isn't available. */
export async function registerForPush(api: Api): Promise<string | null> {
  if (!(await loadDevicePushEnabled())) return null;
  if (!Device.isDevice) return null; // simulators can't receive APNs/FCM
  const projectId = easProjectId();
  if (!projectId) {
    console.warn('[push] no EAS projectId yet — run `eas init` and rebuild to enable push');
    return null;
  }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250],
    });
  }
  const perm = await Notifications.requestPermissionsAsync();
  if (!hasPushPermission(perm)) return null;
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api.registerPush({ token, platform: Platform.OS === 'android' ? 'android' : 'ios' });
    registeredToken = token;
    return token;
  } catch (err) {
    console.warn('[push] registration failed', err);
    return null;
  }
}

export async function unregisterPush(api: Api, token: string | null): Promise<void> {
  if (!token) return;
  await api.unregisterPush(token).catch(() => {});
  if (registeredToken === token) registeredToken = null;
}
