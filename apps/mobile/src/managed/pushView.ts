/** What the notifications row says for a push state (pure; `NotificationsRow.tsx` draws it). */
import { agoText } from '@whombat/client/managed';
import type { DeliveryPage, DeliveryStatus } from '../../modules/whombat-live/src/content';
import type { ManagedPush } from './context';
import { COPY } from './copy';

export type Dot = 'ok' | 'warn' | 'bad' | 'mut';

export interface NotificationsView {
  dot: Dot;
  title: string;
  meta: string | null;
  /** `delivery`: the settings page in `page` turns back on what Android holds back. */
  action: 'settings' | 'enable' | 'delivery' | null;
  page?: DeliveryPage;
}

/** `“A”`, `“A” and “B”`, `“A”, “B” and “C”`. */
const quotedList = (names: readonly string[]) => {
  const q = names.map((n) => `“${n}”`);
  return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q.at(-1)}` : (q[0] ?? '');
};

/**
 * What Android holds back although notifications are allowed (Android only; `delivery` is null elsewhere), the most
 * important first: every channel off is as good as not allowed, then the channels that are off, then the app's battery
 * use restricted (its pushes don't arrive while it is closed). Null when nothing is.
 */
function heldBack(delivery: DeliveryStatus | null): NotificationsView | null {
  if (!delivery) return null;
  const t = COPY.notifications;
  const off = delivery.channels.filter((c) => c.blocked);
  if (off.length && off.length === delivery.channels.length)
    return {
      dot: 'warn',
      title: t.denied,
      meta: t.deniedMeta,
      action: 'delivery',
      page: { page: 'notifications' },
    };
  const [only] = off;
  if (only)
    return {
      dot: 'warn',
      title: t.partly,
      meta: t.channelsOff(quotedList(off.map((c) => c.name))),
      action: 'delivery',
      page: off.length === 1 ? { page: 'channel', channel: only.id } : { page: 'notifications' },
    };
  if (delivery.backgroundRestricted)
    return {
      dot: 'warn',
      title: t.heldBack,
      meta: t.restrictedMeta,
      action: 'delivery',
      page: { page: 'battery' },
    };
  return null;
}

/**
 * At most one calm line while everything arrives: Live Updates turned off (a choice the person may have made, with a
 * way back), else battery optimisation, which is Android's default and lets these pushes through on most phones, so
 * it gets no button that would send the person off to change it.
 */
function calmLine(delivery: DeliveryStatus | null): { line: string; page?: DeliveryPage } | null {
  const t = COPY.notifications;
  if (delivery?.liveUpdatesAllowed === false)
    return { line: t.liveUpdatesOff, page: { page: 'liveUpdates' } };
  if (delivery?.batteryOptimized) return { line: t.batteryMeta };
  return null;
}

export function notificationsView(
  push: Pick<ManagedPush, 'state' | 'lastReceivedAt'>,
  now = Date.now(),
  delivery: DeliveryStatus | null = null,
): NotificationsView {
  const t = COPY.notifications;
  const last = push.lastReceivedAt ? t.lastReceived(agoText(push.lastReceivedAt / 1000, now)) : null;
  switch (push.state.status) {
    case 'registered': {
      // When Android holds them back, when the last one reached the phone says nothing about the next.
      const held = heldBack(delivery);
      if (held) return held;
      const calm = calmLine(delivery);
      return {
        dot: 'ok',
        title: t.on,
        meta: [t.onMeta, last, calm?.line].filter(Boolean).join(' · '),
        action: calm?.page ? 'delivery' : null,
        ...(calm?.page && { page: calm.page }),
      };
    }
    case 'denied':
      return { dot: 'warn', title: t.denied, meta: t.deniedMeta, action: 'settings' };
    case 'unavailable':
      return { dot: 'mut', title: t.unavailable, meta: t.unavailableMeta, action: null };
    case 'registering':
      return { dot: 'mut', title: t.registering, meta: null, action: null };
    case 'failed':
      return { dot: 'bad', title: t.failed, meta: t.failedMeta, action: 'enable' };
    case 'off':
      return { dot: 'mut', title: t.off, meta: t.offMeta, action: 'enable' };
  }
}
