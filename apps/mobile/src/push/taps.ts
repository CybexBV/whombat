/**
 * iOS: a tapped push notification (APNs alert with Whombat's `path`, `burrow` and `notificationId` keys)
 * becomes the same `whombat://open?…` URL Android's notifications open, so both go through the one
 * linking path (screen + mark read). Android's notifications are native and open that URL themselves.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { urlFromPushData } from '../navigation/routes';
import { pushPayload } from './iosPayload';

function urlFromResponse(response: Notifications.NotificationResponse | null): string | null {
  return response ? urlFromPushData(pushPayload(response.notification.request)) : null;
}

/** The notification that launched the app, if any. */
export async function initialNotificationUrl(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  return urlFromResponse(await Notifications.getLastNotificationResponseAsync());
}

/** Taps while the app runs. */
export function onNotificationTap(listener: (url: string) => void): () => void {
  if (Platform.OS !== 'ios') return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const url = urlFromResponse(response);
    if (url) listener(url);
  });
  return () => sub.remove();
}
