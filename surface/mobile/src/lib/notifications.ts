// Expo push wiring. Remote push requires a development build with an EAS
// projectId (Expo Go can't receive remote pushes since SDK 53) — everything
// here degrades to a no-op until `eas init` has stamped a projectId.

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import type { Api } from '@atrium/surface-client';

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
  const id = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
    ?.projectId;
  return typeof id === 'string' && id ? id : null;
}

/** Returns the registered Expo push token, or null when push isn't available. */
export async function registerForPush(api: Api): Promise<string | null> {
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
  const granted =
    perm.granted ||
    perm.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    perm.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!granted) return null;
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
}
