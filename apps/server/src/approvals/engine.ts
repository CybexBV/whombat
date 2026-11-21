/**
 * Approvals engine (ARCHITECTURE "Approvals"): re-evaluates conditions from live state (checks on the PR's
 * head commit, the PR review, the person's decision) and runs the action once an approved request has every
 * condition met — "approve in advance" executes on its own when the last check goes green.
 *
 * Every transition is a commit signed by the requester (the agent whose key turns), so the log reads
 * "Dusty · Deployed feat/invoice-pdf to staging".
 */
import {
  type Approval,
  type ApprovalActionType,
  ApprovalCondition,
  type ApprovalLiveState,
  actionScope,
  blockedEventFields,
  checksState,
  completeExecution,
  type Decision,
  decide,
  describeActionForLog,
  describeDecision,
  type ExecutionOutcome,
  evaluate,
  formatEuro,
  IDLE_EXECUTION,
  isPersonalAction,
  KEY_CATALOG,
  type LiveChecks,
  readyToExecute,
  runCommandPhrase,
  shortSha,
  startExecution,
  topics,
  verifyEvent,
} from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadEventRow, rowToSignedEvent } from '../audit/events';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { approvals, githubDeploys, prChecks, principals, prReviewers, runs } from '../db/schema/index';
import { clearDecidedApproval } from '../domain/notify';
import { followPlanWork } from '../domain/plan-follow';
import { indexApproval } from '../domain/search-index';
import { publishApprovalChanged } from '../home/notify';
import { ApiError, conflict, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { loadGrants, loadPrincipalRows, loadPrincipalsByIds, nameInfo } from '../read/principals';
import { prByNumber, toApproval } from '../read/work';
import { refreshApprovalActivity } from '../runtime/activity';
import { type DispatchScope, runInDispatchScope } from '../runtime/dispatch-scope';
import type { Services } from '../services';
import { approvalActionHash } from './create';
import { PUSH_ALLOWANCE_MS, pushLapsedText } from './push';
import { nothingHappened } from './unavailable';

/**
 * Runs an approved action. `{deferred: true}`: the action was started and finishes later (a GitHub Actions
 * deploy completes from its `workflow_run` webhook) through `ApprovalEngine.completeDeferred`. `logged`: the
 * executor ran a command that signed what happened itself (“Merged PR #…” by the person), so the requester's
 * `approval.executed` event carries no second text.
 */
export type Executor = (
  approval: Approval,
  services: Services,
) => Promise<(ExecutionOutcome & { logged?: boolean }) | DeferredExecution>;

export interface DeferredExecution {
  deferred: true;
}

export type ApprovalRow = typeof approvals.$inferSelect;

/**
 * Checked inside `StartExecution` (in its transaction, under the burrow lock) right before an approved action
 * runs: a reason to refuse, or null. The automations engine uses it to re-check the publisher's authority and
 * the live binding of an automation's approval (bp-automations BP-C08, BP-C09). A guard may write to its own
 * tables in `ctx.tx`; its refusal fails the execution (the person retries with Undo and Approve, or whoever set the
 * guard asks again).
 */
export type ExecutionGuard = (
  ctx: ApplyContext,
  approval: Approval,
  row: ApprovalRow,
) => Promise<string | null>;

/**
 * After a crash an execution may be left `running`. A reconciler (by deferred command name) says what really
 * happened: `done` (the command's effect is there), `not_done` (it provably did not happen and running it again
 * is safe), or `unknown`. Without one the execution is marked failed and uncertain: never run twice.
 */
export type ExecutionReconciler = (
  approval: Approval,
  row: ApprovalRow,
) => Promise<'done' | 'not_done' | 'unknown'>;

/** The text a recovered execution fails with: it may or may not have happened. */
export const UNCERTAIN_EXECUTION =
  'Whombat stopped while this was running, so it may or may not have happened. Check, then Undo and Approve to try again.';

/** Why an approval without its hash is refused: nothing can show that what would run is what was approved. */
export const NO_ACTION_HASH =
  'Whombat can’t check that this is what was approved, so it needs a new approval.';

/**
 * What would run must be what was approved: the stored hash, the row and the signed event agree. An approval
 * without a hash is never trusted.
 */
async function verifyActionHash(ctx: ApplyContext, row: ApprovalRow): Promise<string | null> {
  if (!row.actionHash) return NO_ACTION_HASH;
  const stale = 'What would run is not what was approved, so it needs a new approval.';
  if (approvalActionHash(row.action, row.command ?? null, row.actionBinding) !== row.actionHash) return stale;
  if (!row.eventId) return stale;
  const eventRow = await loadEventRow(ctx.tx, row.burrowId, row.eventId);
  if (!eventRow || eventRow.payload.actionHash !== row.actionHash) return stale;
  const [requester] = await ctx.tx
    .select({ publicKey: principals.publicKey })
    .from(principals)
    .where(eq(principals.id, row.requesterId));
  if (!requester || !verifyEvent(rowToSignedEvent(eventRow), requester.publicKey).ok) return stale;
  return null;
}

/**
 * Succeeds at once without doing anything: the scripted demo storyline's stand-in and tests that ask for it
 * explicitly (`setExecutor`). Never installed by default: no production path signs success for something Whombat
 * didn't do (docs/decisions/essentials-agents.md EA-02).
 */
export const simulatedExecutor: Executor = async () => ({ ok: true, resultUrl: null });

/** Who the executed text names: the person who approved and the agent that asked (short names). */
export interface ExecutedNames {
  approver?: string | null;
  requester?: string | null;
}

export function executedText(approval: Approval, names: ExecutedNames = {}): string | null {
  const a = approval.action;
  switch (a.type) {
    case 'deploy':
      return `Deployed ${a.params.ref} to ${a.params.environment}`;
    case 'refund':
      return `Refunded ${formatEuro(a.params.amountCents)} on account ${a.params.accountId}`;
    // What Whombat did: it let the agent push that branch (the push itself is the mirror's “Pushed …”, EA-06).
    case 'push_shared_branch':
      return `Allowed ${names.requester ?? 'the agent'} to push ${a.params.branch}`;
    case 'merge_pr':
      return `Merged PR #${a.params.prNumber} into ${a.params.base}`;
    case 'message_external':
      return `Messaged ${a.params.to}`;
    // A yes to a custom request is a person's agreement, never “done” (EA-02).
    case 'custom':
      return `${names.approver ?? 'A person'} approved: ${approval.title}`.slice(0, 500);
    // Personal actions: the audit log holds no content (docs/decisions/connectors.md PA-09).
    case 'mail_send':
      return 'Sent an email';
    case 'calendar_invite':
      return a.params.op === 'delete'
        ? 'Cancelled an event'
        : a.params.op === 'update'
          ? 'Sent an updated calendar invite'
          : 'Sent a calendar invite';
    case 'files_share':
      return 'Shared a file';
    case 'files_trash':
      return 'Moved a file to the trash';
    // Signed by the agent that asked; the person who approved signs the `Keys` event that gives it.
    case 'grant_key':
      return `Got “${KEY_CATALOG[a.params.keyId].label}”`;
    // A connection tool call (connections-catalog.md CX-21): its result is posted where the agent asked.
    case 'connection_call':
      return `Allowed ${names.requester ?? 'the agent'} to use ${a.params.tool} on ${a.params.handle}`;
    // One of the agent's commands (agent-computer.md AC-41, AC-42): Whombat allowed it — whether it ran and how is
    // the command's own output and the agent's activity, never signed here as done (EA-03).
    case 'run_command': {
      const how =
        approval.scope === 'task' ? ' for this task' : approval.scope === 'agent' ? ' from now on' : ' once';
      return `Allowed ${names.requester ?? 'the agent'} to ${runCommandPhrase(a.params.category, a.params.target)}${how}`;
    }
  }
}

async function loadApprovalRow(db: Db, id: string) {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw notFound('Approval');
  return row;
}

/**
 * After an approval changed, in its commit: its DECISION search document (WS-24), the plan steps that follow it
 * (WS-05: “Needs a person”, “Approved”, “Deployed”, blocked “Declined” / “Failed”) and Home for the people who may
 * decide it (Needs you, the chat it waits in; home-redesign.md HR-43).
 */
export async function syncPlanSteps(ctx: ApplyContext, approval: Approval): Promise<void> {
  await indexApproval(ctx.tx, approval.id);
  await followPlanWork(ctx, { kind: 'approval', id: approval.id });
  await publishApprovalChanged(ctx, approval);
}

export function publishApproval(ctx: ApplyContext, approval: Approval, eventId: string | null): void {
  ctx.publish(topics.burrow(ctx.burrow.id), { type: 'approval.updated', approval }, { eventId });
  ctx.beforeCommit(() => refreshApprovalActivity(ctx, approval.id, ctx.now));
  const services = ctx.services;
  const burrowSlug = ctx.burrow.slug;
  // Push delivery doesn't hold the response; one approval's updates go in order (server-efficiency.md SV-02).
  ctx.background(
    'approval live activity',
    async () => {
      await services.liveActivity.onApprovalChanged(approval, burrowSlug);
      // Decided: its “needs you” goes from the approvers' phones (NT-16).
      await clearDecidedApproval(services, approval, burrowSlug);
    },
    `live:approval:${approval.id}`,
  );
}

/**
 * Stores a condition snapshot computed from live state. Compare-and-set on the conditions it was computed
 * from (`previous`): re-evaluation runs after commits, outside the burrow lock, so a hook that read live state
 * before a newer commit must not overwrite that commit's snapshot. Returns null when it lost the race.
 */
export const RefreshConditions = defineCommand({
  name: 'approval.refresh_conditions',
  schema: z.object({
    approvalId: z.string(),
    previous: z.array(ApprovalCondition),
    conditions: z.array(ApprovalCondition),
  }),
  async apply(tx, ctx, input): Promise<Approval | null> {
    const updated = await tx
      .update(approvals)
      .set({ conditions: input.conditions, updatedAt: ctx.now })
      .where(
        and(
          eq(approvals.id, input.approvalId),
          eq(approvals.burrowId, ctx.burrow.id),
          sql`${approvals.conditions} = ${JSON.stringify(input.previous)}::jsonb`,
        ),
      )
      .returning({ id: approvals.id });
    if (updated.length === 0) return null;
    const approval = toApproval(await loadApprovalRow(tx, input.approvalId));
    publishApproval(ctx, approval, null);
    await syncPlanSteps(ctx, approval);
    return approval;
  },
});

/** Two spellings of one commit: a short sha is a prefix of the full one. */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * The commit an approved action runs, fixed when it starts: a deploy of "the latest commit" (`sha: null`)
 * with a checks condition runs the head its checks passed on, not whatever the branch points to by the time
 * the workflow starts. A deploy that names a commit must be the one the checks passed on.
 */
function commitToRun(approval: Approval): { sha: string | null; mismatch: string | null } {
  if (approval.action.type !== 'deploy') return { sha: null, mismatch: null };
  const checked = approval.conditions.find((c) => c.kind === 'checks_pass')?.headSha ?? null;
  const named = approval.action.params.sha;
  if (named && checked && !sameCommit(named, checked))
    return {
      sha: null,
      mismatch: `Checks passed on ${shortSha(checked)}, not on ${shortSha(named)}, the commit that was approved.`,
    };
  return { sha: named ?? checked, mismatch: null };
}

/** The approval as the executor sees it: the deploy pinned to the commit fixed at start. */
function withCommit(approval: Approval, sha: string | null): Approval {
  if (approval.action.type !== 'deploy' || !sha) return approval;
  return { ...approval, action: { ...approval.action, params: { ...approval.action.params, sha } } };
}

/**
 * The requester's keys are checked again when an approved request is about to run: a key taken away (or
 * narrowed) after the approval stops it. Deferred commands re-enter the pipeline, which checks the keys
 * itself; this covers requests that run an executor directly (`request_approval`). Null = still allowed.
 */
async function keysStillTurn(ctx: ApplyContext, approval: Approval): Promise<Decision | null> {
  const actor = ctx.actor;
  const grants = actor.kind === 'agent' ? await loadGrants(ctx.tx, actor.id) : [];
  const decision = decide(
    actor.kind === 'person' ? { id: actor.id, kind: 'person' } : { id: actor.id, kind: 'agent' },
    grants,
    approval.keyId,
    actionScope(approval.action),
  );
  return decision.outcome === 'deny' ? decision : null;
}

const StartExecution = defineCommand({
  name: 'approval.start_execution',
  schema: z.object({ approvalId: z.string() }),
  async apply(tx, ctx, input): Promise<{ approval: Approval; started: boolean; sha: string | null }> {
    const row = await loadApprovalRow(tx, input.approvalId);
    const stored = toApproval(row);
    // Conditions are re-read from live state inside the burrow lock: a snapshot written by a hook that
    // raced a push may say "passed" for a head that is no longer the PR's.
    const approval = evaluate(stored, await ctx.services.approvals.liveState(stored, tx));
    const refreshed = JSON.stringify(approval.conditions) !== JSON.stringify(stored.conditions);
    const next = startExecution(approval, ctx.at);
    if (!next.ok) {
      if (!refreshed) throw conflict(next.message);
      await tx
        .update(approvals)
        .set({ conditions: approval.conditions, updatedAt: ctx.now })
        .where(eq(approvals.id, approval.id));
      publishApproval(ctx, approval, null);
      await syncPlanSteps(ctx, approval);
      return { approval, started: false, sha: null };
    }
    // Asking for a key needs no key (key-requests.md KR-02): the grant is checked as the person who gives it.
    const denied =
      row.command || approval.action.type === 'grant_key' ? null : await keysStillTurn(ctx, approval);
    const commit = commitToRun(approval);
    let refusal: string | null = commit.mismatch ?? (await verifyActionHash(ctx, row));
    if (!denied && !refusal) {
      for (const guard of ctx.services.approvals.guards) {
        refusal = await guard(ctx, approval, row);
        if (refusal) break;
      }
    }
    if (denied || refusal) {
      const failed: Approval = {
        ...approval,
        execution: {
          ...IDLE_EXECUTION,
          state: 'failed',
          finishedAt: ctx.at,
          error: denied ? describeDecision(denied, ctx.actor.shortName) : refusal,
        },
      };
      await tx
        .update(approvals)
        .set({ execution: failed.execution, conditions: failed.conditions, updatedAt: ctx.now })
        .where(eq(approvals.id, approval.id));
      const event = denied
        ? await ctx.emit({
            ...blockedEventFields(denied, ctx.actor.shortName, describeActionForLog(approval.action)),
            where: null,
            approvalId: approval.id,
            ref: { type: 'approval', number: approval.number },
            payload: { approvalId: approval.id, keyId: approval.keyId, reason: denied.reason },
          })
        : await ctx.emit({
            type: 'approval.failed',
            kind: 'Asks',
            text: `Couldn’t ${describeActionForLog(approval.action)}: ${refusal}`.slice(0, 500),
            where: null,
            approvalId: approval.id,
            ref: { type: 'approval', number: approval.number },
            payload: { approvalId: approval.id, ok: false, resultUrl: null },
          });
      publishApproval(ctx, failed, event.id);
      await syncPlanSteps(ctx, failed);
      return { approval: failed, started: false, sha: null };
    }
    await tx
      .update(approvals)
      .set({ execution: next.approval.execution, conditions: next.approval.conditions, updatedAt: ctx.now })
      .where(eq(approvals.id, approval.id));
    const event = await ctx.emit({
      type: 'approval.executing',
      kind: 'Asks',
      text: null,
      where: null,
      approvalId: approval.id,
      ref: { type: 'approval', number: approval.number },
      payload: { approvalId: approval.id, ...(commit.sha ? { sha: commit.sha } : {}) },
    });
    publishApproval(ctx, next.approval, event.id);
    await syncPlanSteps(ctx, next.approval);
    return { approval: next.approval, started: true, sha: commit.sha };
  },
});

/** “Couldn’t send an email: …” (or “Couldn’t send an email.” with no detail to give). */
function failedText(approval: Approval, detail: string | null): string {
  const what = describeActionForLog(approval.action);
  return (detail ? `Couldn’t ${what}: ${detail}` : `Couldn’t ${what}.`).slice(0, 500);
}

/** The short names an executed text uses. */
async function executedNames(tx: Db, approval: Approval): Promise<ExecutedNames> {
  const ids = [approval.requesterId, ...(approval.decidedById ? [approval.decidedById] : [])];
  const rows = await loadPrincipalsByIds(tx, ids);
  const name = (id: string | null) => {
    const row = id ? rows.find((r) => r.id === id) : undefined;
    return row ? nameInfo(row).shortName : null;
  };
  return { approver: name(approval.decidedById), requester: name(approval.requesterId) };
}

const CompleteExecution = defineCommand({
  name: 'approval.complete_execution',
  schema: z.object({
    approvalId: z.string(),
    ok: z.boolean(),
    resultUrl: z.string().nullable().optional(),
    error: z.string().optional(),
    /** The executor's own measured duration (e.g. a deploy workflow run), when it reports one. */
    durationMs: z.number().int().nonnegative().optional(),
    /** A deferred command ran and wrote its own log row. */
    ranCommand: z.boolean().default(false),
    /**
     * What the log says after “Couldn’t …:” when it must not repeat `error` (a private approval, IN-21);
     * null: nothing after it. Omitted: `error`.
     */
    logError: z.string().nullable().optional(),
  }),
  async apply(tx, ctx, input) {
    const approval = toApproval(await loadApprovalRow(tx, input.approvalId));
    const measured = input.durationMs !== undefined ? { durationMs: input.durationMs } : {};
    const outcome: ExecutionOutcome = input.ok
      ? { ok: true, resultUrl: input.resultUrl ?? null, ...measured }
      : { ok: false, error: input.error ?? 'It didn’t work.', ...measured };
    const next = completeExecution(approval, ctx.at, outcome);
    if (!next.ok) throw conflict(next.message);
    await tx
      .update(approvals)
      .set({
        execution: next.approval.execution,
        executedAt: next.approval.executedAt ? new Date(next.approval.executedAt) : null,
        updatedAt: ctx.now,
      })
      .where(eq(approvals.id, approval.id));
    const event = await ctx.emit({
      type: input.ok ? 'approval.executed' : 'approval.failed',
      kind: 'Asks',
      text: input.ok
        ? input.ranCommand
          ? null
          : executedText(approval, await executedNames(tx, approval))
        : failedText(
            approval,
            input.logError === undefined ? (outcome.ok ? '' : outcome.error) : input.logError,
          ),
      where: null,
      approvalId: approval.id,
      ref: { type: 'approval', number: approval.number },
      payload: { approvalId: approval.id, ok: input.ok, resultUrl: input.resultUrl ?? null },
    });
    publishApproval(ctx, next.approval, event.id);
    await syncPlanSteps(ctx, next.approval);
    return next.approval;
  },
});

/**
 * Settles an execution a crash left `running` (see `ExecutionReconciler`): `done` completes it, `not_done` puts it
 * back to idle so the normal path runs it once more, `unknown` fails it as uncertain. Compare-and-set on the
 * execution's start time, so it never touches an execution that was started again meanwhile.
 */
const RecoverExecution = defineCommand({
  name: 'approval.recover_execution',
  schema: z.object({
    approvalId: z.string(),
    startedAt: z.string().nullable(),
    outcome: z.enum(['done', 'not_done', 'unknown']),
  }),
  async apply(tx, ctx, input): Promise<Approval | null> {
    const row = await loadApprovalRow(tx, input.approvalId);
    const approval = toApproval(row);
    if (approval.execution.state !== 'running' || approval.execution.startedAt !== input.startedAt)
      return null;
    let next: Approval;
    if (input.outcome === 'not_done') {
      next = { ...approval, execution: { ...IDLE_EXECUTION } };
    } else {
      const done = completeExecution(
        approval,
        ctx.at,
        input.outcome === 'done' ? { ok: true, resultUrl: null } : { ok: false, error: UNCERTAIN_EXECUTION },
      );
      if (!done.ok) return null;
      next = done.approval;
    }
    await tx
      .update(approvals)
      .set({
        execution: next.execution,
        executedAt: next.executedAt ? new Date(next.executedAt) : null,
        updatedAt: ctx.now,
      })
      .where(eq(approvals.id, approval.id));
    const event = await ctx.emit({
      type:
        input.outcome === 'done'
          ? 'approval.executed'
          : input.outcome === 'unknown'
            ? 'approval.failed'
            : 'approval.recovered',
      kind: 'Asks',
      text: input.outcome === 'unknown' ? failedText(approval, 'it may or may not have happened') : null,
      where: null,
      approvalId: approval.id,
      ref: { type: 'approval', number: approval.number },
      payload: { approvalId: approval.id, recovered: input.outcome },
    });
    publishApproval(ctx, next, event.id);
    await syncPlanSteps(ctx, next);
    return next;
  },
});

export class ApprovalEngine {
  private readonly executors = new Map<ApprovalActionType, Executor>();
  private readonly running = new Set<string>();
  /** Checks right before an approved action runs (see `ExecutionGuard`). */
  readonly guards: ExecutionGuard[] = [];
  private readonly reconcilers = new Map<string, ExecutionReconciler>();
  /** Executions started before this moment belong to an earlier process (single server process, BP-10). */
  private readonly bootedAt: Date;

  constructor(private readonly services: Services) {
    this.bootedAt = services.clock();
  }

  addGuard(guard: ExecutionGuard): void {
    this.guards.push(guard);
  }

  /** How to tell what happened to a deferred command a crash interrupted (by command name). */
  setReconciler(commandName: string, reconciler: ExecutionReconciler): void {
    this.reconcilers.set(commandName, reconciler);
  }

  /**
   * Boot-time and periodic recovery (BP-10): executions left `running` by a process that is gone are settled
   * (reconciled, else failed as uncertain — never run twice); then every approved request that has not run is
   * re-evaluated, so an approval decided just before a crash still executes. `staleMs`: an execution this
   * process did not start counts as abandoned once it started before boot or this long ago. Returns what it did.
   */
  async recover(options: { staleMs?: number } = {}): Promise<{ settled: number; reevaluated: number }> {
    const db = this.services.db;
    const now = this.services.clock();
    const cutoff = new Date(
      Math.max(this.bootedAt.getTime(), now.getTime() - (options.staleMs ?? 15 * 60_000)),
    );
    const stuck = await db
      .select()
      .from(approvals)
      .where(and(sql`${approvals.execution}->>'state' = 'running'`, sql`${approvals.executedAt} is null`));
    let settled = 0;
    for (const row of stuck) {
      if (this.running.has(row.id)) continue;
      const approval = toApproval(row);
      const startedAt = approval.execution.startedAt;
      // A yes to a push waits for the agent's push (approvals/push.ts): not stuck, until the day it had is over.
      if (approval.action.type === 'push_shared_branch') {
        if (startedAt && now.getTime() - Date.parse(startedAt) < PUSH_ALLOWANCE_MS) continue;
        const [agent] = await loadPrincipalsByIds(db, [approval.requesterId]);
        await this.completeDeferred(row.id, {
          ok: false,
          error: pushLapsedText(agent ? nameInfo(agent).shortName : 'The agent', approval),
        });
        settled++;
        continue;
      }
      if (startedAt && Date.parse(startedAt) >= cutoff.getTime()) continue;
      // A GitHub deploy finishes later from the poller (deferred): it is not stuck.
      const [deploy] = await db
        .select({ state: githubDeploys.state })
        .from(githubDeploys)
        .where(eq(githubDeploys.approvalId, row.id));
      if (deploy) continue;
      const reconcile = row.command ? this.reconcilers.get(row.command.name) : undefined;
      const outcome = reconcile ? await reconcile(approval, row).catch(() => 'unknown' as const) : 'unknown';
      const res = await this.services.pipeline.commit(
        RecoverExecution,
        { approvalId: row.id, startedAt, outcome },
        { burrowId: row.burrowId, actorId: row.requesterId },
      );
      if (res.status === 'ok' && res.result) settled++;
    }
    const waiting = await db
      .selectDistinct({ burrowId: approvals.burrowId })
      .from(approvals)
      .where(
        and(
          eq(approvals.state, 'approved'),
          sql`${approvals.executedAt} is null`,
          sql`${approvals.execution}->>'state' = 'idle'`,
        ),
      );
    for (const { burrowId } of waiting) await this.reevaluate(burrowId);
    return { settled, reevaluated: waiting.length };
  }

  /** Install the executor for an action type (the built-ins, GitHub deploys, connectors, the demo, tests). */
  setExecutor(type: ApprovalActionType, executor: Executor): void {
    this.executors.set(type, executor);
  }

  /** Takes an executor away (a deploy workflow switched off; tests of what an unsupported type does). */
  removeExecutor(type: ApprovalActionType): void {
    this.executors.delete(type);
  }

  /** The executor for an action type, or null when nothing here carries it out (`perform_action`, the demo). */
  executorFor(type: ApprovalActionType): Executor | null {
    return this.executors.get(type) ?? null;
  }

  /** Whether an approved request of this type can be carried out here (else it is refused up front, EA-03). */
  hasExecutor(type: ApprovalActionType): boolean {
    return this.executors.has(type);
  }

  /** Live facts for an approval's conditions: checks and reviews of the PR it is about. */
  async liveState(approval: Approval, db: Db = this.services.db): Promise<ApprovalLiveState> {
    const prNumber =
      approval.conditions.find((c) => c.kind === 'checks_pass' || c.kind === 'review_approved')?.prNumber ??
      (approval.action.type === 'deploy' ? approval.action.params.prNumber : undefined) ??
      null;
    if (!prNumber) return {};
    // The PR of the action's own repo: a deploy's, or the merge's (PR numbers repeat across repos).
    const repo =
      approval.action.type === 'deploy' || approval.action.type === 'merge_pr'
        ? approval.action.params.repo
        : undefined;
    const pr = await prByNumber(db, approval.burrowId, prNumber, repo);
    if (!pr) return {};
    const [checks, reviewers, fixingRuns] = await Promise.all([
      db.select().from(prChecks).where(eq(prChecks.prId, pr.id)),
      db.select().from(prReviewers).where(eq(prReviewers.prId, pr.id)),
      db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(eq(runs.burrowId, pr.burrowId), eq(runs.branch, pr.branch), inArray(runs.status, ['live'])),
        ),
    ]);
    const aggregate = checksState(checks);
    const withTests = checks.filter((c) => c.tests);
    const live: LiveChecks = {
      headSha: pr.headSha,
      state: aggregate === 'none' ? 'pending' : aggregate,
      passed: withTests.length
        ? withTests.reduce((n, c) => n + (c.tests?.passed ?? 0), 0)
        : checks.filter((c) => c.state === 'passed' || c.state === 'skipped').length,
      total: withTests.length ? withTests.reduce((n, c) => n + (c.tests?.total ?? 0), 0) : checks.length,
      fixing: fixingRuns.length > 0,
    };
    const reviews: Record<string, { state: (typeof reviewers)[number]['state']; at: string | null }> = {};
    for (const r of reviewers) reviews[r.principalId] = { state: r.state, at: r.at ? iso(r.at) : null };
    return { checks: live, reviews };
  }

  /**
   * Refreshes conditions of open approvals in a burrow (or the given ones) and executes every approved
   * request whose conditions are all met. Safe to call after any commit.
   */
  async reevaluate(burrowId: string, options: { approvalIds?: string[] } = {}): Promise<void> {
    const db = this.services.db;
    const where = [eq(approvals.burrowId, burrowId), sql`${approvals.executedAt} is null`];
    if (options.approvalIds?.length) where.push(inArray(approvals.id, options.approvalIds));
    const rows = await db
      .select()
      .from(approvals)
      .where(and(...where, inArray(approvals.state, ['pending', 'approved'])));
    for (const row of rows) {
      let approval = toApproval(row);
      const live = await this.liveState(approval);
      const refreshed = evaluate(approval, live);
      if (JSON.stringify(refreshed.conditions) !== JSON.stringify(approval.conditions)) {
        const res = await this.services.pipeline.commit(
          RefreshConditions,
          { approvalId: approval.id, previous: approval.conditions, conditions: refreshed.conditions },
          { burrowId, actorId: approval.requesterId },
        );
        if (res.status !== 'ok' || !res.result) continue; // a newer snapshot is in; its own hook goes on
        approval = res.result;
      }
      // Approve later (one-whombat.md ONE-10): a yes for later waits until its time (the Home jobs' ticker re-evaluates).
      if (row.executeAt && row.executeAt.getTime() > this.services.clock().getTime()) continue;
      if (readyToExecute(approval)) await this.execute(approval);
    }
  }

  /** Runs an approved request: start → executor (or the deferred command) → complete. */
  async execute(approval: Approval): Promise<void> {
    if (this.running.has(approval.id)) return;
    // Draining (MR-15): an approved action waits, approved and durable; `recover` re-evaluates it on resume.
    if (this.services.maintenance.paused) return;
    this.running.add(approval.id);
    const { pipeline } = this.services;
    const base = { burrowId: approval.burrowId, actorId: approval.requesterId };
    try {
      let running: Approval;
      try {
        const started = await pipeline.commit(StartExecution, { approvalId: approval.id }, base);
        // Not started: live state says it is not ready after all, or it was blocked (key taken away).
        if (started.status !== 'ok' || !started.result.started) return;
        running = withCommit(started.result.approval, started.result.sha);
      } catch {
        return; // someone else started it, or it is no longer ready
      }
      const [row] = await this.services.db.select().from(approvals).where(eq(approvals.id, approval.id));
      let outcome: (ExecutionOutcome & { logged?: boolean }) | DeferredExecution;
      let ranCommand = false;
      let logError: string | null | undefined;
      // What the approved request does — the messages it posts, the agents they wake — is for the person it was made
      // for, whoever approved it (SUB-28).
      const scope: DispatchScope = {
        dispatchId: null,
        agentId: approval.requesterId,
        onBehalfOfAccountId: row?.onBehalfOfAccountId ?? null,
      };
      try {
        if (row?.command && !pipeline.has(row.command.name)) {
          // A command this Whombat no longer has (a pack tool's call, skill-store.md SST-12): an old approval still
          // renders, and a yes to it says nothing happened.
          outcome = { ok: false, error: nothingHappened(running.action) };
        } else if (row?.command) {
          ranCommand = true;
          const command = row.command;
          const res = await runInDispatchScope(scope, () =>
            pipeline.commit(command.name, command.input, { ...base, approvalId: approval.id }),
          );
          outcome =
            res.status === 'ok'
              ? { ok: true, resultUrl: null }
              : { ok: false, error: res.status === 'blocked' ? res.message : 'It asked again.' };
        } else {
          const executor = this.executors.get(running.action.type);
          // Nothing here carries it out (a refund, an outside message, a deploy without a workflow): it fails and
          // says nothing happened, never “done” (EA-03).
          outcome = executor
            ? await runInDispatchScope(scope, () => executor(running, this.services))
            : { ok: false, error: nothingHappened(running.action) };
          if (!('deferred' in outcome) && outcome.ok && outcome.logged) ranCommand = true;
        }
      } catch (err) {
        outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
        // An error may quote the person's account (a sheet name, a label): the approval keeps it, the signed log gets
        // only a content-free reason when the error has one, and nothing more for a personal action (PA-09, IN-21).
        if (err instanceof ApiError && typeof err.extra.logMessage === 'string')
          logError = err.extra.logMessage;
        else if (isPersonalAction(running.action)) logError = null;
      }
      if ('deferred' in outcome) return;
      await pipeline.commit(
        CompleteExecution,
        {
          approvalId: approval.id,
          ok: outcome.ok,
          resultUrl: outcome.ok ? (outcome.resultUrl ?? null) : null,
          error: outcome.ok ? undefined : outcome.error,
          durationMs: outcome.durationMs,
          ranCommand: ranCommand && outcome.ok,
          ...(logError !== undefined ? { logError } : {}),
        },
        base,
      );
    } finally {
      this.running.delete(approval.id);
    }
  }

  /** Finishes an execution an executor deferred (see `Executor`), signed by the requester. */
  async completeDeferred(approvalId: string, outcome: ExecutionOutcome): Promise<void> {
    const row = await loadApprovalRow(this.services.db, approvalId);
    if (row.execution.state !== 'running') return;
    await this.services.pipeline.commit(
      CompleteExecution,
      {
        approvalId,
        ok: outcome.ok,
        resultUrl: outcome.ok ? (outcome.resultUrl ?? null) : null,
        error: outcome.ok ? undefined : outcome.error,
        durationMs: outcome.durationMs,
      },
      { burrowId: row.burrowId, actorId: row.requesterId },
    );
  }

  /** Name lookup for approval copy (notifications, decline messages). */
  async names(burrowId: string) {
    const rows = await loadPrincipalRows(this.services.db, burrowId);
    const byId = new Map(rows.map((r) => [r.id, nameInfo(r)]));
    return (id: string) => byId.get(id);
  }
}
