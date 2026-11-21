/** Read models for plans, runs, approvals and pull requests. */
import type { Approval, Plan, PrStatus, PullRequest, Run, RunLogLine } from '@whombat/core';
import { alwaysAllowRow, PlanStep, prStatus } from '@whombat/core';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { withApprovalConnectionDetail } from '../connections/approvals';
import type { Db } from '../db/client';
import {
  approvals,
  automationRuns,
  canvases,
  events,
  messages,
  plans,
  prChecks,
  prCommits,
  prFiles,
  prReviewers,
  pullRequests,
  repos,
  runFiles,
  runLog,
  runSteps,
  runs,
} from '../db/schema/index';
import { iso, isoOrNull } from '../lib/time';
import { groupRows } from './group';

export type PlanRow = typeof plans.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;

/* Plans ------------------------------------------------------------------------------------------ */

export async function loadPlans(db: Db, ids: readonly string[]): Promise<Map<string, Plan>> {
  const out = new Map<string, Plan>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ plan: plans, canvasSlug: canvases.slug })
    .from(plans)
    .leftJoin(canvases, eq(canvases.id, plans.canvasId))
    .where(inArray(plans.id, [...new Set(ids)]));
  // The linked work's numbers for links (“Run #1907”, “approval #12”), resolved per read.
  const steps = rows.flatMap((r) => r.plan.steps);
  const runIds = [...new Set(steps.flatMap((s) => (s.runId ? [s.runId] : [])))];
  const approvalIds = [...new Set(steps.flatMap((s) => (s.approvalId ? [s.approvalId] : [])))];
  const automationRunIds = [...new Set(steps.flatMap((s) => (s.automationRunId ? [s.automationRunId] : [])))];
  const [runNumbers, approvalNumbers, automationNumbers] = await Promise.all([
    runIds.length
      ? db.select({ id: runs.id, number: runs.number }).from(runs).where(inArray(runs.id, runIds))
      : [],
    approvalIds.length
      ? db
          .select({ id: approvals.id, number: approvals.number })
          .from(approvals)
          .where(inArray(approvals.id, approvalIds))
      : [],
    automationRunIds.length
      ? db
          .select({ id: automationRuns.id, number: automationRuns.number })
          .from(automationRuns)
          .where(inArray(automationRuns.id, automationRunIds))
      : [],
  ]);
  const runNumberById = new Map(runNumbers.map((r) => [r.id, r.number]));
  const approvalNumberById = new Map(approvalNumbers.map((r) => [r.id, r.number]));
  const automationNumberById = new Map(automationNumbers.map((r) => [r.id, r.number]));
  const numberOf = (numbers: ReadonlyMap<string, number>, id: string | null | undefined) =>
    (id ? numbers.get(id) : undefined) ?? null;
  for (const { plan, canvasSlug } of rows) {
    out.set(plan.id, {
      id: plan.id,
      burrowId: plan.burrowId,
      title: plan.title,
      due: plan.due,
      conversationId: plan.conversationId,
      canvasId: plan.canvasId,
      canvasSlug: canvasSlug ?? null,
      // Parsing drops the stored bookkeeping (`followKey`, `startedAt`) and fills the fields older steps lack.
      steps: plan.steps.map((s) =>
        PlanStep.parse({
          ...s,
          refs: {
            runNumber: numberOf(runNumberById, s.runId),
            approvalNumber: numberOf(approvalNumberById, s.approvalId),
            automationRunNumber: numberOf(automationNumberById, s.automationRunId),
          },
        }),
      ),
      updatedAt: iso(plan.updatedAt),
      createdById: plan.createdById,
      createdAt: isoOrNull(plan.createdAt),
      source: plan.sourceMessageId
        ? { messageId: plan.sourceMessageId, threadRootId: plan.sourceThreadRootId }
        : null,
      messageId: plan.messageId,
    });
  }
  return out;
}

export async function loadPlan(db: Db, id: string): Promise<Plan | undefined> {
  return (await loadPlans(db, [id])).get(id);
}

/* Runs ------------------------------------------------------------------------------------------- */

