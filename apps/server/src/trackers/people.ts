/**
 * People act on a run's tracker report (docs/decisions/report-trackers.md TA-14…TA-16): `tracker.item` reads it live
 * for whoever can see the run — the reporter's name and email included (people only, FB-F08 is about agents) — and
 * `tracker.update` sends a public reply and/or a status as a person who may publish automations: the write reaches the
 * tracker first, with the client's request id (the tracker replays a known one, so a retry after a lost answer emails
 * nothing twice), then `tracker.item_updated` posts what was sent in the run's thread as that person — once per request
 * id. Never an agent: there is no tool. Status isn't mirrored: the tracker is the system of record.
 */
import {
  TRACKER_REPLY_MAX,
  TRACKER_SCREENSHOT_MAX_BYTES,
  type TrackerFixView,
  type TrackerItemView,
  type TrackerUpdateBody,
  type TrackerWords,
  trackerStatusLabel,
  UNKNOWN_TRACKER_WORDS,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { BurrowAccess } from '../auth/request';
import { loadRunRow } from '../automations/store';
import { defineCommand } from '../commit/types';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db } from '../db/client';
import { trackerUpdates } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import type { Services } from '../services';
import { tokenRefused, trackerConnectionRow, trackerWords } from './connection';
import type { TrackerItemFull } from './driver';
import { SourceProblem, TrackerConflict, TrackerNotFound, TrackerRefusal } from './errors';
import { latestFix } from './fixes';
import { scopeReport } from './items';

/** Whether a person may reply to the reporter and set the status (TA-15): people who may publish automations. */
export function mayUpdate(access: Pick<BurrowAccess, 'principal'>): boolean {
  // The person may do whatever people may (one-person.md OP-S07).
  return access.principal.kind === 'person';
}

/** A run the viewer can see that started from a tracker's report, with its connection (else 404). */
export async function runReport(
  services: Services,
  access: BurrowAccess,
  runId: string,
): Promise<{
  run: Awaited<ReturnType<typeof loadRunRow>>;
  report: NonNullable<ReturnType<typeof scopeReport>>;
  connection: CatalogConnectionRow;
}> {
  let run: Awaited<ReturnType<typeof loadRunRow>>;
  try {
    run = await loadRunRow(services.db, runId);
  } catch {
    throw notFound('Automation run');
  }
  if (run.burrowId !== access.burrow.id) throw notFound('Automation run');
  const report = scopeReport(run.scope);
  if (!report) throw notFound('Report');
  const connection = await trackerConnectionRow(services.db, run.burrowId, report.connectionId);
  if (!connection) throw conflict('The tracker connection this run started from is gone.');
  return { run, report, connection };
}

/** A tracker's failure as the API answers it; a refused token also marks the connection (TA-03). */
async function trackerFailure(
  services: Services,
  connection: CatalogConnectionRow,
  err: unknown,
): Promise<never> {
  if (err instanceof ApiError) throw err;
  if (err instanceof TrackerNotFound) throw notFound('Report');
  if (err instanceof TrackerRefusal)
    throw badRequest(
      `${trackerWords(services, connection).product} refused it: ${err.message}`.slice(0, 500),
    );
  if (err instanceof SourceProblem && err.code === 'refused') await tokenRefused(services, connection.id);
  throw new ApiError(
    'conflict',
    err instanceof Error ? err.message.slice(0, 500) : `${connection.label} couldn’t be reached.`,
  );
}

function opt(value: string | null | undefined, max: number): string | null {
  const v = (value ?? '').trim();
  return v ? v.slice(0, max) : null;
}

/** The screenshot as a data URL people's clients show, when it is an image within `TRACKER_SCREENSHOT_MAX_BYTES`. */
function screenshotOf(item: TrackerItemFull): string | null {
  const url = item.screenshot ?? '';
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (!m?.[2]) return null;
  const bytes = Math.floor((m[2].replace(/\s+/g, '').length * 3) / 4);
  return bytes <= TRACKER_SCREENSHOT_MAX_BYTES ? url.replace(/\s+/g, '') : null;
}

/** A report as people read it on the run page (TA-14), with the fix Whombat follows for it (TA-29). */
export function reportView(
  connection: CatalogConnectionRow,
  report: TrackerItemFull,
  fix: TrackerFixView | null = null,
  words: TrackerWords = UNKNOWN_TRACKER_WORDS,
): TrackerItemView {
  const created = Date.parse(report.createdAt);
  const release = report.release;
  return {
    connectionId: connection.id,
    connection: connection.label.slice(0, 80),
    words,
    reportId: report.id,
    number: Math.max(1, report.number),
    title: (report.title ?? '').slice(0, 300) || `Report #${report.number}`,
    type: report.kind,
    organization: opt(report.organization.name, 200),
    environment: report.environment,
    status: report.status.slice(0, 40),
    priority: opt(report.priority, 40),
    assessment: opt(report.assessment, 40),
    createdAt: new Date(Number.isNaN(created) ? 0 : created).toISOString(),
    reporter: { name: opt(report.reporter.name, 200), email: opt(report.reporter.email, 320) },
    description: report.description ?? '',
    expected: report.expected ?? '',
    screenshot: screenshotOf(report),
    messages: report.messages
      .filter((m): m is typeof m & { at: string } => !!m.at)
      .slice(-200)
      .map((m) => ({
        author: m.author,
        body: m.body.slice(0, TRACKER_REPLY_MAX * 2),
        at: new Date(Date.parse(m.at) || 0).toISOString(),
      })),
    release: release
      ? {
          component: release.component.slice(0, 100),
          version: release.version.slice(0, 100),
          evidence: (release.evidence ?? '').slice(0, 2000),
        }
      : null,
    fix,
  };
}

