/**
 * Automations read side: rows → contract objects (`Automation`, `AutomationRun`), visibility, and the realtime
 * frames every change publishes (docs/decisions/bp-automations.md BP-C12).
 */
import {
  AUTOMATION_KEYS,
  AUTOMATION_RECENT_RUNS,
  type Automation,
  type AutomationDefinition,
  type AutomationGrant,
  type AutomationRun,
  type AutomationRunStep,
  type AutomationRunSummary,
  definitionHash,
  EXTERNAL_STEP_KINDS,
  type JsonObject,
  MissingMailAttachment,
  nextFireAfter,
  topics,
  validateDefinition,
} from '@whombat/core';
import { and, desc, eq, gt, inArray, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { loadBurrowRow } from '../commit/pipeline';
import type { TxSession } from '../commit/types';
import type { Db } from '../db/client';
import {
  approvals,
  automationRunSteps,
  automationRuns,
  automations,
  automationVersions,
  dispatches,
  featureRequests,
  grants,
  runs,
} from '../db/schema/index';
import { followPlanWork } from '../domain/plan-follow';
import { indexAutomationRun } from '../domain/search-index';
import { billedTokensSum } from '../domain/turn-usage';
import { notFound } from '../lib/errors';
import { iso, isoOrNull } from '../lib/time';
import { groupRows } from '../read/group';
import { connectionLabels, definitionConnections } from '../trackers/store';
import { forgetMailText } from './mail-text';
import { planFactsOf } from './plan-store';
import { agentNameIn, definitionRooms, describeAs, glanceAs, roomTitles, summaryAs } from './visibility';

export type AutomationRow = typeof automations.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type AutomationStepRow = typeof automationRunSteps.$inferSelect;
export type AutomationVersionRow = typeof automationVersions.$inferSelect;

/** Where a sender posts a webhook for an automation (under the `/webhooks` prefix the web server reserves). */
export const webhookPath = (id: string) => `/webhooks/automations/${id}`;

export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting', 'paused', 'needs_review'] as const;

/**
 * An automation of the burrow. A deleted one answers 404 like a missing one (automation-recipes.md) unless the caller
 * shows what is left of it (`deleted: true`: a run page, the frames of its runs).
 */
export async function loadAutomationRow(
  db: Db,
  burrowId: string,
  id: string,
  options: { deleted?: boolean } = {},
): Promise<AutomationRow> {
  const [row] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.burrowId, burrowId), eq(automations.id, id)));
  if (!row || (row.deletedAt && !options.deleted)) throw notFound('Automation');
  return row;
}

export async function loadVersion(db: Db, automationId: string, n: number): Promise<AutomationVersionRow> {
  const [row] = await db
    .select()
    .from(automationVersions)
    .where(and(eq(automationVersions.automationId, automationId), eq(automationVersions.n, n)));
  if (!row) throw notFound('Automation version');
  return row;
}

/** The live definition (null before the first publish). */
export async function liveDefinition(db: Db, row: AutomationRow): Promise<AutomationDefinition | null> {
  if (!row.currentVersion) return null;
  return (await loadVersion(db, row.id, row.currentVersion)).definition;
}

export async function automationGrants(db: Db, principalId: string): Promise<AutomationGrant[]> {
  const rows = await db.select().from(grants).where(eq(grants.agentId, principalId)).orderBy(grants.position);
  return rows
    .filter((g) => (AUTOMATION_KEYS as readonly string[]).includes(g.keyId))
    .map((g) => ({
      keyId: g.keyId as AutomationGrant['keyId'],
      tier: g.tier,
      ...(g.scope?.repos?.length ? { repos: [...g.scope.repos] } : {}),
      ...(g.scope?.connections?.length ? { connections: [...g.scope.connections] } : {}),
    }));
}

/** The next time a live schedule trigger fires, from the automation's stored timer. */
function nextRun(row: AutomationRow, definition: AutomationDefinition | null): string | null {
  if (row.status !== 'published' || !definition?.triggers.some((t) => t.kind === 'schedule')) return null;
  return isoOrNull(row.nextFireAt);
}

/**
 * The latest runs of each automation, newest first, at most `AUTOMATION_RECENT_RUNS` (automation-list.md AL-S02): one
 * query for all of them (a lateral join on the runs' `(automation_id, created_at)` index), whatever the list's length.
 * `waitingOn` (AL-S03) is worked out in the same query: `review` for a run that needs review, `approval` for a waiting
 * run with a step waiting on a pending approval (a person's yes); null otherwise.
 */
