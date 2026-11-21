/**
 * What the agents of a tracker run read (docs/decisions/report-trackers.md TA-09, TA-10, TA-23): the run's own report
 * with `tracker_item` — listed in every agent turn of a run that started from a tracker's report and refused everywhere
 * else — and the reporting organization with `tracker_read`, for every agent step that neither writes code nor gives a
 * verdict (core `trackerAccessAsked`; whether it may look is the token's scope, not a switch), where the tracker grants
 * it: when the step's turn is claimed Whombat asks the tracker for an hour's read-only access of the report's
 * organization, seals it per run, step and attempt (`tracker_grants`), reuses it for a re-claim of the same attempt while
 * 10 minutes are left, and revokes it when the step settles (and the poller's sweep revokes what wasn't confirmed).
 * Everything the tracker answers is untrusted data; the reporter's name and email never reach an agent, and neither
 * token leaves Whombat.
 */
import {
  type AutomationStep,
  type JsonValue,
  type McpToolOutput,
  TRACKER_DIAGNOSTICS_MAX_BYTES,
  TRACKER_ITEM_TEXT_MAX,
  TRACKER_READ_MAX_BYTES,
  TRACKER_READS_MAX,
  type TrackerAccess,
  type TrackerDispatchContext,
  type TrackerWords,
  trackerAccessAsked,
  trackerStatusLabel,
  UNKNOWN_TRACKER_WORDS,
} from '@whombat/core';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { openConnectionSecret } from '../connections/crypto';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db } from '../db/client';
import {
  automationRunSteps,
  automationRuns,
  dispatches,
  trackerGrants,
  trackerItems,
} from '../db/schema/index';
import { badRequest, conflict, forbidden } from '../lib/errors';
import { iso } from '../lib/time';
import type { ToolContext } from '../mcp/tools';
import type { Services } from '../services';
import { reportProduct, tokenRefused, trackerConnectionRow, trackerWords } from './connection';
import type { TrackerGrant, TrackerItem, TrackerItemFull } from './driver';
import type { BoundDriver } from './drivers';
import { AccessRefused, SourceProblem, TrackerNotFound, TrackerRefusal } from './errors';
import { scopeReport } from './items';
import { scrubSecrets } from './paths';

/** The longest an organization access counts for (TA-10): an hour; a tracker's longer `expires_at` is cut to it. */
export const GRANT_MAX_MS = 60 * 60_000;
/** A re-claim of the same attempt reuses its grant only with at least this much left. */
export const GRANT_REUSE_MIN_MS = 10 * 60_000;
/** One `tracker_read`'s idle and total deadline. */
export const READ_TIMEOUT_MS = 15_000;

/** What an agent hears when it calls a tracker tool outside a tracker run. */
export const NOT_A_TRACKER_TURN =
  'This tool only works in a turn of an automation run that started from a tracker’s report.';

/** The custody AAD of a step attempt's grant (TA-10): a sealed token opens only for the attempt it was granted to. */
export function grantAad(runId: string, stepId: string, attempt: number): string {
  return `tracker_grant:${runId}:${stepId}:${attempt}:token`;
}

type GrantRow = typeof trackerGrants.$inferSelect;

/** An agent turn of a run that started from a tracker report: its run, step and report. */
export interface TrackerTurn {
  dispatch: typeof dispatches.$inferSelect;
  run: typeof automationRuns.$inferSelect;
  row: typeof automationRunSteps.$inferSelect;
  step: AutomationStep;
  report: NonNullable<ReturnType<typeof scopeReport>>;
}

/**
 * The tracker turn a dispatch is (null: it isn't one): an automation's dispatch of a run whose trigger was a tracker
 * report, still the turn its step waits for (a retry's new turn replaces it).
 */
export async function trackerTurn(db: Db, dispatchId: string | undefined): Promise<TrackerTurn | null> {
  if (!dispatchId) return null;
  const [found] = await db
    .select({ row: automationRunSteps, run: automationRuns, dispatch: dispatches })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .innerJoin(dispatches, eq(dispatches.id, automationRunSteps.dispatchId))
    .where(eq(automationRunSteps.dispatchId, dispatchId))
    .limit(1);
  if (found?.dispatch.trigger !== 'automation') return null;
  const report = scopeReport(found.run.scope);
  const step = found.run.definition.steps[found.row.idx];
  if (!report || !step) return null;
  return { dispatch: found.dispatch, run: found.run, row: found.row, step, report };
}

