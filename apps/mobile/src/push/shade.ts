/**
 * Read in the app, gone from the shade (MN-04). Pure: which of the inbox and managed notifications Android shows
 * (`WhombatLive.shade()`) the person has read by now — here, on another device, or by deciding the approval — so
 * `NotificationShadeBridge` cancels them by tag. A notification stands for its inbox row:
 *
 * - a self-hosted inbox push names the row (`notificationId`): read when the cache has that row read, when a
 *   `notification.read` event named it (the cache may not have the row), or when “mark all read” covered the time it
 *   was posted (that burrow only);
 * - a managed push names only an opaque ref (CT-32), one notification per thread or approval (NT-15, the newest of
 *   them): the ref is resolved through the session once (`push.resolve`) to its row's link, and the notification is
 *   read when every cached row with that exact link is; a ref the Whombat no longer resolves (`not_found`) opens
 *   nothing any more, so it goes too.
 *
 * A NEEDS YOU row counts as read once its approval is decided. Anything the app can't tell stays.
 */
import type { InboxItem, InboxResponse, LinkRef } from '@whombat/core';
import type { ShadeNotification } from '../../modules/whombat-live';

/** A managed notification's resolved ref: its row's burrow and link, or `gone` (the Whombat answered `not_found`). */
export type ShadeTarget = { burrow: string; link: LinkRef } | 'gone';

/** Reads this device heard of from `notification.read` events (rows the cache may not hold). */
export interface ShadeReads {
  /** Rows named read. */
  ids: ReadonlySet<string>;
  /** The latest “every row up to” time (epoch ms) of this burrow, or null. */
  allBefore: number | null;
}

/** The most named reads kept (the oldest go first). */
export const SHADE_READS_MAX = 500;

/** Remember what a `notification.read` event said (mutates `reads`; bounded). */
export function noteRead(
  reads: { ids: Set<string>; allBefore: number | null },
  event: { ids: readonly string[] | null; before?: string | undefined },
  now: number,
): void {
  if (event.ids) {
    for (const id of event.ids) {
      reads.ids.delete(id);
      reads.ids.add(id);
    }
    for (const id of reads.ids) {
      if (reads.ids.size <= SHADE_READS_MAX) break;
      reads.ids.delete(id);
    }
    return;
  }
  const before = event.before === undefined ? now : Date.parse(event.before);
  if (!Number.isNaN(before)) reads.allBefore = Math.max(reads.allBefore ?? before, before);
}

/** A link as one string, its keys sorted: the same link from the inbox and from `push.resolve` compares equal. */
export function linkKey(link: LinkRef): string {
  const sorted = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
            .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
        )
      : v;
  return JSON.stringify(sorted(link));
}

/** Read, or a NEEDS YOU row whose approval was decided. */
export function rowDone(row: Pick<InboxItem, 'readAt' | 'approval'>): boolean {
  return row.readAt !== null || (!!row.approval && row.approval.state !== 'pending');
}

/**
 * The rows of every cached inbox of a burrow, once each: a row any copy has read (or decided) counts as read, since a
 * filtered copy may have been patched when another wasn't.
 */
export function inboxRows(inboxes: readonly InboxResponse[]): InboxItem[] {
  const byId = new Map<string, InboxItem>();
  for (const inbox of inboxes)
    for (const section of inbox.sections)
      for (const row of section.items) {
        const seen = byId.get(row.id);
        if (!seen || (!rowDone(seen) && rowDone(row))) byId.set(row.id, row);
      }
  return [...byId.values()];
}

/** The tags of the shade's notifications that are read now (see the file comment). */
export function readInShade(input: {
  shade: readonly ShadeNotification[];
  /** The open burrow (slug); `rows` are its cached inbox rows. */
  burrow: string;
  rows: readonly InboxItem[];
  reads: ShadeReads;
  targets: ReadonlyMap<string, ShadeTarget>;
}): string[] {
  const { shade, burrow, rows, reads, targets } = input;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byLink = new Map<string, InboxItem[]>();
  for (const row of rows) {
    const key = linkKey(row.link);
    byLink.set(key, [...(byLink.get(key) ?? []), row]);
  }
  const read = (n: ShadeNotification): boolean => {
    if (n.notificationId) {
      if (reads.ids.has(n.notificationId)) return true;
      const row = byId.get(n.notificationId);
      if (row) return rowDone(row);
      return n.burrow === burrow && reads.allBefore !== null && n.postedAt <= reads.allBefore;
    }
    if (n.ref) {
      const target = targets.get(n.ref);
      if (target === 'gone') return true;
      if (!target || target.burrow !== burrow) return false;
      const same = byLink.get(linkKey(target.link)) ?? [];
      return same.length > 0 && same.every(rowDone);
    }
    return false;
  };
  return shade.filter(read).map((n) => n.tag);
}

/** The managed notifications whose refs still need resolving. */
export function refsToResolve(
  shade: readonly ShadeNotification[],
  targets: ReadonlyMap<string, ShadeTarget>,
): string[] {
  return [...new Set(shade.flatMap((n) => (n.ref && !targets.has(n.ref) ? [n.ref] : [])))];
}
