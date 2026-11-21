/**
 * The customer's answers wake the agent (docs/decisions/report-trackers.md TA-31): on each poll the poller also looks
 * at the reports an automation ran for that are still open, and tells from what it saw last (`tracker_items.seen_*`)
 * whether the reporter wrote back (a message not by the tracker's team), reopened it (“Still happening”: `new`, with
 * their message) or said it works (`confirmed`). The first sight of a report is its baseline: history starts nothing.
 * Whombat's own writes are the tracker team's, and it never sets `new` or `confirmed`, so they never count.
 *
 * `tracker.reporter_replied` keeps the customer's new words (`tracker_replies`, for the run's `trigger.text`) and
 * signs an event of ids only, as TA-07 does; the engine starts the automations listening to `reporter_replied` in the
 * report's thread. “It works” starts nothing: the thread says so and the fix is `confirmed` (`customerSaid`).
 */
import { randomIdBody } from '@whombat/core';
import { and, desc, eq, gt, isNull, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { catalogConnections, trackerItems, trackerReplies } from '../db/schema/index';
import { forbidden, notFound } from '../lib/errors';
import { loadPrincipalRow } from '../read/principals';
import type { TrackerItem } from './driver';
import { TEXT_REPLY_MAX } from './items';
import { isTrackerPrincipal } from './principal';

/**
 * Statuses after which a report is watched only a while longer (`FINAL_WATCH_MS`): a person closed it, or the customer
 * said it works — they can still say it happens again.
 */
export const UNWATCHED_STATUSES = ['closed', 'not_planned', 'duplicate', 'confirmed'];
/** How long a closed or confirmed report is still watched after its last change (a late “Still happening”). */
export const FINAL_WATCH_MS = 30 * 86_400_000;

/** What the poller saw of a report: its status, its tracker's last change, and the reporter's messages so far. */
export interface Seen {
  status: string;
  updatedAt: Date;
  reporterMessages: number;
  reporterAt: Date | null;
}

/** The reporter's messages of a report (not the team's, which is how Whombat's own replies arrive). */
export function reporterMessages(
  report: Pick<TrackerItem, 'messages'>,
): { body: string; at: string | null }[] {
  return report.messages.filter((m) => m.author === 'reporter').map((m) => ({ body: m.body, at: m.at }));
}

/** What the poller sees of a report now. */
export function seenOf(report: Pick<TrackerItem, 'status' | 'updatedAt' | 'messages'>): Seen {
  const mine = reporterMessages(report);
  const last = mine
    .map((m) => (m.at ? Date.parse(m.at) : Number.NaN))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  const updated = Date.parse(report.updatedAt);
  return {
    status: report.status,
    updatedAt: new Date(Number.isNaN(updated) ? 0 : updated),
    reporterMessages: mine.length,
    reporterAt: last === undefined ? null : new Date(last),
  };
}

/**
 * What the customer did since the poller last looked (TA-31), or null (nothing, or only the team's changes): `confirmed`
 * — “It works”; `reopened` — back to `new` with a message of theirs (“Still happening”; a team reopen has none);
 * `wrote` — a new message. With the new messages' text, oldest first, cut.
 */
export function customerAnswer(
  before: Seen,
  report: Pick<TrackerItem, 'status' | 'updatedAt' | 'messages'>,
): { event: 'wrote' | 'reopened' | 'confirmed'; text: string } | null {
  const now = seenOf(report);
  const fresh = reporterMessages(report).slice(before.reporterMessages);
  const text = cutText(
    fresh
      .map((m) => m.body.trim())
      .filter(Boolean)
      .join('\n\n'),
  );
  if (now.status === 'confirmed' && before.status !== 'confirmed') return { event: 'confirmed', text };
  if (!fresh.length) return null;
  if (now.status === 'new' && before.status !== 'new') return { event: 'reopened', text };
  return { event: 'wrote', text };
}

function cutText(text: string): string {
  const max = TEXT_REPLY_MAX + 500;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Whether the poller's view of a report changed at all. */
export function changed(before: Seen, now: Seen): boolean {
  return (
    before.status !== now.status ||
    before.updatedAt.getTime() !== now.updatedAt.getTime() ||
    before.reporterMessages !== now.reporterMessages
  );
}

/** The poller's view as the row's columns. */
export function seenColumns(seen: Seen) {
  return {
    seenStatus: seen.status.slice(0, 40),
    seenUpdatedAt: seen.updatedAt,
    seenReporterMessages: seen.reporterMessages,
    seenReporterAt: seen.reporterAt,
  };
}

/** A watched report: a mirrored one of the connection an automation ran for (not a test run), still open. */
export interface Watched {
  id: string;
  burrowId: string;
  externalId: string;
  number: number;
  seen: Seen | null;
}

/**
 * The reports of a connection the poller watches for the customer's answers (TA-31), newest first. All of them: the
 * poll reads a few pages, and the ones deeper down a few at a time in turn, so none is left out however many there are.
 */
export async function watchedReports(db: Db, connectionId: string): Promise<Watched[]> {
  const rows = await db
    .select()
    .from(trackerItems)
    .where(
      and(
        eq(trackerItems.connectionId, connectionId),
        or(
          isNull(trackerItems.seenStatus),
          notInArray(trackerItems.seenStatus, UNWATCHED_STATUSES),
          gt(trackerItems.seenUpdatedAt, new Date(Date.now() - FINAL_WATCH_MS)),
        ),
        sql`exists (select 1 from automation_runs ar where ar.burrow_id = ${trackerItems.burrowId}
          and ar.test = false
          and ar.item_key = 'tracker:' || ${trackerItems.connectionId} || '#' || ${trackerItems.number}::text)`,
      ),
    )
    .orderBy(desc(trackerItems.number));
  return rows.map((r) => ({
    id: r.id,
    burrowId: r.burrowId,
    externalId: r.externalId,
    number: r.number,
    seen:
      r.seenStatus !== null && r.seenUpdatedAt !== null
        ? {
            status: r.seenStatus,
            updatedAt: r.seenUpdatedAt,
            reporterMessages: r.seenReporterMessages ?? 0,
            reporterAt: r.seenReporterAt,
          }
        : null,
  }));
}

/** Records what the poller saw without anything to tell (bookkeeping, like the cursor). */
export async function noteSeen(db: Db, rowId: string, seen: Seen): Promise<void> {
  await db.update(trackerItems).set(seenColumns(seen)).where(eq(trackerItems.id, rowId));
}

/** A `tracker_replies` row's id. */
function replyRowId(): string {
  return `trr_${randomIdBody(12)}`;
}

/**
 * `tracker.reporter_replied` (the burrow's tracker principal, TA-31): what the poller now saw of the report, the
 * customer's new words kept for the run's `trigger.text`, and a signed event of ids only — the engine's
 * `reporter_replied` trigger. “It works” is signed too (no automation starts on it).
 */
export const reporterReplied = defineCommand({
  name: 'tracker.reporter_replied',
  schema: z.object({
    rowId: z.string(),
    event: z.enum(['wrote', 'reopened', 'confirmed']),
    text: z.string().max(TEXT_REPLY_MAX + 500),
    seen: z.object({
      status: z.string().min(1).max(40),
      updatedAt: z.string(),
      reporterMessages: z.number().int().nonnegative(),
      reporterAt: z.string().nullable(),
    }),
  }),
  async apply(tx, ctx, input) {
    if (!isTrackerPrincipal(await loadPrincipalRow(tx, ctx.actor.id)))
      throw forbidden('Only Whombat’s tracker signer records what a customer wrote back.');
    const [row] = await tx
      .select({ r: trackerItems, label: catalogConnections.label })
      .from(trackerItems)
      .innerJoin(catalogConnections, eq(catalogConnections.id, trackerItems.connectionId))
      .where(eq(trackerItems.id, input.rowId))
      .for('update');
    if (!row || row.r.burrowId !== ctx.burrow.id) throw notFound('Report');
    const seen: Seen = {
      status: input.seen.status,
      updatedAt: new Date(input.seen.updatedAt),
      reporterMessages: input.seen.reporterMessages,
      reporterAt: input.seen.reporterAt ? new Date(input.seen.reporterAt) : null,
    };
    // Seen already (a second poll that raced this one): nothing new.
    if (
      row.r.seenUpdatedAt &&
      row.r.seenUpdatedAt.getTime() === seen.updatedAt.getTime() &&
      row.r.seenStatus === seen.status &&
      (row.r.seenReporterMessages ?? 0) === seen.reporterMessages
    )
      return { replyId: null };
    await tx.update(trackerItems).set(seenColumns(seen)).where(eq(trackerItems.id, row.r.id));
    const replyId = replyRowId();
    await tx.insert(trackerReplies).values({
      id: replyId,
      burrowId: ctx.burrow.id,
      reportRowId: row.r.id,
      event: input.event,
      text: input.text,
      status: seen.status,
      createdAt: ctx.now,
    });
    const what =
      input.event === 'confirmed'
        ? 'says the fix works'
        : input.event === 'reopened'
          ? 'says it still happens'
          : 'wrote back';
    await ctx.emit({
      type: 'tracker.reporter_replied',
      kind: 'System',
      text: `The customer of #${row.r.number} in ${row.label} ${what}`,
      where: row.label,
      payload: {
        rowId: row.r.id,
        replyId,
        connectionId: row.r.connectionId,
        reportId: row.r.externalId,
        number: row.r.number,
        type: row.r.kind,
        event: input.event,
      },
    });
    return { replyId };
  },
});

/** A kept answer of the customer: its event and words (null: gone). */
export async function replyOf(
  db: Db,
  replyId: string,
): Promise<{ event: 'wrote' | 'reopened' | 'confirmed'; text: string; reportRowId: string } | null> {
  const [row] = await db.select().from(trackerReplies).where(eq(trackerReplies.id, replyId));
  return row ? { event: row.event, text: row.text, reportRowId: row.reportRowId } : null;
}