/** The grant row of a turn's step attempt, if one was asked for. */
async function grantOf(db: Db, turn: Pick<TrackerTurn, 'run' | 'row'>): Promise<GrantRow | null> {
  const [row] = await db
    .select()
    .from(trackerGrants)
    .where(
      and(
        eq(trackerGrants.runId, turn.run.id),
        eq(trackerGrants.stepId, turn.row.stepId),
        eq(trackerGrants.attempt, turn.row.attempt),
      ),
    );
  return row ?? null;
}

/**
 * The tracker tools an agent is served in a turn (TA-09, TA-10): `tracker_item` in every turn of a tracker run,
 * `tracker_read` only in a turn whose attempt was granted access (also once it expired or was revoked, so the tool says
 * why). Neither in any other turn.
 */
export async function trackerToolsInTurn(
  db: Db,
  agentId: string,
  dispatchId: string | undefined,
): Promise<{ report: boolean; read: boolean }> {
  const turn = await trackerTurn(db, dispatchId);
  if (!turn || turn.dispatch.agentId !== agentId) return { report: false, read: false };
  const grant = await grantOf(db, turn);
  return { report: true, read: !!grant?.tokenSealed };
}

function granted(row: Pick<GrantRow, 'scopes' | 'expiresAt'>): TrackerAccess {
  return {
    state: 'granted',
    scopes: row.scopes,
    expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
    reason: null,
  };
}

function unavailable(reason: string): TrackerAccess {
  return { state: 'unavailable', scopes: [], expiresAt: null, reason: reason.slice(0, 500) };
}

/**
 * `DispatchContext.tracker` of a turn, built when it is claimed (TA-10): the connection's label and the report's number
 * for every agent turn of a tracker run; for a step that asks (TA-23: one that neither writes code nor gives a verdict,
 * whatever its `trackerAccess` says) the organization access too — the attempt's live grant, or a new one the tracker
 * grants now, or why it is unavailable (a token without `reports:assess`). Null for every other turn.
 */
export async function trackerDispatchContext(
  services: Services,
  dispatchId: string,
): Promise<TrackerDispatchContext | null> {
  const turn = await trackerTurn(services.db, dispatchId);
  if (!turn || turn.report.number < 1) return null;
  const asks = trackerAccessAsked(turn.step);
  return {
    connection: turn.report.connection.slice(0, 80),
    product: await reportProduct(services, services.db, turn.report.connectionId, turn.report.reportId),
    number: turn.report.number,
    access: asks ? await stepAccess(services, turn) : null,
  };
}

