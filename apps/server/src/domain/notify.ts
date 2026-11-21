/**
 * Notifications (inbox rows for NEEDS YOU / MENTIONS / DIRECT / REPLIES / FROM AGENTS). Derived from committed changes
 * by post-commit hooks; each row is pushed to the recipient's `me:` topic and, when the recipient has a registered
 * device, as a push (web push / FCM / APNs, or control on a managed Whombat) carrying the same deep link — unless the
 * recipient is in Do not disturb or quiet hours then (the inbox still fills; essentials-people.md EP-14), or active
 * on a client right now (NT-17; “needs you” always pushes).
 *
 * A push shows who and the start of the text (NT-14, `push-preview.ts`) unless the recipient turned previews off;
 * the phone keeps one notification per thread or approval (`group`, NT-15).
 */
import {
  type Approval,
  approvalLiveActivityAudience,
  type InboxItem,
  isQuietNow,
  type LinkRef,
  linkPath,
  type NotificationKind,
  newId,
  notificationPreferencesOf,
  type PushPayload,
  topics,
} from '@whombat/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accounts, approvals, burrows, messages, notifications, principals } from '../db/schema/index';
import { iso } from '../lib/time';
import { devicesForPrincipal } from '../push/devices';
import type { ControlPushOptions } from '../push/sender';
import { shortName } from '../read/principals';
import { approvalForViewer } from '../read/work';
import { presenceFor } from '../realtime/presence-tracker';
import type { Services } from '../services';
import {
  approvalPushGroup,
  buildPushPreview,
  GENERIC_PUSH_TITLE,
  genericPushText,
  threadPushGroup,
} from './push-preview';

/**
 * No push for someone who used a client this recently (NT-17): long enough for a quick answer while they're still
 * looking, short enough that putting the phone away doesn't swallow the next one.
 */
export const PUSH_HOLD_ACTIVE_MS = 60_000;

export interface NotificationDraft {
  burrowId: string;
  /** The burrow's slug, to build the push payload's deep link (`linkPath`). Push is skipped without it. */
  burrowSlug?: string;
  principalId: string;
  kind: NotificationKind;
  actorId: string;
  where: string;
  text: string;
  link: LinkRef;
  approvalId?: string | null;
  createdAt: Date;
  /**
   * Notify once per recipient and key (work-supervision WS-20): a second draft with a key the recipient already
   * has is dropped, here and across commits (a unique index).
   */
  dedupKey?: string | null;
  /** The message the row is about: the email leaves it out once read in its conversation (EP-14). */
  messageId?: string | null;
  /** What the push preview says instead of `text` (a message's text with its code left out, NT-14). */
  previewText?: string;
  /**
   * The phone keeps one notification per group (NT-15): `thread:<conversationId>:<rootId|main>`,
   * `approval:<approvalId>`. Absent = this notification alone.
   */
  group?: string;
  /**
   * No push for this one: the recipient reads it elsewhere right now — the assistant's answer on their unlocked desk
   * screen (desk-display-talk.md DK-T13). The inbox row and its realtime frame stay.
   */
  pushHeld?: boolean;
}

/** Whether a recipient's push waits now (Do not disturb or quiet hours, in their zone, else the burrow's). */
export type QuietLookup = (principalId: string) => boolean;

/**
 * Recipients still in the burrow, whose push is held back right now (EP-14), and who turned push previews off
 * (NT-14).
 */
async function recipientsOf(
  services: Services,
  drafts: readonly NotificationDraft[],
): Promise<{ quiet: QuietLookup; noPreviews: Set<string> }> {
  const ids = [...new Set(drafts.map((d) => d.principalId))];
  const rows = await services.db
    .select({
      id: principals.id,
      preferences: accounts.preferences,
      burrowZone: burrows.timeZone,
    })
    .from(principals)
    .innerJoin(burrows, eq(burrows.id, principals.burrowId))
    .leftJoin(accounts, eq(accounts.id, principals.accountId))
    .where(inArray(principals.id, ids));
  const now = services.clock();
  const quiet = new Map<string, boolean>();
  const noPreviews = new Set<string>();
  for (const r of rows) {
    if (!r.preferences) continue;
    const prefs = notificationPreferencesOf(r.preferences);
    quiet.set(r.id, isQuietNow(prefs, now, zoneOf(r.preferences.timeZone, r.burrowZone)));
    if (prefs.previews === false) noPreviews.add(r.id);
  }
  return { quiet: (id) => quiet.get(id) ?? false, noPreviews };
}

/** The actors' short names (“Dusty”), for push titles. */
async function actorNames(
  services: Services,
  drafts: readonly NotificationDraft[],
): Promise<Map<string, string>> {
  const ids = [...new Set(drafts.map((d) => d.actorId))];
  const rows = ids.length
    ? await services.db
        .select({
          id: principals.id,
          kind: principals.kind,
          name: principals.name,
          shortName: principals.shortName,
        })
        .from(principals)
        .where(inArray(principals.id, ids))
    : [];
  return new Map(rows.map((r) => [r.id, shortName(r)]));
}

