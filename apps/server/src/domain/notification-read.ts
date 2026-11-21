/**
 * Read state across devices (docs/decisions/review-features.md RF-05; contracts 0.55.0 CT-300): whenever a person's
 * notifications are marked read, `notification.read` goes to their `me` topic with what was read — the ids (at most
 * `NOTIFICATION_READ_IDS_MAX` a frame, more in several), or `ids: null` with `before` for “everything up to then” — and
 * their unread count after it. Published through the transaction's outbox, so it leaves only once the change is
 * committed; nothing is sent when nothing changed.
 *
 * The server's mark-read paths: `notifications.markRead` (some ids, or all; the clients' reading of a conversation or a
 * thread and the opening of a push go through it, AP-704) and a skill proposal's decision, which settles its notices
 * for every decider (`settleProposalNotices`).
 */
import { NOTIFICATION_READ_IDS_MAX, topics } from '@whombat/core';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import { notifications } from '../db/schema/index';
import { iso } from '../lib/time';

/** A principal's unread notifications. */
export async function unreadNotifications(tx: TxSession['tx'], principalId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.principalId, principalId), isNull(notifications.readAt)));
  return n;
}

/** Tells the principal's devices what was read (`ids`), or that everything up to `before` was. */
export async function publishNotificationsRead(
  session: Pick<TxSession, 'tx' | 'publish'>,
  principalId: string,
  read: { ids: readonly string[] } | { before: Date },
  unread?: number,
): Promise<void> {
  if ('ids' in read && read.ids.length === 0) return;
  const left = unread ?? (await unreadNotifications(session.tx, principalId));
  const topic = topics.me(principalId);
  if (!('ids' in read)) {
    session.publish(topic, { type: 'notification.read', ids: null, before: iso(read.before), unread: left });
    return;
  }
  for (let i = 0; i < read.ids.length; i += NOTIFICATION_READ_IDS_MAX)
    session.publish(topic, {
      type: 'notification.read',
      ids: read.ids.slice(i, i + NOTIFICATION_READ_IDS_MAX),
      unread: left,
    });
}