/** The organization access of a step attempt (TA-10): reused, granted now, or unavailable with why. */
async function stepAccess(services: Services, turn: TrackerTurn): Promise<TrackerAccess> {
  const db = services.db;
  const now = services.clock();
  const existing = await grantOf(db, turn);
  if (existing && !existing.tokenSealed && existing.reason) return unavailable(existing.reason);
  if (
    existing?.tokenSealed &&
    !existing.revokedAt &&
    existing.expiresAt &&
    existing.expiresAt.getTime() - now.getTime() >= GRANT_REUSE_MIN_MS
  )
    return granted(existing);
  const key = { runId: turn.run.id, stepId: turn.row.stepId, attempt: turn.row.attempt };
  const base = {
    ...key,
    burrowId: turn.run.burrowId,
    connectionId: turn.report.connectionId,
    reportId: turn.report.reportId,
    createdAt: now,
  };
  const refuse = async (reason: string) => {
    const values = { ...base, tokenSealed: null, reason: reason.slice(0, 500), scopes: [], expiresAt: null };
    await db
      .insert(trackerGrants)
      .values(values)
      .onConflictDoUpdate({
        target: [trackerGrants.runId, trackerGrants.stepId, trackerGrants.attempt],
        set: values,
      });
    services.log.warn(
      { runId: turn.run.id, stepId: turn.row.stepId, reason },
      'tracker: the organization access was refused',
    );
    return unavailable(reason);
  };
  const row = await trackerConnectionRow(db, turn.run.burrowId, turn.report.connectionId);
  if (!row) return refuse('The tracker connection is gone.');
  if (row.status === 'needs_reauth') return refuse(`${row.label} needs a new token.`);
  // One access per report: what an earlier attempt still holds is revoked before a new one is granted.
  await revokeSettledGrants(services, { reportId: turn.report.reportId });
  let grant: TrackerGrant;
  try {
    const driver = services.tracker.driverFor(row);
    if (!driver.grant) return refuse(`${row.label} doesn’t grant access to the reporting organization.`);
    grant = await driver.grant(turn.report.reportId);
  } catch (err) {
    return refuse(
      err instanceof AccessRefused || err instanceof SourceProblem
        ? scrubSecrets(err.message, [connectionToken(services, row)])
        : `${row.label}’s answer to the access request couldn’t be read.`,
    );
  }
  const given = Date.parse(grant.expiresAt);
  const cap = now.getTime() + GRANT_MAX_MS;
  const expiresAt = new Date(Number.isNaN(given) ? cap : Math.min(given, cap));
  if (expiresAt.getTime() <= now.getTime())
    return refuse(`${row.label} granted access that had already ended.`);
  const scopes = [...new Set(grant.scopes.filter((s) => /^[a-z][a-z0-9_.:-]{0,63}$/i.test(s)))];
  const values = {
    ...base,
    tokenSealed: services.custody.seal(grantAad(key.runId, key.stepId, key.attempt), grant.token),
    reason: null,
    scopes,
    organizationId: grant.organizationId ?? null,
    expiresAt,
    calls: 0,
    revokedAt: null,
  };
  await db
    .insert(trackerGrants)
    .values(values)
    .onConflictDoUpdate({
      target: [trackerGrants.runId, trackerGrants.stepId, trackerGrants.attempt],
      set: values,
    });
  services.log.info(
    { runId: key.runId, stepId: key.stepId, attempt: key.attempt, scopes, expiresAt: iso(expiresAt) },
    'tracker: a step was granted access to the reporting organization',
  );
  return granted(values);
}

/** The connection's own token, opened (null without one): scrubbed from what an agent reads. */
function connectionToken(services: Services, row: CatalogConnectionRow): string | null {
  if (!row.secretEnc) return null;
  try {
    return openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc);
  } catch {
    return null;
  }
}

/* tracker_item (TA-09) --------------------------------------------------------------------------------------- */

/** The reporter's own name and email, replaced wherever they appear in what an agent reads (FB-F08). */
function withoutReporter(text: string, report: Pick<TrackerItemFull, 'reporter'>): string {
  let out = text;
  for (const value of [report.reporter.email, report.reporter.name]) {
    const v = value?.trim();
    if (!v || v.length < 3) continue;
    out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'the reporter');
  }
  return out;
}

/** Text cut to `max` characters, ending with `…` when cut. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A report as `tracker_item` gives it (TA-09): what the customer wrote, the page, browser and versions, what its
 * tracker attached (its driver's `evidence`: recent actions and requests, audit, device diagnostics, linked packages)
 * and the conversation with “The reporter” and the team as authors. Never the reporter's name or email.
 */
export function reportText(report: TrackerItemFull, words: TrackerWords = UNKNOWN_TRACKER_WORDS): string {
  const lines: string[] = [];
  const kind = report.kind === 'feature' ? 'Feature request' : 'Bug report';
  lines.push(`${kind} #${report.number}: ${report.title ?? '(no title yet)'}`);
  const facts = [
    report.organization.name ? `Organization: ${report.organization.name}` : null,
    `Status: ${trackerStatusLabel(report.status)}`,
    report.priority ? `Priority: ${report.priority}` : null,
    report.assessment ? `Assessment: ${report.assessment}` : null,
    report.version ? `${words.product} version: ${report.version}` : null,
    `Filed: ${report.createdAt}`,
  ].filter((l): l is string => !!l);
  lines.push(...facts);
  if (report.description?.trim()) lines.push('', 'What happened:', report.description.trim());
  if (report.expected?.trim()) lines.push('', 'Expected:', report.expected.trim());
  if (report.hasScreenshot) lines.push('', 'It came with a screenshot (people see it on the run page).');
  if (report.evidence.trim()) lines.push('', report.evidence.trim());
  const messages = report.messages.filter((m) => m.body.trim());
  if (messages.length) {
    lines.push('', `The conversation in ${words.product} (oldest first):`);
    for (const m of messages.slice(-50))
      lines.push(
        `- ${m.author === 'team' ? capital(words.team) : 'The reporter'}${m.at ? ` (${m.at})` : ''}: ${m.body.trim()}`,
      );
  }
  if (report.release)
    lines.push(
      '',
      `Release ${words.product} recorded: ${[report.release.component, report.release.version].filter(Boolean).join(' ')}`,
    );
  return withoutReporter(lines.join('\n'), report);
}

