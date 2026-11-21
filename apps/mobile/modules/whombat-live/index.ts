/**
 * `whombat-live` — live activities for runs in progress and approvals that need a person (DECISIONS
 * D-08, A-12): Android shows an ongoing Live Update notification (`android/`), iOS an ActivityKit
 * activity (`ios/`, built on macOS). Both render `@whombat/core`'s `LiveActivityDisplay` as is, whether it
 * came from the app's realtime updates (`show`) or, on Android, from a data push handled natively. iOS's activity tokens
 * aren't sent anywhere yet, so there an activity updates only while the app runs.
 *
 * Without the native module (tests, web, an old build) every call is a no-op and `supported()` is false.
 */
import type { HomeWidgetStatus } from '@whombat/client';
import type { LiveActivityAttributes, LiveActivityDisplay, PushPayload } from '@whombat/core';
import { requireOptionalNativeModule } from 'expo';
import type { ActiveActivity, LiveColors, ShadeNotification } from './src/content';

export * from './src/content';

/** Whether a widget snapshot belongs to a cloud-signed-in box or a direct community box. */
export type StatusWidgetSource = 'cloud' | 'community';

/** Optional scope for `clearStatusWidget`: clear only if the saved snapshot matches the given box and/or source. */
export interface ClearStatusWidgetFilter {
  applianceId?: string;
  source?: StatusWidgetSource;
}

/** Saved calm status pushed to the Android and iOS home-screen widgets. */
export interface StatusWidgetPayload extends HomeWidgetStatus {
  /** Appliance id on this phone, so forgetting one box only clears its own widget status. */
  applianceId: string;
  /** Account/connection kind, so cloud sign-out or expiry clears cloud snapshots without wiping community boxes. */
  source?: StatusWidgetSource;
}

/** The native module's surface (`WhombatLiveModule` on Android and iOS). */
interface NativeWhombatLive {
  isSupported(): boolean;
  configure(colorsJson: string): void;
  /** Start or update; resolves with the activity's push token when there is one (iOS). */
  upsert(displayJson: string, burrow: string, attributesJson: string | null): Promise<string | null>;
  /** End; with a last display the activity keeps showing it (dismissible), without it it goes. */
  end(key: string, lastJson: string | null, burrow: string): Promise<void>;
  endAll(): Promise<void>;
  /** Save the latest calm status for the home-screen widget and refresh it. */
  setStatusWidget?(snapshotJson: string): Promise<void>;
  /** Clear the home-screen widget back to its signed-out state (optionally only for `applianceId` and/or `source`). */
  clearStatusWidget?(applianceId: string | null, source?: StatusWidgetSource | null): Promise<void>;
  active(): Promise<ActiveActivity[]>;
  /** Android: keys of the activities shown in the last 24 hours, on screen or not (MN-02). */
  recent?(): Promise<string[]>;
  /** Android: the inbox and managed notifications in the shade (MN-04). */
  shade?(): Promise<ShadeNotification[]>;
  /** Android: cancel shade notifications by the tags `shade` gave (MN-04). */
  cancel?(tags: string[]): Promise<void>;
  /** iOS 17.2+: the push-to-start token (`Device.liveActivityToken`). */
  pushToStartToken?(): Promise<string | null>;
  /** Android: the tap of a notification FCM showed while the app was in the background (once). */
  launchPushTap?(): string | null;
  /** Android: epoch ms of the last managed push received. */
  lastGenericPushAt?(): number | null;
  addListener(event: string, listener: (event: Record<string, string>) => void): { remove(): void };
}

const native = requireOptionalNativeModule<NativeWhombatLive>('WhombatLive');

function on(event: string, listener: (e: Record<string, string>) => void): () => void {
  if (!native) return () => {};
  const sub = native.addListener(event, listener);
  return () => sub.remove();
}