export async function loadRuns(db: Db, rows: readonly RunRow[]): Promise<Run[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const cardIds = [...new Set(rows.flatMap((r) => (r.messageId ? [r.messageId] : [])))];
  const [steps, files, cards] = await Promise.all([
    db.select().from(runSteps).where(inArray(runSteps.runId, ids)).orderBy(asc(runSteps.idx)),
    db.select().from(runFiles).where(inArray(runFiles.runId, ids)).orderBy(asc(runFiles.position)),
    cardIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: messages.id, threadRootId: messages.threadRootId })
          .from(messages)
          .where(inArray(messages.id, cardIds)),
  ]);
  // The thread the run card is in (card-settle QC-01): its root, null when the card is top level or there is none.
  const threadOf = new Map(cards.map((c) => [c.id, c.threadRootId]));
  const stepsByRun = groupRows(steps, (s) => s.runId);
  const filesByRun = groupRows(files, (f) => f.runId);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    burrowId: row.burrowId,
    agentId: row.agentId,
    title: row.title,
    branch: row.branch,
    repoId: row.repoId,
    prNumber: row.prNumber,
    status: row.status,
    askedById: row.askedById,
    conversationId: row.conversationId,
    messageId: row.messageId,
    threadRootId: (row.messageId && threadOf.get(row.messageId)) || null,
    startedAt: iso(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    progress: row.progress,
    activity: row.activity,
    summary: row.summary,
    attention: row.attention,
    steps: (stepsByRun.get(row.id) ?? []).map((s) => ({
      title: s.title,
      detail: s.detail,
      at: isoOrNull(s.at),
      state: s.state,
    })),
    tests: row.tests,
    files: (filesByRun.get(row.id) ?? []).map((f) => ({ path: f.path, add: f.add, del: f.del })),
    diff: row.diff,
    keysUsed: row.keysUsed as Run['keysUsed'],
    logCount: row.logCount,
    pausedById: row.pausedById,
    takenOverById: row.takenOverById,
  }));
}

export async function loadRunsByIds(db: Db, ids: readonly string[]): Promise<Map<string, Run>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(runs)
    .where(inArray(runs.id, [...new Set(ids)]));
  return new Map((await loadRuns(db, rows)).map((r) => [r.id, r]));
}

export async function loadRun(db: Db, id: string): Promise<Run | undefined> {
  return (await loadRunsByIds(db, [id])).get(id);
}

export async function runByNumber(db: Db, burrowId: string, number: number): Promise<RunRow | undefined> {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.burrowId, burrowId), eq(runs.number, number)));
  return row;
}

export async function runLogLines(
  db: Db,
  runId: string,
  options: { after?: number; limit?: number; last?: number } = {},
): Promise<RunLogLine[]> {
  if (options.last !== undefined) {
    const rows = await db
      .select()
      .from(runLog)
      .where(eq(runLog.runId, runId))
      .orderBy(desc(runLog.seq))
      .limit(options.last);
    return rows.reverse().map((r) => ({ seq: r.seq, at: iso(r.at), text: r.text }));
  }
  const rows = await db
    .select()
    .from(runLog)
    .where(and(eq(runLog.runId, runId), gt(runLog.seq, options.after ?? -1)))
    .orderBy(asc(runLog.seq))
    .limit(options.limit ?? 200);
  return rows.map((r) => ({ seq: r.seq, at: iso(r.at), text: r.text }));
}

/* Approvals -------------------------------------------------------------------------------------- */

export function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    number: row.number,
    burrowId: row.burrowId,
    requesterId: row.requesterId,
    keyId: row.keyId as Approval['keyId'],
    action: row.action,
    title: row.title,
    question: row.question,
    target: row.target,
    whatHappens: row.whatHappens,
    explainer: row.explainer,
    summary: row.summary,
    conditions: row.conditions,
    state: row.state,
    decidedById: row.decidedById,
    decidedAt: isoOrNull(row.decidedAt),
    execution: row.execution,
    executedAt: isoOrNull(row.executedAt),
    conversationId: row.conversationId,
    messageId: row.messageId,
    involvedIds: row.involvedIds,
    eventId: row.eventId,
    // How long a yes to a command lasts (agent-computer.md AC-42), and a risky action's yes for once or always
    // (resourceful-agents.md RA-06): on `run_command` approvals and those `alwaysAllowRow` names.
    ...(row.action.type === 'run_command' || alwaysAllowRow(row.action) ? { scope: row.scope ?? null } : {}),
    ...(row.actionHash ? { actionHash: row.actionHash } : {}),
    // Approve later (one-whombat.md ONE-10, CT-338): when the approved action runs.
    ...(row.executeAt ? { executeAt: iso(row.executeAt) } : {}),
    createdAt: iso(row.createdAt),
  };
}