function capital(text: string): string {
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : text;
}

/** Statuses a report is still open in, for telling a duplicate (TA-60). */
const OPEN_STATUSES = [
  'new',
  'investigating',
  'needs_information',
  'planned',
  'in_progress',
  'awaiting_release',
];

/**
 * The other open reports of the report's own organization on this installation, newest first (at most 10), as
 * `tracker_item` lists them so the agent can tell a duplicate (TA-60): number, title and status. Never another
 * organization's. Null when there are none or the organization isn't known.
 */
export async function sameOrganizationReports(
  db: Db,
  connectionId: string,
  report: Pick<TrackerItem, 'id' | 'organization'>,
): Promise<string | null> {
  // Told by the tracker's id of the organization, never its name: two organizations may share one.
  const organization = report.organization.id?.trim();
  if (!organization) return null;
  const rows = await db
    .select({
      number: trackerItems.number,
      title: trackerItems.title,
      status: sql<string>`coalesce(${trackerItems.seenStatus}, ${trackerItems.status})`,
    })
    .from(trackerItems)
    .where(
      and(
        eq(trackerItems.connectionId, connectionId),
        eq(trackerItems.organizationId, organization),
        ne(trackerItems.externalId, report.id),
        inArray(sql`coalesce(${trackerItems.seenStatus}, ${trackerItems.status})`, OPEN_STATUSES),
      ),
    )
    .orderBy(desc(trackerItems.number))
    .limit(10);
  if (!rows.length) return null;
  return [
    'Other open reports from the same organization (for telling a duplicate: name it in duplicateOf):',
    ...rows.map((r) => `- #${r.number} “${r.title.slice(0, 140)}” (${trackerStatusLabel(r.status)})`),
  ].join('\n');
}

/** The run's report of a tracker turn, its connection and a client, or why not. */
async function turnConnection(ctx: ToolContext): Promise<{ turn: TrackerTurn; row: CatalogConnectionRow }> {
  const turn = await trackerTurn(ctx.services.db, ctx.dispatch.id);
  if (!turn || turn.dispatch.agentId !== ctx.agentId || turn.run.burrowId !== ctx.burrowId)
    throw forbidden(NOT_A_TRACKER_TURN);
  if (turn.row.state !== 'waiting' || turn.row.dispatchId !== ctx.dispatch.id)
    throw conflict('This step is finished, so its report can’t be read any more.');
  const row = await trackerConnectionRow(ctx.services.db, turn.run.burrowId, turn.report.connectionId);
  if (!row) throw conflict('The tracker connection of this run is gone.');
  return { turn, row };
}

/** A tracker's failure in an agent's words; a refused token also marks the connection (TA-03). */
async function toolFailure(services: Services, row: CatalogConnectionRow, err: unknown): Promise<never> {
  if (err instanceof SourceProblem) {
    if (err.code === 'refused') await tokenRefused(services, row.id);
    throw conflict(scrubSecrets(err.message, [connectionToken(services, row)]).slice(0, 300));
  }
  if (err instanceof TrackerNotFound || err instanceof TrackerRefusal)
    throw badRequest(err.message.slice(0, 300));
  throw err;
}