export const WhombatLive = {
  /** False until the native module is built into the app (and where live activities are off). */
  supported: (): boolean => native?.isSupported() ?? false,

  /** Tone colors from the tokens, kept natively for pushes that arrive while the app is closed. */
  configure(colors: LiveColors): void {
    native?.configure(JSON.stringify(colors));
  },

  /**
   * Show or refresh an activity; an ended display (`ongoing: false`) becomes its last state. Resolves with
   * the activity's push token on iOS, which the app doesn't send anywhere yet.
   */
  async show(
    display: LiveActivityDisplay,
    context: { burrow: string; attributes: LiveActivityAttributes },
  ): Promise<string | null> {
    if (!native?.isSupported()) return null;
    if (!display.ongoing) {
      await native.end(display.key, JSON.stringify(display), context.burrow);
      return null;
    }
    return native.upsert(JSON.stringify(display), context.burrow, JSON.stringify(context.attributes));
  },

  /** Dismiss an activity (its run or approval is gone). */
  async end(key: string, burrow = ''): Promise<void> {
    await native?.end(key, null, burrow);
  },

  /** Dismiss every Whombat activity and notification (sign-out). */
  async endAll(): Promise<void> {
    await native?.endAll();
  },

  /** Save the latest calm status for the home-screen widget (never gated on Live Activities permission). */
  async setStatusWidget(payload: StatusWidgetPayload): Promise<void> {
    await native?.setStatusWidget?.(JSON.stringify(payload));
  },

  /** Forget the saved home-screen widget status (on sign-out, revocation or box removal). */
  async clearStatusWidget(filter?: string | ClearStatusWidgetFilter): Promise<void> {
    if (typeof filter === 'string') {
      await native?.clearStatusWidget?.(filter, null);
      return;
    }
    await native?.clearStatusWidget?.(filter?.applianceId ?? null, filter?.source ?? null);
  },

  /** Ongoing activities on screen. */
  async active(): Promise<ActiveActivity[]> {
    return (await native?.active()) ?? [];
  },

  /**
   * Android: the activities shown in the last 24 hours, on screen or not. An ongoing one goes 10 minutes after its last
   * update (MN-02); one that went (or was swiped away) is in here but not in `active()`.
   */
  async recent(): Promise<string[]> {
    return (await native?.recent?.()) ?? [];
  },

  /** Android: the inbox and managed notifications in the shade, to cancel the ones read in the app (MN-04). */
  async shade(): Promise<ShadeNotification[]> {
    return (await native?.shade?.()) ?? [];
  },

  /** Android: cancel shade notifications by their tags (from `shade()`); other tags are ignored. */
  async cancel(tags: readonly string[]): Promise<void> {
    if (tags.length) await native?.cancel?.([...tags]);
  },

  /** iOS 17.2+: the token a server would start an activity with; the app doesn't send it anywhere yet. */
  async pushToStartToken(): Promise<string | null> {
    return (await native?.pushToStartToken?.()) ?? null;
  },

  /** A push was handled natively while the app runs (refresh what it shows). */
  onPush(listener: (payload: PushPayload) => void): () => void {
    return on('onPush', (e) => {
      try {
        listener(JSON.parse(e.payload ?? '') as PushPayload);
      } catch {
        // not JSON: ignore
      }
    });
  },

  /** Android: a managed Whombat's content-free push arrived (it is shown natively). */
  onGenericPush(listener: (push: { kind: string; ref: string }) => void): () => void {
    return on('onGenericPush', (e) => e.kind && e.ref && listener({ kind: e.kind, ref: e.ref }));
  },

  /** Android: a notification FCM showed was tapped while the app ran in the background. */
  onPushTap(listener: (url: string) => void): () => void {
    return on('onPushTap', (e) => e.url && listener(e.url));
  },

  /** Android: the tap that launched the app, if it was a notification FCM showed (consumed). */
  launchPushTap(): string | null {
    return native?.launchPushTap?.() ?? null;
  },

  /** Android: when the last managed push arrived (epoch ms), whether or not the app ran. */
  lastGenericPushAt(): number | null {
    return native?.lastGenericPushAt?.() ?? null;
  },

  /** Android: FCM rotated the device token. */
  onPushToken(listener: (token: string) => void): () => void {
    return on('onPushToken', (e) => e.token && listener(e.token));
  },

  /** iOS: an activity's push token (new or rotated). */
  onActivityPushToken(listener: (e: { key: string; token: string }) => void): () => void {
    return on('onActivityPushToken', (e) => e.key && e.token && listener({ key: e.key, token: e.token }));
  },

  /** iOS 17.2+: the push-to-start token changed. */
  onPushToStartToken(listener: (token: string) => void): () => void {
    return on('onPushToStartToken', (e) => e.token && listener(e.token));
  },
};