export async function recentRunSummaries(
  db: Db,
  automationIds: readonly string[],
): Promise<Map<string, AutomationRunSummary[]>> {
  const ids = [...new Set(automationIds)];
  const out = new Map<string, AutomationRunSummary[]>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const recent = db
    .select({
      id: automationRuns.id,
      number: automationRuns.number,
      status: automationRuns.status,
      createdAt: automationRuns.createdAt,
      startedAt: automationRuns.startedAt,
      finishedAt: automationRuns.finishedAt,
    })
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automations.id))
    .orderBy(desc(automationRuns.createdAt), desc(automationRuns.number))
    .limit(AUTOMATION_RECENT_RUNS)
    .as('recent_runs');
  const rows = await db
    .select({
      automationId: automations.id,
      id: recent.id,
      number: recent.number,
      status: recent.status,
      createdAt: recent.createdAt,
      startedAt: recent.startedAt,
      finishedAt: recent.finishedAt,
      waitingOn: sql<AutomationRunSummary['waitingOn']>`case
        when ${recent.status} = 'needs_review' then 'review'
        when ${recent.status} = 'waiting' and exists (
          select 1 from ${automationRunSteps}
            join ${approvals} on ${approvals.id} = ${automationRunSteps.approvalId}
           where ${automationRunSteps.runId} = ${recent.id}
             and ${automationRunSteps.state} = 'waiting'
             and ${approvals.state} = 'pending') then 'approval'
      end`,
    })
    .from(automations)
    .innerJoinLateral(recent, sql`true`)
    .where(inArray(automations.id, ids))
    .orderBy(automations.id, desc(recent.createdAt), desc(recent.number));
  for (const r of rows)
    out.get(r.automationId)?.push({
      id: r.id,
      number: r.number,
      status: r.status,
      startedAt: iso(r.startedAt ?? r.createdAt),
      finishedAt: isoOrNull(r.finishedAt),
      waitingOn: r.waitingOn ?? null,
    });
  return out;
}

/**
 * An automation as the person sees it, in reads and frames alike (one-person.md OP-S69). `recentRuns`: its latest runs
 * when the caller loaded them for a whole list (`recentRunSummaries`); else read here.
 */
export async function toAutomation(
  db: Db,
  row: AutomationRow,
  preloaded: { recentRuns?: AutomationRunSummary[] } = {},
): Promise<Automation> {
  const version = row.currentVersion ? await loadVersion(db, row.id, row.currentVersion) : null;
  const definition = version?.definition ?? null;
  const draftCheck = row.draftJson ? validateDefinition(row.draftJson) : null;
  // What it does in one sentence and at a glance: the live definition's, else the valid draft's (automation-recipes.md,
  // automation-list.md AL-S01).
  const described = definition ?? (draftCheck?.ok ? draftCheck.definition : null);
  const titles = await roomTitles(db, [...definitionRooms(definition), ...definitionRooms(described)]);
  const labels = await connectionLabels(db, [
    ...definitionConnections(definition),
    ...definitionConnections(described),
  ]);
  const recentRuns = preloaded.recentRuns ?? (await recentRunSummaries(db, [row.id])).get(row.id) ?? [];
  const plans = (await planFactsOf(db, [row.id])).get(row.id);
  return {
    id: row.id,
    burrowId: row.burrowId,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersion: row.currentVersion,
    draft: draftCheck?.ok ? draftCheck.definition : null,
    draftJson: row.draftJson ?? null,
    draftProblems: draftCheck && !draftCheck.ok ? draftCheck.problems : [],
    draftHash: draftCheck?.ok ? definitionHash(draftCheck.definition) : null,
    definition,
    principalId: row.principalId,
    createdById: row.createdById,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    publishedById: version?.publishedById ?? null,
    triggerSummary: summaryAs(definition, titles, labels),
    summary: describeAs(described, titles, await agentNameIn(db, row.burrowId), labels),
    deletedAt: isoOrNull(row.deletedAt),
    grants: await automationGrants(db, row.principalId),
    webhook: { enabled: row.webhookEnabled, hasSecret: !!row.webhookSecretEnc, path: webhookPath(row.id) },
    nextRunAt: nextRun(row, definition),
    // The newest of its recent runs: the same order as ever (when it was made), the run number breaking a tie.
    lastRun: recentRuns[0] ?? null,
    recentRuns,
    glance: glanceAs(described, titles, labels),
    waitingPlanId: plans?.waitingPlanId ?? null,
    talk: plans?.talk ?? null,
  };
}