/** `tracker_item` (TA-09): the run's report read now with the connection's token, or one of its packages. */
export async function trackerItemTool(
  ctx: ToolContext,
  input: { diagnostics?: string | undefined },
): Promise<McpToolOutput<'tracker_item'>> {
  const services = ctx.services;
  const { turn, row } = await turnConnection(ctx);
  const secrets = [connectionToken(services, row)];
  const words = trackerWords(services, row);
  if (input.diagnostics) {
    let res: { text: string; cut: boolean };
    try {
      res = await services.tracker
        .driverFor(row)
        .diagnostics(turn.report.reportId, input.diagnostics, TRACKER_DIAGNOSTICS_MAX_BYTES);
    } catch (err) {
      return toolFailure(services, row, err);
    }
    return { status: 'ok', text: scrubSecrets(res.text, secrets), cut: res.cut };
  }
  let report: TrackerItemFull;
  try {
    report = await services.tracker.driverFor(row).item(turn.report.reportId);
  } catch (err) {
    return toolFailure(services, row, err);
  }
  const full = scrubSecrets(reportText(report, words), secrets);
  // The organization's other open reports, so a duplicate can be told as one (TA-60); always whole, the report is cut.
  const others = await sameOrganizationReports(services.db, turn.report.connectionId, report);
  const room = TRACKER_ITEM_TEXT_MAX - (others ? others.length + 2 : 0);
  services.log.info(
    { runId: turn.run.id, stepId: turn.row.stepId, chars: full.length },
    'tracker: an agent read its run’s report',
  );
  const text = full.length > room ? cut(full, room) : full;
  return {
    status: 'ok',
    text: others ? `${text}\n\n${others}` : text,
    cut: full.length > room,
  };
}

/* tracker_read (TA-10) ----------------------------------------------------------------------------------------- */

/**
 * `tracker_read` (TA-10): a GET of `{address}{path}` with the attempt's grant token, only in the granted turn, with the
 * grant still live, at most `TRACKER_READS_MAX` reads; refused paths answer why; the answer is the tracker's status,
 * its body (JSON, else the text) and whether it was cut, both tokens scrubbed.
 */
export async function trackerReadTool(
  ctx: ToolContext,
  input: { path: string },
): Promise<McpToolOutput<'tracker_read'>> {
  const services = ctx.services;
  const db = services.db;
  const { turn, row } = await turnConnection(ctx);
  const grant = await grantOf(db, turn);
  if (!grant?.tokenSealed) throw forbidden('This step has no access to the reporting organization.');
  if (grant.revokedAt)
    throw forbidden(
      'The access to the reporting organization was revoked: assess from what you read so far.',
    );
  if (!grant.expiresAt || grant.expiresAt.getTime() <= services.clock().getTime())
    throw forbidden(
      'The access to the reporting organization has ended (it lasts an hour): assess from what you read so far, and say so.',
    );
  if (grant.calls >= TRACKER_READS_MAX)
    throw forbidden(
      `You have read the organization ${TRACKER_READS_MAX} times in this step: conclude from what you have.`,
    );
  const driver = services.tracker.driverFor(row);
  if (!driver.read) throw forbidden(`${row.label} doesn’t let Whombat read the reporting organization.`);
  let token: string;
  try {
    token = services.custody.open(grantAad(grant.runId, grant.stepId, grant.attempt), grant.tokenSealed);
  } catch {
    throw forbidden('The access to the reporting organization can’t be opened on this Whombat any more.');
  }
  const secrets = [token, connectionToken(services, row)];
  await db
    .update(trackerGrants)
    .set({ calls: sql`${trackerGrants.calls} + 1` })
    .where(
      and(
        eq(trackerGrants.runId, grant.runId),
        eq(trackerGrants.stepId, grant.stepId),
        eq(trackerGrants.attempt, grant.attempt),
      ),
    );
  const logged = {
    runId: grant.runId,
    stepId: grant.stepId,
    path: scrubSecrets(input.path, secrets).slice(0, 300),
  };
  let res: { status: number; body: string; cut: boolean };
  try {
    res = await driver.read({ token }, input.path, TRACKER_READ_MAX_BYTES);
  } catch (err) {
    // The driver refuses a path it won't read (its own rules: the tracker's sign-in, administration, …) with why.
    if (err instanceof TrackerRefusal) throw badRequest(scrubSecrets(err.message, secrets).slice(0, 300));
    const why = err instanceof Error ? err.message : `${row.label} didn’t answer.`;
    services.log.warn({ ...logged, err: err instanceof Error ? err.name : 'error' }, 'tracker: read failed');
    throw conflict(scrubSecrets(why, secrets).slice(0, 300));
  }
  const truncated = res.cut;
  const text = scrubSecrets(res.body, secrets);
  let body: JsonValue;
  try {
    body = JSON.parse(text) as JsonValue;
  } catch {
    body = text;
  }
  services.log.info(
    { ...logged, status: res.status, bytes: res.body.length, cut: truncated },
    'tracker: an agent read the reporting organization',
  );
  return { status: 'ok', httpStatus: res.status, body, cut: truncated };
}

