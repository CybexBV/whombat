/**
 * A new tracker report, mirrored once (docs/decisions/report-trackers.md TA-07): stored per connection and the
 * tracker's id with its signed `tracker.item_opened` — the event automations start on. Signed by the burrow's tracker
 * principal, with ids, number, type and connection only (no customer words in a signed event), and nothing posted in a
 * room. Polling again changes nothing. A row mirrored before Whombat kept the organization's id gets it from a later
 * poll.
 */
import { randomIdBody, TrackerItemKind } from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { trackerItems } from '../db/schema/index';
import { forbidden, notFound } from '../lib/errors';
import { loadPrincipalRow } from '../read/principals';
import { trackerConnectionRow } from './connection';
import { isTrackerPrincipal } from './principal';

/** A `tracker_items` row's id: core has no id kind for it, so `newId`'s shape with its own prefix. */
function trackerItemRowId(): string {
  return `trp_${randomIdBody(12)}`;
}

export const MirroredReportInput = z.object({
  reportId: z.string().min(1).max(100),
  number: z.number().int().positive(),
  type: TrackerItemKind,
  title: z.string().min(1).max(300),
  organization: z.string().max(200).nullable(),
  /** The tracker's id of it (TA-60); absent from a client that predates it. */
  organizationId: z.string().max(200).nullable().optional(),
  environment: z.string().max(100).nullable(),
  version: z.string().max(64).nullable(),
  page: z.string().max(160).nullable(),
  browser: z.string().max(120).nullable(),
  status: z.string().min(1).max(40),
  priority: z.string().max(40).nullable(),
  description: z.string().max(8000),
  expected: z.string().max(3000),
  hasScreenshot: z.boolean(),
  hasDiagnostics: z.boolean(),
  reportedAt: z.string().nullable(),
});

/** What the poller saw of the report as it mirrored it (TA-31's baseline): its status, last change and the reporter's messages. */
const SeenInput = z.object({
  status: z.string().min(1).max(40),
  updatedAt: z.string(),
  reporterMessages: z.number().int().nonnegative(),
  reporterAt: z.string().nullable(),
});

export const mirrorTrackerItem = defineCommand({
  name: 'tracker.item_opened',
  schema: z.object({
    connectionId: z.string(),
    /** What the tracker is called (its driver's `words.product`), kept with the report for its runs' words. */
    product: z.string().trim().min(1).max(40).default('the tracker'),
    report: MirroredReportInput,
    seen: SeenInput.optional(),
  }),
  async apply(tx, ctx, input) {
    if (!isTrackerPrincipal(await loadPrincipalRow(tx, ctx.actor.id)))
      throw forbidden('Only Whombat’s tracker signer records new reports.');
    const connection = await trackerConnectionRow(tx, ctx.burrow.id, input.connectionId);
    if (!connection) throw notFound('Tracker connection');
    const r = input.report;
    const id = trackerItemRowId();
    const [stored] = await tx
      .insert(trackerItems)
      .values({
        id,
        burrowId: ctx.burrow.id,
        connectionId: connection.id,
        externalId: r.reportId,
        product: input.product,
        number: r.number,
        kind: r.type,
        title: r.title,
        organization: r.organization,
        organizationId: r.organizationId ?? null,
        environment: r.environment,
        version: r.version,
        page: r.page,
        browser: r.browser,
        status: r.status,
        priority: r.priority,
        hasScreenshot: r.hasScreenshot,
        hasDiagnostics: r.hasDiagnostics,
        description: r.description,
        expected: r.expected,
        reportedAt: r.reportedAt ? new Date(r.reportedAt) : null,
        mirroredAt: ctx.now,
        ...(input.seen
          ? {
              seenStatus: input.seen.status,
              seenUpdatedAt: new Date(input.seen.updatedAt),
              seenReporterMessages: input.seen.reporterMessages,
              seenReporterAt: input.seen.reporterAt ? new Date(input.seen.reporterAt) : null,
            }
          : {}),
      })
      .onConflictDoNothing()
      .returning({ id: trackerItems.id });
    if (!stored) return { rowId: null, created: false };
    await ctx.emit({
      type: 'tracker.item_opened',
      kind: 'System',
      text: `New ${r.type === 'feature' ? 'feature request' : 'bug report'} #${r.number} in ${connection.label}`,
      where: connection.label,
      payload: {
        rowId: id,
        connectionId: connection.id,
        reportId: r.reportId,
        number: r.number,
        type: r.type,
      },
    });
    return { rowId: id, created: true };
  },
});

/** Reports one cycle fills in the tracker's organization id for at most. */
export const ORGANIZATIONS_PER_CYCLE = 100;

/**
 * The tracker's organization id for mirrored reports that have none: rows mirrored before Whombat kept it, filled in
 * from what the poller read. Never overwrites an id that is set, so a repeat changes nothing; no signed event (nothing
 * happened that anyone is told about). Answers how many rows it filled in.
 */
export const noteReportOrganizations = defineCommand({
  name: 'tracker.item_organizations',
  schema: z.object({
    connectionId: z.string(),
    reports: z
      .array(
        z.object({
          reportId: z.string().min(1).max(100),
          organizationId: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(ORGANIZATIONS_PER_CYCLE),
  }),
  async apply(tx, ctx, input) {
    if (!isTrackerPrincipal(await loadPrincipalRow(tx, ctx.actor.id)))
      throw forbidden('Only Whombat’s tracker signer records what a tracker says of its reports.');
    const connection = await trackerConnectionRow(tx, ctx.burrow.id, input.connectionId);
    if (!connection) throw notFound('Tracker connection');
    let filled = 0;
    for (const r of input.reports) {
      const rows = await tx
        .update(trackerItems)
        .set({ organizationId: r.organizationId })
        .where(
          and(
            eq(trackerItems.connectionId, connection.id),
            eq(trackerItems.externalId, r.reportId),
            isNull(trackerItems.organizationId),
          ),
        )
        .returning({ id: trackerItems.id });
      filled += rows.length;
    }
    return { filled };
  },
});
