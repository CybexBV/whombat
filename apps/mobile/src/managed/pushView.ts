/** What the notifications row says for a push state (pure; `NotificationsRow.tsx` draws it). */
import { agoText } from '@whombat/client/managed';
import type { ManagedPush } from './context';
import { COPY } from './copy';

export type Dot = 'ok' | 'warn' | 'bad' | 'mut';

export function notificationsView(push: Pick<ManagedPush, 'state' | 'lastReceivedAt'>, now = Date.now()) {
  const t = COPY.notifications;
  const last = push.lastReceivedAt ? t.lastReceived(agoText(push.lastReceivedAt / 1000, now)) : null;
  switch (push.state.status) {
    case 'registered':
      return {
        dot: 'ok' as Dot,
        title: t.on,
        meta: [t.onMeta, last].filter(Boolean).join(' · '),
        action: null,
      };
    case 'denied':
      return { dot: 'warn' as Dot, title: t.denied, meta: t.deniedMeta, action: 'settings' as const };
    case 'unavailable':
      return { dot: 'mut' as Dot, title: t.unavailable, meta: t.unavailableMeta, action: null };
    case 'registering':
      return { dot: 'mut' as Dot, title: t.registering, meta: null, action: null };
    case 'failed':
      return { dot: 'bad' as Dot, title: t.failed, meta: t.failedMeta, action: 'enable' as const };
    case 'off':
      return { dot: 'mut' as Dot, title: t.off, meta: t.offMeta, action: 'enable' as const };
  }
}