/** The report of a run, read live (TA-14). */
async function readReport(
  services: Services,
  connection: CatalogConnectionRow,
  reportId: string,
): Promise<TrackerItemFull> {
  try {
    return await services.tracker.driverFor(connection).item(reportId);
  } catch (err) {
    return trackerFailure(services, connection, err);
  }
}

/** `tracker.item` (TA-14). */
export async function trackerItemOp(
  services: Services,
  access: BurrowAccess,
  runId: string,
): Promise<{ report: TrackerItemView; can: { update: boolean } }> {
  const { report, connection } = await runReport(services, access, runId);
  const live = await readReport(services, connection, report.reportId);
  const fix = await latestFix(services.db, connection.id, report.reportId);
  return {
    report: reportView(connection, live, fix, trackerWords(services, connection)),
    can: { update: mayUpdate(access) },
  };
}

/** The line a person's reply or status adds to the run's thread (TA-15). */
export function updateLine(
  connection: string,
  number: number,
  body: { message?: string | undefined; status?: string | undefined; product?: string | undefined },
): string {
  const parts: string[] = [];
  if (body.message)
    parts.push(`Reply to the reporter, sent through ${body.product ?? 'the tracker'}:\n\n${body.message}`);
  if (body.status) parts.push(`Set ${connection} #${number} to ${trackerStatusLabel(body.status)}.`);
  return parts.join('\n\n');
}

/**
 * `tracker.update` (TA-15): the write to the tracker first (by its driver, with the client's request id, once more after
 * a conflict), then the thread line in one commit. A retry with the same request id is replayed by the tracker and
 * finds the line it posted.
 */
export async function trackerUpdateOp(
  services: Services,
  access: BurrowAccess,
  runId: string,
  body: TrackerUpdateBody,
): Promise<{ report: TrackerItemView; messageId: string }> {
  if (access.principal.kind !== 'person') throw forbidden('Only people answer the reporter.');
  if (!mayUpdate(access))
    throw forbidden('Only people who may publish automations can reply to the reporter or set the status.');
  const { report, connection } = await runReport(services, access, runId);
  const words = trackerWords(services, connection);
  try {
    await services.tracker.driverFor(connection).send(report.reportId, {
      requestId: body.requestId,
      ...(body.message ? { message: body.message } : {}),
      status: () => body.status ?? null,
    });
  } catch (err) {
    if (err instanceof TrackerConflict)
      throw conflict(
        `The report changed in ${words.product} while you wrote: open it again and send once more.`,
      );
    return trackerFailure(services, connection, err);
  }
  const now = await readReport(services, connection, report.reportId);
  const res = await services.pipeline.commit(
    reportUpdated,
    {
      runId,
      requestId: body.requestId,
      connection: connection.label,
      product: words.product,
      number: report.number,
      ...(body.message ? { message: body.message } : {}),
      ...(body.status ? { status: body.status } : {}),
    },
    { burrowId: access.burrow.id, actorId: access.principal.id },
  );
  if (res.status !== 'ok') throw conflict('The reply was sent, but its line couldn’t be posted here.');
  const fix = await latestFix(services.db, connection.id, report.reportId);
  return { report: reportView(connection, now, fix, words), messageId: res.result.messageId };
}

/** The line a person's update already posted, by its request id (a retry finds it). */
async function postedFor(db: Db, requestId: string): Promise<string | null> {
  const [row] = await db
    .select({ messageId: trackerUpdates.messageId })
    .from(trackerUpdates)
    .where(eq(trackerUpdates.requestId, requestId));
  return row?.messageId ?? null;
}

/**
 * `tracker.item_updated` (TA-15): what a person sent through the tracker, posted in the run's thread as that person —
 * plain text, no mentions read from it, nobody woken — once per request id, with a signed event of ids only.
 */
export const reportUpdated = defineCommand({
  name: 'tracker.item_updated',
  schema: z.object({
    runId: z.string(),
    requestId: z.string().min(1).max(100),
    connection: z.string().max(80),
    /** What the tracker is called (its driver's words). */
    product: z.string().max(40).default('the tracker'),
    number: z.number().int().nonnegative(),
    message: z.string().max(TRACKER_REPLY_MAX).optional(),
    status: z.string().max(40).optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people answer the reporter.');
    const already = await postedFor(tx, input.requestId);
    if (already) return { messageId: already };
    const run = await loadRunRow(tx, input.runId);
    if (run.burrowId !== ctx.burrow.id) throw notFound('Automation run');
    const conversation = await loadConversationRow(tx, run.conversationId);
    if (!conversation) throw notFound('Conversation');
    const posted = await postMessage(ctx, {
      conversation,
      text: updateLine(input.connection, input.number, input).slice(0, 12_000),
      threadRootId: run.threadRootId,
      // Plain text: no mentions are read from it, nobody is woken (TA-15, as FBS-08).
      mentions: [],
      dispatch: false,
    });
    await tx.insert(trackerUpdates).values({
      requestId: input.requestId,
      burrowId: ctx.burrow.id,
      runId: run.id,
      byId: ctx.actor.id,
      messageId: posted.id,
      createdAt: ctx.now,
    });
    await ctx.emit({
      type: 'tracker.item_updated',
      kind: 'System',
      text: input.status
        ? `Set ${input.connection} #${input.number} to ${trackerStatusLabel(input.status)}${input.message ? ' with a reply to the reporter' : ''}`
        : `Replied to the reporter of ${input.connection} #${input.number} through ${input.product}`,
      where: input.connection,
      payload: {
        runId: run.id,
        number: input.number,
        messageId: posted.id,
        replied: !!input.message,
        ...(input.status ? { status: input.status } : {}),
        ...(input.message ? { length: input.message.length } : {}),
      },
    });
    return { messageId: posted.id };
  },
});
