import { useCallback, useEffect, useState } from 'react';
import { useManaged } from '../app/providers';
import type { ManagedWebPush } from '../managed/webPush';
import {
  getExistingSubscription,
  isPushSupported,
  registerServiceWorker,
  subscribePush,
  unsubscribePush,
} from './webPush';

export type WebPushStatus = 'unknown' | 'unsupported' | 'off' | 'on' | 'denied' | 'busy';

export interface UseWebPushResult {
  status: WebPushStatus;
  /** Prompts for permission (only from a click) and subscribes. */
  enable: () => Promise<void>;
  /** Unsubscribes this browser. */
  disable: () => Promise<void>;
}

/**
 * Desktop notifications opt-in (TODO 9.4): through control, content-free (MA-18, AP-29), where the page has control
 * behind it (the hosted app); elsewhere — the box's own page, fixture mode — `unsupported` (hermes-engine-app.md
 * AP-5325: the box's own push keys don't travel over a session, `SESSION_EXCLUDED_API_OPS`). Call `enable()`/`disable()`
 * from a click handler only — `enable()` is what triggers the browser's permission prompt.
 */
export function useWebPush(): UseWebPushResult {
  return useManagedWebPush(useManaged()?.push ?? null);
}

/** Browser notifications through control (MA-18): VAPID key from control, handle to the appliance. */
function useManagedWebPush(push: ManagedWebPush | null): UseWebPushResult {
  const [status, setStatus] = useState<WebPushStatus>('unknown');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const vapid = push && isPushSupported() ? await push.vapidKey() : null;
      if (!push || !vapid) {
        if (!cancelled) setStatus('unsupported');
        return;
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        if (!cancelled) setStatus('denied');
        return;
      }
      const sub = await getExistingSubscription().catch(() => null);
      const on = await push.registered(sub?.endpoint ?? null);
      if (!cancelled) setStatus(on ? 'on' : 'off');
    })();
    return () => {
      cancelled = true;
    };
  }, [push]);

  const enable = useCallback(async () => {
    const vapid = push ? await push.vapidKey() : null;
    if (!push || !vapid || !isPushSupported()) return;
    setStatus('busy');
    try {
      const registration = await registerServiceWorker();
      const subscription = await subscribePush(registration, vapid);
      await push.enable(subscription.toJSON());
      setStatus('on');
    } catch {
      setStatus(
        typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'denied' : 'off',
      );
    }
  }, [push]);

  const disable = useCallback(async () => {
    if (!push) return;
    setStatus('busy');
    const sub = await getExistingSubscription().catch(() => null);
    if (sub) await unsubscribePush(sub).catch(() => {});
    await push.disable();
    setStatus('off');
  }, [push]);

  return { status, enable, disable };
}