/** A person's zone: their own, else the burrow's, else UTC (an unknown zone reads as UTC). */
export function zoneOf(own: string | null | undefined, burrowZone: string | null | undefined): string {
  for (const zone of [own, burrowZone]) {
    if (!zone) continue;
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: zone });
      return zone;
    } catch {
      // not a zone this runtime knows
    }
  }
  return 'UTC';
}

export async function notify(services: Services, all: readonly NotificationDraft[]): Promise<void> {
  const seen = new Set<string>();
  const deduped = all.filter((d) => {
    if (!d.dedupKey) return true;
    const key = `${d.principalId}\u0000${d.dedupKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length === 0) return;
  const { quiet, noPreviews } = await recipientsOf(services, deduped);
  const drafts = deduped;
  if (drafts.length === 0) return;
  const names = await actorNames(services, drafts);
  const presence = presenceFor(services);
  const ids = drafts.map(() => newId('notification'));
  const inserted = await services.db
    .insert(notifications)
    .values(
      drafts.map((d, i) => ({
        id: ids[i] as string,
        burrowId: d.burrowId,
        principalId: d.principalId,
        kind: d.kind,
        actorId: d.actorId,
        where: d.where.slice(0, 120),
        text: d.text.slice(0, 500),
        link: d.link,
        approvalId: d.approvalId ?? null,
        createdAt: d.createdAt,
        dedupKey: d.dedupKey ?? null,
        messageId: d.messageId ?? null,
      })),
    )
    // A key the recipient already has: that notification was sent (WS-20).
    .onConflictDoNothing()
    .returning();
  const byId = new Map(inserted.map((r) => [r.id, r]));
  // Each approval once, however many approvers are told about it.
  const approvalIds = [...new Set(inserted.flatMap((r) => (r.approvalId ? [r.approvalId] : [])))];
  const approvalRows = approvalIds.length
    ? new Map(
        (await services.db.select().from(approvals).where(inArray(approvals.id, approvalIds))).map((a) => [
          a.id,
          a,
        ]),
      )
    : new Map<string, typeof approvals.$inferSelect>();
  const pushes: { principalId: string; payload: PushPayload; options: ControlPushOptions }[] = [];
  for (const [i, id] of ids.entries()) {
    const row = byId.get(id);
    if (!row) continue;
    let approval: InboxItem['approval'] = null;
    if (row.approvalId) {
      const a = approvalRows.get(row.approvalId);
      // Its recipient may be an approver outside the conversation (SEC-PACK-ARGS).
      approval = a ? await approvalForViewer(services.db, row.principalId, a) : null;
    }
    const item: InboxItem = {
      id: row.id,
      burrowId: row.burrowId,
      principalId: row.principalId,
      kind: row.kind,
      actorId: row.actorId,
      where: row.where,
      text: row.text,
      link: row.link,
      approvalId: row.approvalId,
      createdAt: iso(row.createdAt),
      readAt: null,
      approval,
    };
    services.bus.publish({
      topic: topics.me(row.principalId),
      event: { type: 'notification.created', item },
      eventId: null,
      at: iso(row.createdAt),
      outboxId: null,
    });
    const draft = drafts[i];
    const burrowSlug = draft?.burrowSlug;
    if (!draft || !burrowSlug) continue;
    // Do not disturb and quiet hours hold push back; the row above is in the inbox already (EP-14). So does reading it
    // on the desk screen (DK-T13).
    if (draft.pushHeld || quiet(row.principalId)) continue;
    // Someone who used a client in the last minute sees it there (NT-17); what needs them always buzzes.
    if (row.kind !== 'needs_you' && presence.activeWithin(row.principalId, PUSH_HOLD_ACTIVE_MS)) continue;
    const preview = noPreviews.has(row.principalId)
      ? null
      : buildPushPreview({
          kind: row.kind,
          actor: names.get(row.actorId) ?? GENERIC_PUSH_TITLE,
          where: row.where,
          text: draft.previewText ?? row.text,
        });
    pushes.push({
      principalId: row.principalId,
      payload: {
        burrow: burrowSlug,
        notificationId: row.id,
        kind: row.kind,
        // Previews off: the same generic words the phone shows (NT-14).
        title: preview?.title ?? GENERIC_PUSH_TITLE,
        body: preview?.body ?? genericPushText(row.kind),
        path: linkPath(burrowSlug, row.link),
      },
      options: {
        ...(draft.group ? { group: draft.group } : {}),
        ...(preview ? { preview } : {}),
      },
    });
  }
  // Delivery doesn't hold up whoever caused the notification (server-efficiency.md SV-02): transports retry with
  // backoff, and a slow one would hold the sender's response. In the order of the rows, as before; one that fails
  // doesn't stop the rest.
  if (pushes.length)
    services.background.run('push', async () => {
      for (const { principalId, payload, options } of pushes) {
        try {
          // Managed: a request to control for the recipient's enrolled endpoints, the preview at most (MR-13, NT-14).
          await services.push.control?.([principalId], payload, options);
          const devices = await devicesForPrincipal(services.db, principalId);
          if (devices.length) await services.push.sendAll(devices, payload);
        } catch (err) {
          services.log.warn({ err: String(err) }, 'push: a notification wasn’t sent');
        }
      }
    });
}

/** Approvals whose notifications were cleared, per push sender (once each, NT-16); the oldest go past the cap. */
const clearedApprovals = new WeakMap<object, Set<string>>();
const CLEARED_APPROVALS_MAX = 10_000;

/**
 * An approval left `pending` (approved, declined, expired): on a managed Whombat its “needs you” notification goes
 * from the approvers' phones (NT-16), once per approval. Content-free; nothing on a self-hosted one.
 */
export async function clearDecidedApproval(
  services: Services,
  approval: Approval,
  burrowSlug: string,
): Promise<void> {
  const control = services.push.control;
  if (!control || approval.state === 'pending') return;
  let cleared = clearedApprovals.get(services.push);
  if (!cleared) {
    cleared = new Set();
    clearedApprovals.set(services.push, cleared);
  }
  if (cleared.has(approval.id)) return;
  cleared.add(approval.id);
  if (cleared.size > CLEARED_APPROVALS_MAX) cleared.delete(cleared.values().next().value as string);
  const approvers = approvalLiveActivityAudience(approval);
  if (approvers.length === 0) return;
  await control(
    approvers,
    {
      burrow: burrowSlug,
      notificationId: null,
      kind: 'approval_updated',
      title: GENERIC_PUSH_TITLE,
      body: '',
      path: `/${burrowSlug}`,
      approval: { number: approval.number, state: approval.state, label: '' },
    },
    { group: approvalPushGroup(approval.id), clear: true },
  );
}

/** Threads whose notifications were cleared, per push sender: `principal|group|newest read row` (NT-16's guard). */
const clearedThreads = new WeakMap<object, Set<string>>();

/**
 * Notifications were just read (`notifications.markRead`, docs/decisions/review-features.md RF-09): on a managed
 * Whombat each thread they were about (NT-15's group, `thread:<conversationId>:<rootId|main>`) leaves the person's
 * phones once nothing in it is unread for them any more — a content-free `clear`, as NT-16 does for a decided
 * approval. Only groups with a row that was unread until now (`readIds`, what the mark-read just changed), so a read
 * marker moving over nothing new clears nothing; once per group and newest read row per process. Nothing on a
 * self-hosted Whombat.
 */
export async function clearReadThreads(
  services: Services,
  principalId: string,
  readIds: readonly string[],
): Promise<void> {
  const control = services.push.control;
  if (!control || readIds.length === 0) return;
  const db = services.db;
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      burrowId: notifications.burrowId,
      createdAt: notifications.createdAt,
      conversationId: messages.conversationId,
      threadRootId: messages.threadRootId,
    })
    .from(notifications)
    .innerJoin(messages, eq(messages.id, notifications.messageId))
    .where(and(inArray(notifications.id, [...readIds]), eq(notifications.principalId, principalId)));
  const groups = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const group = threadPushGroup(r.conversationId, r.threadRootId);
    const newest = groups.get(group);
    if (!newest || newest.createdAt < r.createdAt) groups.set(group, r);
  }
  if (groups.size === 0) return;
  let cleared = clearedThreads.get(services.push);
  if (!cleared) {
    cleared = new Set();
    clearedThreads.set(services.push, cleared);
  }
  for (const [group, newest] of groups) {
    // Something there still unread: its notification stays.
    const [left] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .innerJoin(messages, eq(messages.id, notifications.messageId))
      .where(
        and(
          eq(notifications.principalId, principalId),
          isNull(notifications.readAt),
          eq(messages.conversationId, newest.conversationId),
          newest.threadRootId
            ? eq(messages.threadRootId, newest.threadRootId)
            : isNull(messages.threadRootId),
        ),
      )
      .limit(1);
    if (left) continue;
    const key = `${principalId}|${group}|${newest.id}`;
    if (cleared.has(key)) continue;
    cleared.add(key);
    if (cleared.size > CLEARED_APPROVALS_MAX) cleared.delete(cleared.values().next().value as string);
    const [burrow] = await db
      .select({ slug: burrows.slug })
      .from(burrows)
      .where(eq(burrows.id, newest.burrowId));
    if (!burrow) continue;
    await control(
      [principalId],
      {
        burrow: burrow.slug,
        notificationId: null,
        kind: newest.kind === 'needs_you' ? 'reply' : newest.kind,
        title: GENERIC_PUSH_TITLE,
        body: '',
        path: `/${burrow.slug}`,
      },
      { group, clear: true },
    );
  }
}
