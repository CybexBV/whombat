/**
 * The phone's Whombat notifications, the same calls on both systems: Android's are drawn by `modules/whombat-live`
 * (its FCM service), iOS's by the system from the APNs alert, read and removed here through expo-notifications. The
 * shade check (`ShadeBridge`), the inbox refresh (`useManagedPush`, the live-activity bridge) and sign-out use this.
 *
 * iOS doesn't hand a background push to the app without a background task, so a `clear` push from control doesn't
 * reach it; a notification read elsewhere goes when the app is next open or comes back to the front (the shade check),
 * and a newer one for the same thread or approval replaces it (`apns-collapse-id`).
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { type ShadeNotification, WhombatLive } from '../../modules/whombat-live';
import { isWhombatPush, managedPush, pushPayload, shadeEntry } from './iosPayload';

const ios = Platform.OS === 'ios';

/** A Whombat push reached the running app: a managed Whombat's kind and ref, when it had them. */
export type PushArrived = { kind?: string; ref?: string };

async function iosShade(): Promise<ShadeNotification[]> {
  const shown = await Notifications.getPresentedNotificationsAsync();
  return shown.flatMap((n) => {
    const entry = shadeEntry(n);
    return entry ? [entry] : [];
  });
}

export const phoneNotifications = {
  /** Whether the shade can be read and cleared here (Android: with the native module). */
  available(): boolean {
    return ios || WhombatLive.supported();
  },

  /** Whombat's notifications on screen now. */
  shade(): Promise<ShadeNotification[]> {
    return ios ? iosShade() : WhombatLive.shade();
  },

  /** Remove notifications by the tags `shade` gave. */
  async cancel(tags: readonly string[]): Promise<void> {
    if (!ios) return WhombatLive.cancel(tags);
    await Promise.all(tags.map((tag) => Notifications.dismissNotificationAsync(tag)));
  },

  /**
   * A Whombat alert reached the running app (refresh what it shows). Android: a managed Whombat's push; its live
   * activities' data pushes are `WhombatLive.onPush`.
   */
  onPush(listener: (push: PushArrived) => void): () => void {
    if (!ios) return WhombatLive.onGenericPush(listener);
    const sub = Notifications.addNotificationReceivedListener((n) => {
      const payload = pushPayload(n.request);
      if (isWhombatPush(payload)) listener(managedPush(payload) ?? {});
    });
    return () => sub.remove();
  },

  /** When the newest Whombat push arrived (epoch ms), whether or not the app ran; null when unknown. */
  async lastPushAt(): Promise<number | null> {
    if (!ios) return WhombatLive.lastGenericPushAt();
    const shown = await iosShade().catch(() => []);
    return shown.length ? Math.max(...shown.map((n) => n.postedAt)) : null;
  },

  /** Sign-out: every live activity and every Whombat notification goes. */
  async endAll(): Promise<void> {
    if (!ios) return WhombatLive.endAll();
    await Promise.all([WhombatLive.endAll(), Notifications.dismissAllNotificationsAsync()]);
  },

  /**
   * iOS: show a Whombat alert while the app is open too, as Android does; the shade check removes it once read. Other
   * notifications keep the system's default (not shown while open).
   */
  showWhileOpen(): void {
    if (!ios) return;
    Notifications.setNotificationHandler({
      handleNotification: async (n) => {
        const show = isWhombatPush(pushPayload(n.request));
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      },
    });
  },
};
