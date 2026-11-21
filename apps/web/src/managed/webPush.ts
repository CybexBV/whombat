/**
 * Browser notifications for a managed Whombat (MA-18, CT-42; AP-29): the browser subscribes with control's VAPID
 * key, registers the subscription with control over the cloud session (`push.register {platform: 'webpush'}`),
 * and gives the opaque handle to its appliance over the secure session (`push.handles.set`). Control sends a
 * generic payload (`{title, body, kind, ref}`, encrypted to the subscription); the service worker shows it and a
 * click opens `/?push=<kind>&ref=<ref>`, which the app resolves through the session.
 */

import type { WhombatClient } from '@whombat/client';
import {
  type ControlApi,
  clearPush,
  ensurePushHandle,
  type PushStore,
  type SavedPush,
  tellAppliance,
} from '@whombat/client/managed';
import type { ApplianceSession } from '@whombat/client/session';

const KEY = 'whombat:push';

type PushStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * This browser's push registration in local storage, reached when used (reaching it may throw, AP-594): unreadable is
 * none; a write that fails rejects (never pretends it was saved), and the callers that only tidy up ignore that.
 */
export function localPushStore(
  storage: PushStorage | (() => PushStorage) = () => window.localStorage,
): PushStore {
  const reach = typeof storage === 'function' ? storage : () => storage;
  return {
    async get() {
      try {
        const raw = reach().getItem(KEY);
        return raw ? (JSON.parse(raw) as SavedPush) : null;
      } catch {
        return null;
      }
    },
    async set(value) {
      reach().setItem(KEY, JSON.stringify(value));
    },
    async remove() {
      reach().removeItem(KEY);
    },
  };
}

export interface ManagedWebPush {
  /** Control's VAPID key, or null when control has none (browser notifications aren't offered then). */
  vapidKey(): Promise<string | null>;
  /** Whether this browser's current subscription is registered and this appliance has its handle. */
  registered(endpoint: string | null): Promise<boolean>;
  enable(subscription: PushSubscriptionJSON): Promise<void>;
  disable(): Promise<void>;
}

export function createManagedWebPush(input: {
  control: ControlApi;
  session: ApplianceSession;
  device: string;
  store?: PushStore;
}): ManagedWebPush {
  const store = input.store ?? localPushStore();
  let vapid: Promise<string | null> | null = null;
  return {
    vapidKey() {
      vapid ??= input.control.pushVapidKey().catch(() => null);
      return vapid;
    },
    async registered(endpoint) {
      const saved = await store.get();
      return !!endpoint && saved?.address === endpoint && saved.appliances.includes(input.device);
    },
    async enable(sub) {
      if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys.auth) throw new Error('incomplete subscription');
      const saved = await ensurePushHandle(input.control, store, {
        platform: 'webpush',
        subscription: {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          expirationTime: sub.expirationTime ?? null,
        },
      });
      await tellAppliance(input.session, store, input.device, saved);
    },
    disable: () => clearPush(input.control, store, input.session),
  };
}

/** The tap the service worker opened (`/?push=<kind>&ref=<ref>`), if this page is one. */
export function readPushTap(search: string): { kind: string; ref: string } | null {
  const params = new URLSearchParams(search);
  const kind = params.get('push');
  const ref = params.get('ref');
  if (!kind || !/^[a-z]{1,20}$/.test(kind) || !ref || !/^[A-Za-z0-9_-]{22,43}$/.test(ref)) return null;
  return { kind, ref };
}

/**
 * Browser notifications from the box itself (Whombat hermes-engine.md HE-61; contracts CT-1307; hermes-engine-app.md
 * AP-5428): where no control is behind the page — the box's own page — and the page is secure (its Tailscale page, or
 * `localhost`), the browser subscribes with the box's own VAPID key (`devices.vapidKey` over the session) and registers
 * the subscription with the box (`devices.register`), which sends the notifications. A box without a key of its own
 * (`push.web_unavailable`) offers none.
 */
export function createBoxWebPush(input: { client: WhombatClient; store?: PushStorage }): ManagedWebPush {
  const reach = () => input.store ?? window.localStorage;
  let vapid: Promise<string | null> | null = null;
  const saved = (): { endpoint: string; deviceId: string } | null => {
    try {
      const raw = reach().getItem(BOX_KEY);
      return raw ? (JSON.parse(raw) as { endpoint: string; deviceId: string }) : null;
    } catch {
      return null;
    }
  };
  return {
    vapidKey() {
      vapid ??= input.client.devices.vapidKey({}).then(
        (r) => r.publicKey,
        () => null,
      );
      return vapid;
    },
    async registered(endpoint) {
      return !!endpoint && saved()?.endpoint === endpoint;
    },
    async enable(sub) {
      if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys.auth) throw new Error('incomplete subscription');
      const r = await input.client.devices.register({
        body: {
          platform: 'web',
          provider: 'webpush',
          token: sub.endpoint,
          webPush: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        },
      });
      if (r.status !== 'ok') throw new Error('not registered');
      try {
        reach().setItem(BOX_KEY, JSON.stringify({ endpoint: sub.endpoint, deviceId: r.data.device.id }));
      } catch {
        // Not remembered: the next visit asks the browser again.
      }
    },
    async disable() {
      const s = saved();
      if (s) await input.client.devices.remove({ params: { deviceId: s.deviceId } }).catch(() => {});
      try {
        reach().removeItem(BOX_KEY);
      } catch {
        // nothing kept
      }
    },
  };
}

const BOX_KEY = 'whombat:box-push';