/**
 * The approval as `viewerId` sees it: in full, with a `connection_call`'s arguments for its decider. Every conversation
 * is the person's, so nobody reads an approval from outside the room it was asked in (an old pack tool call's
 * `whatHappensOutside` only keeps its words out of search).
 */
export async function approvalForViewer(db: Db, viewerId: string, row: ApprovalRow): Promise<Approval> {
  const [approval] = await approvalsForViewer(db, viewerId, [row]);
  return approval ?? toApproval(row);
}

/** Resolve a page's argument previews together, applying the same viewer checks to each approval. */
export function approvalsForViewer(
  db: Db,
  viewerId: string,
  rows: readonly ApprovalRow[],
): Promise<Approval[]> {
  return withApprovalConnectionDetail(db, rows.map(toApproval), viewerId);
}

export async function loadApprovals(db: Db, ids: readonly string[]): Promise<Map<string, Approval>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(approvals)
    .where(inArray(approvals.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, toApproval(r)]));
}

export async function approvalByNumber(
  db: Db,
  burrowId: string,
  number: number,
): Promise<ApprovalRow | undefined> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.burrowId, burrowId), eq(approvals.number, number)));
  return row;
}

const DECISION_EVENT_TYPES = ['approval.approved', 'approval.declined', 'approval.undone'];

/** The signed event of the approval's *last decision* (approve/decline/undo) — `null` before any decision.
 * Distinct from `Approval.eventId` (the `Asks` event that *created* the approval, always non-null once
 * requested). `ApprovalResponse.eventId`'s doc comment (`packages/core/src/contracts/work.ts`) calls it
 * "Signed event of the decision (decide / undo)"; see `docs/decisions/seed-wiring.md` SW-12. */
export async function lastDecisionEventId(db: Db, approvalId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.approvalId, approvalId), inArray(events.type, DECISION_EVENT_TYPES)))
    .orderBy(desc(events.seq))
    .limit(1);
  return row?.id ?? null;
}

/* Pull requests ---------------------------------------------------------------------------------- */

export async function loadPullRequests(db: Db, rows: readonly PullRequestRow[]): Promise<PullRequest[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const repoIds = [...new Set(rows.map((r) => r.repoId))];
  const [checks, reviewers, files, commits, repoRows] = await Promise.all([
    db.select().from(prChecks).where(inArray(prChecks.prId, ids)).orderBy(asc(prChecks.position)),
    db.select().from(prReviewers).where(inArray(prReviewers.prId, ids)).orderBy(asc(prReviewers.position)),
    db.select().from(prFiles).where(inArray(prFiles.prId, ids)).orderBy(asc(prFiles.position)),
    db.select().from(prCommits).where(inArray(prCommits.prId, ids)).orderBy(asc(prCommits.position)),
    db.select({ id: repos.id, fullName: repos.fullName }).from(repos).where(inArray(repos.id, repoIds)),
  ]);
  const repoNames = new Map(repoRows.map((r) => [r.id, r.fullName]));
  const checksByPr = groupRows(checks, (c) => c.prId);
  const reviewersByPr = groupRows(reviewers, (r) => r.prId);
  const filesByPr = groupRows(files, (f) => f.prId);
  const commitsByPr = groupRows(commits, (c) => c.prId);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    repoId: row.repoId,
    repoFullName: repoNames.get(row.repoId) ?? '',
    branch: row.branch,
    baseBranch: row.baseBranch,
    title: row.title,
    state: row.state,
    headSha: row.headSha,
    authorId: row.authorId,
    checks: (checksByPr.get(row.id) ?? []).map(toCheck),
    reviewers: (reviewersByPr.get(row.id) ?? []).map(toReviewer),
    files: (filesByPr.get(row.id) ?? []).map((f) => ({ path: f.path, add: f.add, del: f.del })),
    diff: row.diff,
    commits: (commitsByPr.get(row.id) ?? []).map((c) => ({
      sha: c.sha,
      message: c.message,
      authorId: c.authorId,
      at: iso(c.at),
    })),
    conversationId: row.conversationId,
    openedAt: iso(row.openedAt),
    mergedAt: isoOrNull(row.mergedAt),
    mergedById: row.mergedById,
    url: row.url,
  }));
}

