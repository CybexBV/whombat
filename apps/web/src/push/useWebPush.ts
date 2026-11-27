import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useManaged } from '../app/providers';
import type { ManagedWebPush } from '../managed/webPush';
import { pushStart, readPushChoice, writePushChoice } from './pushChoice';
import {
  getExistingSubscription,
  isPushSupported,
  registerServiceWorker,
  subscribePush,
  unsubscribePush,
} from './webPush';

export type WebPushStatus = 'unknown' | 'unsupported' | 'off' | 'on' | 'denied' | 'busy';

export interface WebPushState {
  status: WebPushStatus;
  /** The Chat asks once: the browser has never asked and the person hasn't answered here. */
  offer: boolean;
}

export interface UseWebPushResult extends WebPushState {
  /** Asks the browser (call it from a click: the browser's question needs one) and subscribes. */
  enable: () => Promise<void>;
  /** Unsubscribes this browser and remembers it: notifications don't come back by themselves. */
  disable: () => Promise<void>;
  /** The Chat's Not now: the question doesn't come back in this browser. */
  dismiss: () => void;
}

/**
 * This browser's notifications (TODO 9.4): through control, content-free (MA-18, AP-29), where the page has control
 * behind it (the hosted app), or from the box itself on its own secure page; elsewhere — fixture mode, an insecure
 * box page — `unsupported` (the box's own push keys don't travel over a session, `SESSION_EXCLUDED_API_OPS`).
 *
 * Every screen shares one state per Whombat, checked once a page: where the browser already allows notifications and
 * this browser isn't registered, it subscribes by itself, unless the person turned them off here (`pushChoice.ts`).
 */
export function useWebPush(): UseWebPushResult {
  const controller = controllerFor(useManaged()?.push ?? null);
  useEffect(() => controller.start(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  const enable = useCallback(() => controller.enable(), [controller]);
  const disable = useCallback(() => controller.disable(), [controller]);
  const dismiss = useCallback(() => controller.dismiss(), [controller]);
  return { ...state, enable, disable, dismiss };
}

/** Checks this browser once the shell is up, so notifications come on by themselves without opening Settings. */
export function useWebPushOnLoad(): void {
  const controller = controllerFor(useManaged()?.push ?? null);
  useEffect(() => controller.start(), [controller]);
}

export interface WebPushController {
  get: () => WebPushState;
  subscribe: (listener: () => void) => () => void;
  /** Looks at this browser once (later calls do nothing) and subscribes by itself where `pushStart` says so. */
  start: () => void;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  dismiss: () => void;
}

const UNSUPPORTED: WebPushController = (() => {
  const state: WebPushState = { status: 'unsupported', offer: false };
  return {
    get: () => state,
    subscribe: () => () => {},
    start: () => {},
    enable: async () => {},
    disable: async () => {},
    dismiss: () => {},
  };
})();

const controllers = new WeakMap<ManagedWebPush, WebPushController>();

function controllerFor(push: ManagedWebPush | null): WebPushController {
  if (!push) return UNSUPPORTED;
  let controller = controllers.get(push);
  if (!controller) {
    controller = webPushController(push);
    controllers.set(push, controller);
  }
  return controller;
}

function permissionNow(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'default' : Notification.permission;
}

/** One Whombat's notifications in this browser (`ManagedWebPush`): its state, and turning them on and off. */
export function webPushController(push: ManagedWebPush): WebPushController {
  let state: WebPushState = { status: 'unknown', offer: false };
  let started = false;
  const listeners = new Set<() => void>();
  const set = (next: Partial<WebPushState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const notOn = () => set({ status: permissionNow() === 'denied' ? 'denied' : 'off' });

  const subscribeHere = async (vapid: string) => {
    set({ status: 'busy', offer: false });
    try {
      const registration = await registerServiceWorker();
      const subscription = await subscribePush(registration, vapid);
      await push.enable(subscription.toJSON());
      set({ status: 'on' });
    } catch {
      notOn();
    }
  };

  const check = async () => {
    const vapid = isPushSupported() ? await push.vapidKey().catch(() => null) : null;
    if (!vapid) return set({ status: 'unsupported', offer: false });
    const permission = permissionNow();
    if (permission === 'denied') return set({ status: 'denied', offer: false });
    const sub = await getExistingSubscription().catch(() => null);
    const registered = await push.registered(sub?.endpoint ?? null).catch(() => false);
    if (registered) return set({ status: 'on', offer: false });
    const choice = readPushChoice();
    const start = pushStart({
      supported: true,
      permission,
      registered,
      offHere: choice.off,
      answered: choice.answered,
    });
    if (start === 'subscribe') return subscribeHere(vapid);
    set({ status: 'off', offer: start === 'offer' });
  };

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (started) return;
      started = true;
      void check().catch(() => set({ status: 'off', offer: false }));
    },
    async enable() {
      // The browser's question first, before anything is awaited, so it comes straight from the person's click.
      const asked =
        typeof Notification !== 'undefined' && Notification.permission === 'default'
          ? Notification.requestPermission().catch(() => permissionNow())
          : null;
      writePushChoice({ off: false, answered: true });
      set({ status: 'busy', offer: false });
      const permission = asked ? await asked : permissionNow();
      const vapid = permission === 'granted' && isPushSupported() ? await push.vapidKey() : null;
      if (!vapid) return notOn();
      await subscribeHere(vapid);
    },
    async disable() {
      writePushChoice({ off: true });
      set({ status: 'busy', offer: false });
      const sub = await getExistingSubscription().catch(() => null);
      if (sub) await unsubscribePush(sub).catch(() => {});
      await push.disable().catch(() => {});
      set({ status: 'off' });
    },
    dismiss() {
      writePushChoice({ answered: true });
      set({ offer: false });
    },
  };
}