/** The longest step summary the contract carries (`AutomationRunStep.inputSummary`). */
export const STEP_SUMMARY_MAX = 300;

/**
 * A step's input summary as the contract carries it (AR-D03): at most 300 characters, a longer one cut to 299 and “…”.
 * A 0.71 “Fix it when sure” check is longer than that, and one summary too long would fail the whole run's answer.
 */
export function stepSummary(text: string): string {
  return text.length <= STEP_SUMMARY_MAX ? text : `${text.slice(0, STEP_SUMMARY_MAX - 1)}…`;
}

function toStep(
  row: AutomationStepRow,
  runNumbers: number[],
  approvalNumber: number | null,
): AutomationRunStep {
  return {
    stepId: row.stepId,
    index: row.idx,
    kind: row.kind,
    name: row.name,
    state: row.state,
    attempt: row.attempt,
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    wakeAt: isoOrNull(row.wakeAt),
    inputSummary: stepSummary(row.inputSummary),
    output: row.output as JsonObject,
    error: row.error,
    dispatchId: row.dispatchId,
    approvalId: row.approvalId,
    approvalNumber,
    messageIds: row.messageIds,
    prNumber: row.prNumber,
    runNumbers,
  };
}

export async function loadStepRows(db: Db, runId: string): Promise<AutomationStepRow[]> {
  return db
    .select()
    .from(automationRunSteps)
    .where(eq(automationRunSteps.runId, runId))
    .orderBy(automationRunSteps.idx);
}

/** How long a step out talking to another service holds an update before it counts as stuck rather than working. */
export const STEP_IN_FLIGHT_MS = 10 * 60_000;

/**
 * Automation steps out talking to GitHub, a tracker or a URL now: seconds each, and a process stopped in the middle
 * leaves their outcome unknown, so an update waits for them as it does for a turn. One that hasn't moved for
 * `STEP_IN_FLIGHT_MS` is stuck, and holds nothing.
 */
export async function stepsInFlight(
  db: Db,
  now: Date,
): Promise<{ runId: string; idx: number; name: string; since: Date }[]> {
  const rows = await db
    .select({
      runId: automationRunSteps.runId,
      idx: automationRunSteps.idx,
      name: automationRunSteps.name,
      since: automationRunSteps.updatedAt,
    })
    .from(automationRunSteps)
    .where(
      and(
        eq(automationRunSteps.state, 'running'),
        inArray(automationRunSteps.kind, [...EXTERNAL_STEP_KINDS]),
        gt(automationRunSteps.updatedAt, new Date(now.getTime() - STEP_IN_FLIGHT_MS)),
      ),
    )
    .limit(100);
  return rows;
}

/** What a step's turns that handed their wait over used, as billed (`HandedWait.tokens`). */
export const HANDED_TOKENS_SUM = sql<number>`coalesce(sum((${automationRunSteps.output}->'handedWait'->>'tokens')::numeric), 0)`;
export const HAS_HANDED_TOKENS = sql`jsonb_typeof(${automationRunSteps.output}->'handedWait'->'tokens') = 'number'`;

/** Tokens agents reported for a run's dispatches, as billed (PE-04; null: none reported usage). */
export async function runTokens(db: Db, runId: string): Promise<number | null> {
  return (await tokensForRuns(db, [runId])).get(runId) ?? null;
}

/**
 * Group before rounding cache reads, exactly as a single run's budget does. An absent group has unknown usage. A step's
 * turns that handed their wait over count too (`output.handedWait.tokens`, docs/decisions/outsiders-turns.md).
 */
async function tokensForRuns(db: Db, ids: string[]): Promise<Map<string, number>> {
  // Each step with its current turn (one row a step), so a step's handed tokens count once.
  const rows = await db
    .select({
      runId: automationRunSteps.runId,
      tokens: billedTokensSum(sql`${dispatches.usage}`),
      handed: HANDED_TOKENS_SUM,
    })
    .from(automationRunSteps)
    .leftJoin(dispatches, eq(automationRunSteps.dispatchId, dispatches.id))
    .where(
      and(
        inArray(automationRunSteps.runId, ids),
        sql`(${dispatches.usage} is not null or ${HAS_HANDED_TOKENS})`,
      ),
    )
    .groupBy(automationRunSteps.runId);
  return new Map(rows.map((row) => [row.runId, Number(row.tokens) + Number(row.handed)]));
}