function toCheck(c: typeof prChecks.$inferSelect): PullRequest['checks'][number] {
  return { name: c.name, state: c.state, note: c.note, durationMs: c.durationMs, tests: c.tests, url: c.url };
}

function toReviewer(r: typeof prReviewers.$inferSelect): PullRequest['reviewers'][number] {
  return { principalId: r.principalId, state: r.state, at: isoOrNull(r.at) };
}

/**
 * The pull requests of branch rooms with what their sidebar dot needs (`prStatus`: state, checks, reviewers), without
 * files, commits or the diff (server-efficiency.md SV-06). In the order the rows come, like `loadPullRequests`.
 */
export async function branchRoomPullRequests(
  db: Db,
  conversationIds: readonly string[],
): Promise<{ conversationId: string; number: number; branch: string; status: PrStatus }[]> {
  if (conversationIds.length === 0) return [];
  const rows = await db
    .select({
      id: pullRequests.id,
      conversationId: pullRequests.conversationId,
      number: pullRequests.number,
      branch: pullRequests.branch,
      state: pullRequests.state,
    })
    .from(pullRequests)
    .where(inArray(pullRequests.conversationId, [...conversationIds]));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [checks, reviewers] = await Promise.all([
    db.select().from(prChecks).where(inArray(prChecks.prId, ids)).orderBy(asc(prChecks.position)),
    db.select().from(prReviewers).where(inArray(prReviewers.prId, ids)).orderBy(asc(prReviewers.position)),
  ]);
  const checksByPr = groupRows(checks, (c) => c.prId);
  const reviewersByPr = groupRows(reviewers, (r) => r.prId);
  return rows.map((row) => ({
    conversationId: row.conversationId,
    number: row.number,
    branch: row.branch,
    status: prStatus({
      state: row.state,
      checks: (checksByPr.get(row.id) ?? []).map(toCheck),
      reviewers: (reviewersByPr.get(row.id) ?? []).map(toReviewer),
    }),
  }));
}

/**
 * How many pending approvals of the burrow `viewer` may decide (`canDecide`, counted in SQL, server-efficiency.md
 * SV-06): a private one only by its approvers, every other one by the person (OP-S07, OP-S62); never by an agent. The
 * first `person_approves` condition decides, as in `canDecide`.
 */
export async function decidablePendingCount(
  db: Db,
  burrowId: string,
  viewer: { id: string; kind: 'person' | 'agent' | 'system' },
): Promise<number> {
  if (viewer.kind !== 'person') return 0;
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from approvals a
      left join lateral (
        select e.c from jsonb_array_elements(a.conditions) with ordinality as e(c, i)
         where e.c ->> 'kind' = 'person_approves' order by e.i limit 1) pc on true
     where a.burrow_id = ${burrowId} and a.state = 'pending'
       and case
             when (pc.c ->> 'private') = 'true' then coalesce(pc.c -> 'approverIds' @> jsonb_build_array(${viewer.id}::text), false)
             else true
           end`);
  return row?.n ?? 0;
}

export async function loadPullRequest(db: Db, row: PullRequestRow): Promise<PullRequest> {
  const [pr] = await loadPullRequests(db, [row]);
  return pr as PullRequest;
}

/** A PR by number; with several enabled repos, `repo` (full name) disambiguates. */
export async function prByNumber(
  db: Db,
  burrowId: string,
  number: number,
  repo?: string,
): Promise<PullRequestRow | undefined> {
  const rows = await db
    .select({ pr: pullRequests, fullName: repos.fullName })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.burrowId, burrowId), eq(pullRequests.number, number)))
    .orderBy(asc(repos.position));
  const match = repo ? rows.find((r) => r.fullName === repo) : rows[0];
  return match?.pr;
}