/* Revoking (TA-10) -------------------------------------------------------------------------------------------- */

/**
 * Revokes the organization access of step attempts that aren't running any more (TA-10): one revoke per report through
 * the tracker's driver, best-effort. A grant is marked revoked when the tracker confirmed it, when it had expired
 * anyway, or when a running attempt of another step holds a live grant of the same report (the tracker's revoke would
 * end that one too; the old token is sealed, unused and ends within the hour). What the tracker didn't confirm stays
 * open for the poller's next sweep. Answers how many it revoked.
 */
export async function revokeSettledGrants(
  services: Services,
  scope: { reportId?: string; runId?: string },
): Promise<number> {
  const db = services.db;
  const open = await db
    .select({ grant: trackerGrants, step: automationRunSteps })
    .from(trackerGrants)
    .leftJoin(
      automationRunSteps,
      and(
        eq(automationRunSteps.runId, trackerGrants.runId),
        eq(automationRunSteps.stepId, trackerGrants.stepId),
      ),
    )
    .where(
      and(
        isNull(trackerGrants.revokedAt),
        isNotNull(trackerGrants.tokenSealed),
        scope.reportId ? eq(trackerGrants.reportId, scope.reportId) : undefined,
        scope.runId ? eq(trackerGrants.runId, scope.runId) : undefined,
      ),
    );
  const running = (r: (typeof open)[number]) =>
    r.step?.state === 'waiting' && r.step.attempt === r.grant.attempt && !!r.step.dispatchId;
  const settled = open.filter((r) => !running(r));
  if (!settled.length) return 0;
  const now = services.clock();
  const mark = async (grants: GrantRow[]) => {
    let n = 0;
    for (const g of grants) {
      const done = await db
        .update(trackerGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(trackerGrants.runId, g.runId),
            eq(trackerGrants.stepId, g.stepId),
            eq(trackerGrants.attempt, g.attempt),
            isNull(trackerGrants.revokedAt),
          ),
        )
        .returning({ runId: trackerGrants.runId });
      n += done.length;
    }
    return n;
  };
  let revoked = 0;
  const byReport = new Map<string, GrantRow[]>();
  for (const { grant } of settled)
    byReport.set(grant.reportId, [...(byReport.get(grant.reportId) ?? []), grant]);
  for (const [reportId, grants] of byReport) {
    revoked += await mark(grants.filter((g) => !g.expiresAt || g.expiresAt.getTime() <= now.getTime()));
    const live = grants.filter((g) => g.expiresAt && g.expiresAt.getTime() > now.getTime());
    const first = live[0];
    if (!first) continue;
    // Another step working on the same report now holds its own access: the tracker's revoke would end that one too.
    const others = await db
      .select({ grant: trackerGrants, step: automationRunSteps })
      .from(trackerGrants)
      .innerJoin(
        automationRunSteps,
        and(
          eq(automationRunSteps.runId, trackerGrants.runId),
          eq(automationRunSteps.stepId, trackerGrants.stepId),
        ),
      )
      .where(
        and(
          eq(trackerGrants.reportId, reportId),
          isNull(trackerGrants.revokedAt),
          isNotNull(trackerGrants.tokenSealed),
          eq(automationRunSteps.state, 'waiting'),
        ),
      );
    if (others.some((o) => o.step.attempt === o.grant.attempt && !!o.step.dispatchId)) {
      revoked += await mark(live);
      continue;
    }
    const row = await trackerConnectionRow(db, first.burrowId, first.connectionId);
    const confirmed = row ? await revokeAt(services, row, reportId) : true;
    if (confirmed) revoked += await mark(live);
    else
      services.log.warn(
        { reportId, connectionId: first.connectionId },
        'tracker: the tracker didn’t confirm revoking the organization access; trying again later',
      );
  }
  return revoked;
}

/** Ends the report's organization access at its tracker; true when the tracker confirmed it (or grants none). */
async function revokeAt(services: Services, row: CatalogConnectionRow, reportId: string): Promise<boolean> {
  let driver: BoundDriver;
  try {
    driver = services.tracker.driverFor(row);
  } catch {
    return false;
  }
  return driver.revoke ? driver.revoke(reportId) : true;
}