/** A run with every step in full. */
export async function toRun(db: Db, row: AutomationRunRow): Promise<AutomationRun> {
  return (await toRuns(db, [row]))[0] as AutomationRun;
}

/** A page's full runs in input order, sharing relational reads without keeping state beyond this call. */
export async function toRuns(db: Db, rows: readonly AutomationRunRow[]): Promise<AutomationRun[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((row) => row.id))];
  const [steps, names, tokens] = await Promise.all([
    db
      .select()
      .from(automationRunSteps)
      .where(inArray(automationRunSteps.runId, ids))
      .orderBy(automationRunSteps.idx),
    db
      .select({ id: automations.id, name: automations.name })
      .from(automations)
      .where(inArray(automations.id, [...new Set(rows.map((row) => row.automationId))])),
    tokensForRuns(db, ids),
  ]);
  const dispatchIds = steps.map((s) => s.dispatchId).filter((d): d is string => !!d);
  const approvalIds = steps.map((s) => s.approvalId).filter((a): a is string => !!a);
  const [runRows, approvalRows] = await Promise.all([
    dispatchIds.length
      ? db
          .select({ dispatchId: runs.dispatchId, number: runs.number })
          .from(runs)
          .where(inArray(runs.dispatchId, [...new Set(dispatchIds)]))
      : [],
    approvalIds.length
      ? db
          .select({ id: approvals.id, number: approvals.number })
          .from(approvals)
          .where(inArray(approvals.id, [...new Set(approvalIds)]))
      : [],
  ]);
  const stepsByRun = groupRows(steps, (s) => s.runId);
  const runsByDispatch = groupRows(runRows, (r) => r.dispatchId);
  const approvalNumbers = new Map(approvalRows.map((a) => [a.id, a.number]));
  const automationNames = new Map(names.map((a) => [a.id, a.name]));
  return rows.map((row) => {
    const scope = row.scope as { missingAttachments?: unknown; missingAttachmentsOmitted?: unknown } | null;
    const missingParsed = MissingMailAttachment.array().max(20).safeParse(scope?.missingAttachments);
    const missingAttachments =
      missingParsed.success && missingParsed.data.length > 0 ? missingParsed.data : undefined;
    const rawOmitted = scope?.missingAttachmentsOmitted;
    const missingAttachmentsOmitted =
      typeof rawOmitted === 'number' && Number.isInteger(rawOmitted) && rawOmitted > 0
        ? rawOmitted
        : undefined;
    return {
      id: row.id,
      number: row.number,
      burrowId: row.burrowId,
      automationId: row.automationId,
      automationName: automationNames.get(row.automationId) ?? 'Automation',
      version: row.version,
      status: row.status,
      trigger: row.trigger,
      conversationId: row.conversationId,
      threadRootId: row.threadRootId,
      causalDepth: row.causalDepth,
      startedById: row.startedById,
      test: row.test,
      createdAt: iso(row.createdAt),
      startedAt: isoOrNull(row.startedAt),
      finishedAt: isoOrNull(row.finishedAt),
      error: row.error,
      tokens: tokens.get(row.id) ?? null,
      ...(missingAttachments ? { missingAttachments } : {}),
      ...(missingAttachmentsOmitted ? { missingAttachmentsOmitted } : {}),
      steps: (stepsByRun.get(row.id) ?? []).map((s) =>
        toStep(
          s,
          (runsByDispatch.get(s.dispatchId) ?? []).map((r) => r.number),
          s.approvalId ? (approvalNumbers.get(s.approvalId) ?? null) : null,
        ),
      ),
    };
  });
}

export async function loadRunRow(db: Db, runId: string): Promise<AutomationRunRow> {
  const [row] = await db.select().from(automationRuns).where(eq(automationRuns.id, runId));
  if (!row) throw notFound('Automation run');
  return row;
}

export async function publishAutomation(session: TxSession, burrowId: string, automationId: string) {
  const row = await loadAutomationRow(session.tx, burrowId, automationId, { deleted: true });
  // A deleted one left every list with its `automation.deleted` frame; nothing more is said about it.
  if (row.deletedAt) return;
  session.publish(topics.burrow(burrowId), {
    type: 'automation.updated',
    automation: await toAutomation(session.tx, row),
  });
}

/**
 * A run's frame goes to the conversation it runs in (its thread and messages live there), in full (one-person.md
 * OP-S69).
 */
export async function publishRun(session: TxSession, runId: string) {
  let row = await loadRunRow(session.tx, runId);
  // What a mail run no longer needs of the email goes in the commit that made it so (`mail-text.ts`).
  if (await forgetMailText(session, row)) row = await loadRunRow(session.tx, runId);
  // Its AUTOMATION search document and the plan steps that follow it, in the same commit (WS-05, WS-24).
  await indexAutomationRun(session.tx, runId);
  const burrow = await loadBurrowRow(session.tx, row.burrowId);
  const [automation] = await session.tx
    .select({ principalId: automations.principalId })
    .from(automations)
    .where(eq(automations.id, row.automationId));
  if (burrow && automation)
    await followPlanWork(
      { session, burrow, now: session.services.clock(), signerId: automation.principalId },
      { kind: 'automation_run', id: runId },
    );
  session.publish(topics.burrow(row.burrowId), {
    type: 'automation.run.updated',
    run: await toRun(session.tx, row),
  });
}

/** Schedules: the next fire after `after` for a definition's schedule trigger (null without one). */
export function scheduleNext(definition: AutomationDefinition, after: Date, anchor: Date): Date | null {
  const trigger = definition.triggers.find((t) => t.kind === 'schedule');
  if (trigger?.kind !== 'schedule') return null;
  const next = nextFireAfter(trigger.schedule, after.getTime(), {
    timeZone: trigger.timeZone,
    dst: trigger.dst,
    anchor: anchor.getTime(),
  });
  return next === null ? null : new Date(next);
}

/**
 * The runs of an automation that take one of its `maxConcurrentRuns` places: started and not finished, except a run
 * with a step waiting for a person's yes (AR-56; a pending approval, as `waitingOn` `approval`). A card can wait for
 * days; the issues after it shouldn't wait with it. Nor a report's run once its fix began (report-trackers.md TA-69):
 * a fix, its review and its checks take hours, and the next customer's report shouldn't wait for them.
 */
export async function activeRunCount(db: Db, automationId: string, exceptRunId?: string): Promise<number> {
  const rows = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        inArray(automationRuns.status, ['running', 'waiting', 'paused', 'needs_review']),
        sql`not exists (
          select 1 from ${automationRunSteps}
            join ${approvals} on ${approvals.id} = ${automationRunSteps.approvalId}
           where ${automationRunSteps.runId} = ${automationRuns.id}
             and ${automationRunSteps.state} = 'waiting'
             and ${approvals.state} = 'pending')`,
        // Nor one waiting for the person's answer to a feature request (report-trackers.md TA-44).
        sql`not exists (
          select 1 from ${featureRequests}
           where ${featureRequests.runId} = ${automationRuns.id}
             and ${featureRequests.state} = 'waiting')`,
        // Nor a report's run whose fix began: its turns take the one outsiders' profile only in turn, handing a T3 Code
        // wait over when another waits (docs/decisions/outsiders-turns.md), and `fix.maxPerDay` bounds the fixes.
        sql`not (${automationRuns.scope}->>'kind' = 'tracker' and exists (
          select 1 from ${automationRunSteps}
           where ${automationRunSteps.runId} = ${automationRuns.id}
             and ${automationRunSteps.stepId} = 'fix'
             and ${automationRunSteps.startedAt} is not null))`,
      ),
    );
  return rows.filter((r) => r.id !== exceptRunId).length;
}

/** Trigger kinds that read the signed events after the burrow's cursor (BP-C07). */
export const EVENT_TRIGGER_KINDS = [
  'message_posted',
  'reaction_added',
  'github',
  'tracker',
  'mail',
  'findmy',
  'thing',
] as const;

/** Whether a trigger reads the events (the engine scans a burrow only while a live automation has one, SV-03). */
export function readsEvents(trigger: { kind: string }): boolean {
  return (EVENT_TRIGGER_KINDS as readonly string[]).includes(trigger.kind);
}

/** SQL: a version's definition (`automation_versions.definition`) has a trigger that reads the events. */
export function listensToEvents(definition: SQLWrapper): SQL {
  return sql`exists (select 1 from jsonb_array_elements(${definition} -> 'triggers') as t
    where t ->> 'kind' in (${sql.join(
      EVENT_TRIGGER_KINDS.map((k) => sql`${k}`),
      sql`, `,
    )}))`;
}
