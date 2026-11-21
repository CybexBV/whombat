/**
 * Runs as agents drive them through the MCP tools: `start_run`, `run_step`, `run_log`, `run_tests`,
 * `run_files` and `finish_run`. Only the run's own agent writes to it, and only while it is live — a paused
 * or taken-over run refuses writes, so nothing lands after a person pressed Pause or Take over even before
 * the runner has stopped the turn (runtime-server.md).
 *
 * Realtime: every change publishes `run.updated` (run page, run card, sidebar) and log lines `run.log`.
 * Signed events: "Started a run to …" and "Ran the … suite. 41 of 41 passed." are shown in the log; steps,
 * log lines, files and a normal finish are hidden internals (`text: null`).
 */
import {
  branchWriteKey,
  conversationLabel,
  DispatchId,
  formatOf,
  type KeyId,
  MCP_TOOLS,
  newId,
  type RunStatus,
  topics,
} from '@whombat/core';
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import {
  dispatches,
  messages,
  pullRequests,
  repos,
  runFiles,
  runLog,
  runSteps,
  runs,
  searchAnswers,
} from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { postMessage } from '../domain/messages';
import { indexRun } from '../domain/search-index';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import { loadRun, runByNumber } from '../read/work';
import { publishDispatch } from '../runtime/activity';
import { completionEvidence } from '../runtime/completion-evidence';
import { grantedApprovalOf, turnWorkspace } from '../runtime/context';
import { turnThread } from '../runtime/dispatch-scope';
import type { Services } from '../services';
import { linkRunToStep } from './plans';
import { publishRun } from './runs';

type RunRow = typeof runs.$inferSelect;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The actor's own run, still live. Paused, taken-over and finished runs refuse agent writes. */
export async function ownLiveRun(ctx: ApplyContext, number: number): Promise<RunRow> {
  const row = await runByNumber(ctx.tx, ctx.burrow.id, number);
  if (!row) throw notFound(`Run #${number}`);
  if (ctx.actor.kind !== 'agent' || row.agentId !== ctx.actor.id)
    throw forbidden(`Run #${number} is not yours. Agents only update their own runs.`);
  if (row.status === 'paused')
    throw new ApiError('conflict', `Run #${number} is paused. Wait until a person resumes it.`);
  if (row.status === 'taken_over') {
    const person = row.takenOverById ? await loadPrincipalRow(ctx.tx, row.takenOverById) : undefined;
    throw new ApiError(
      'conflict',
      `${person?.shortName ?? person?.name ?? 'A person'} took over run #${number}. Stop working on ${row.branch}.`,
    );
  }
  if (row.status !== 'live') throw new ApiError('conflict', `Run #${number} has finished.`);
  return row;
}

/** Progress from steps: done steps count fully, the active one half. Never goes backwards while live. */
export function stepsProgress(states: readonly string[]): number {
  if (states.length === 0) return 0;
  const done = states.filter((s) => s === 'done').length;
  const active = states.filter((s) => s === 'active').length;
  return Math.round((100 * (done + 0.5 * active)) / states.length);
}

async function loadSteps(ctx: ApplyContext, runId: string) {
  return ctx.tx.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.idx));
}

async function touch(ctx: ApplyContext, runId: string, set: Partial<typeof runs.$inferInsert>) {
  // The agent moved the run: it needs no person for that any more (RC-11).
  await ctx.tx
    .update(runs)
    .set({ ...set, attention: null, updatedAt: ctx.now })
    .where(eq(runs.id, runId));
}

function addKey(row: RunRow, keyId: KeyId | undefined): string[] {
  if (!keyId || row.keysUsed.includes(keyId)) return row.keysUsed;
  return [...row.keysUsed, keyId];
}

/**
 * Who a dispatch works for: the person (or agent) whose message triggered it, the asker of the run it
 * controls, or whoever asked the search it answers. Null when nobody did (a scheduled turn).
 */
async function dispatchAsker(ctx: ApplyContext, dispatchId: string): Promise<string | null> {
  const [d] = await ctx.tx.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!d || d.burrowId !== ctx.burrow.id || d.agentId !== ctx.actor.id) throw badRequest('Unknown dispatch.');
  if (d.search) {
    const [answer] = await ctx.tx
      .select({ askedById: searchAnswers.askedById })
      .from(searchAnswers)
      .where(eq(searchAnswers.id, d.search.answerId));
    return answer?.askedById ?? null;
  }
  if (d.runId) {
    const [run] = await ctx.tx.select({ askedById: runs.askedById }).from(runs).where(eq(runs.id, d.runId));
    return run?.askedById ?? null;
  }
  if (!d.messageId) return null;
  const [message] = await ctx.tx
    .select({ authorId: messages.authorId })
    .from(messages)
    .where(eq(messages.id, d.messageId));
  return message?.authorId ?? null;
}

/* start_run -------------------------------------------------------------------------------------- */

/**
 * The branch a run works on (docs/decisions/agent-efficiency.md AE-05): with `prNumber` naming an open pull request of
 * the repository, that pull request's branch, whatever `branch` says — its checkout already holds the work and what
 * was installed for it. A closed or unknown pull request leaves `branch` as asked.
 */
export async function runBranch(
  db: Db,
  repoId: string | null | undefined,
  input: { branch: string; prNumber?: number | undefined },
): Promise<string> {
  if (!repoId || !input.prNumber) return input.branch;
  const [pr] = await db
    .select({ branch: pullRequests.branch })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.number, input.prNumber),
        eq(pullRequests.state, 'open'),
      ),
    );
  return pr?.branch ?? input.branch;
}

/** `runBranch` for a repository by its full name in the burrow. */
export async function runBranchIn(
  db: Db,
  burrowId: string,
  input: { repo: string; branch: string; prNumber?: number | undefined },
): Promise<string> {
  if (!input.prNumber) return input.branch;
  const [repo] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, input.repo)));
  return runBranch(db, repo?.id, input);
}

export const startRun = defineCommand({
  name: 'start_run',
  // A new run is a new agent turn (LC-10).
  licence: 'agentTurn',
  /** `dispatchId` is set by the MCP adapter: the dispatch whose turn started the run (pause / take over). */
  schema: MCP_TOOLS.start_run.input.extend({ dispatchId: DispatchId.optional() }),
  async requiredKey(input, { db, burrow }) {
    const [repo] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, burrow.id), eq(repos.fullName, input.repo)));
    // The key for the branch the run will use: an open pull request's own (AE-05).
    const branch = await runBranch(db, repo?.id, input);
    return {
      keyId: branchWriteKey(branch, repo?.defaultBranch ?? 'main'),
      scope: { branch, repo: input.repo },
      attempt: `start a run on ${branch}`,
      where: `${input.repo} · ${branch}`,
      conversationId: input.conversationId,
    };
  },
  async apply(tx, ctx, input) {
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const [repo] = await tx
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, ctx.burrow.id), eq(repos.fullName, input.repo)));
    if (!repo) throw notFound(`Repo ${input.repo}`);
    if (!repo.enabled) throw new ApiError('conflict', `${repo.fullName} is not switched on for agents.`);
    // A run on an open pull request works on its branch (AE-05), as its key was asked for.
    const branch = await runBranch(tx, repo.id, input);
    let prNumber = input.prNumber ?? null;
    if (!prNumber) {
      const [open] = await tx
        .select({ number: pullRequests.number })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repoId, repo.id),
            eq(pullRequests.branch, branch),
            eq(pullRequests.state, 'open'),
          ),
        );
      prNumber = open?.number ?? null;
    }
    // Who asked is the dispatch's to say (ON BEHALF OF, live activities), never the agent's.
    const askedById = input.dispatchId ? await dispatchAsker(ctx, input.dispatchId) : null;
    const [{ next } = { next: 1 }] = await tx
      .select({ next: sql<number>`coalesce(max(${runs.number}), 0)::int + 1` })
      .from(runs)
      .where(eq(runs.burrowId, ctx.burrow.id));
    const id = newId('run');
    const states = input.steps.map((_, i) => (i === 0 ? 'active' : 'queued'));
    await tx.insert(runs).values({
      id,
      burrowId: ctx.burrow.id,
      number: next,
      agentId: ctx.actor.id,
      title: input.title,
      branch,
      repoId: repo.id,
      prNumber,
      status: 'live',
      askedById: askedById ?? ctx.actor.id,
      conversationId: conversation.id,
      dispatchId: input.dispatchId ?? null,
      startedAt: ctx.now,
      progress: stepsProgress(states),
      activity: input.steps[0]?.title ?? input.title,
      keysUsed: ctx.decision ? [ctx.decision.keyId] : [],
      updatedAt: ctx.now,
    });
    await tx.insert(runSteps).values(
      input.steps.map((s, idx) => ({
        runId: id,
        idx,
        title: s.title,
        detail: s.detail,
        at: idx === 0 ? ctx.now : null,
        state: idx === 0 ? ('active' as const) : ('queued' as const),
      })),
    );
    // In the thread the agent was asked in, like its replies (run-checkout.md RC-14).
    const threadRootId = await turnThread(tx, {
      agentId: ctx.actor.id,
      conversationId: conversation.id,
      dispatchId: input.dispatchId ?? null,
    });
    const posted = await postMessage(ctx, {
      conversation,
      threadRootId,
      text: input.title,
      card: { kind: 'run', runId: id },
      dispatch: false,
    });
    await tx.update(runs).set({ messageId: posted.id }).where(eq(runs.id, id));
    // The plan step this run carries out (WS-03): the one named, else the step its turn was handed.
    await linkRunToStep(ctx, id, input.planStep ?? null, input.dispatchId ?? null);
    const event = await ctx.emit({
      type: 'run.started',
      kind: 'Code',
      text: `Started a run to ${lowerFirst(input.title)}`,
      where: `Run #${next}`,
      ref: { type: 'run', number: next },
      payload: {
        runId: id,
        branch,
        repo: repo.fullName,
        conversation: conversationLabel(conversation),
      },
    });
    await publishRun(ctx, id, event.id);
    const services = ctx.services;
    ctx.after(() => indexRun(services.db, id));
    ctx.after(() => services.approvals.reevaluate(ctx.burrow.id));
    // A run a person approved (the agent's key asked): the turn that asked has ended, so the agent is woken to
    // work on it, in run mode with its workspace — like Resume (docs/decisions/bp-automations.md BP-C29).
    const dispatchId = input.dispatchId;
    if (!ctx.approvalId && dispatchId) {
      // A run started in a turn without a checkout of its branch (a mention, a handoff, a DM) goes on in a run turn
      // that has one (docs/decisions/run-checkout.md RC-01).
      const at = ctx.now;
      const target = { runId: id, repo: repo.fullName, branch, messageId: posted.id };
      ctx.after(() => continueInCheckout(services, dispatchId, target, at));
    } else if (ctx.approvalId) {
      const burrowId = ctx.burrow.id;
      const agentId = ctx.actor.id;
      const at = ctx.now;
      ctx.after(async () => {
        await enqueueDispatches(services, {
          burrowId,
          causedById: agentId,
          conversationId: conversation.id,
          messageId: posted.id,
          // Where the card went: the asking turn's thread (VA-02).
          threadRootId,
          requests: [{ agentId, trigger: 'run_control', mode: 'run' }],
          at,
          runId: id,
        });
      });
    }
    return { runId: id, number: next, messageId: posted.id, branch };
  },
});

/**
 * Wakes the agent in run mode when the turn that started the run has no checkout of the run's repo and branch: its
 * run turn gets one (`turnWorkspace`), in the agent's working directory when it has one. The run turn answers where
 * the starting turn was asked (its message and thread), so a Feedback handoff's report and assessment go with it.
 */
async function continueInCheckout(
  services: Services,
  dispatchId: string,
  target: { runId: string; repo: string; branch: string; messageId: string },
  at: Date,
): Promise<void> {
  const db = services.db;
  const [row] = await db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  // A Feedback assessment only reads (FB-21): it never goes on to write.
  if (!row || row.trigger === 'feedback') return;
  const conversation = await loadConversationRow(db, row.conversationId);
  if (!conversation) return;
  const run = row.runId ? ((await loadRun(db, row.runId)) ?? null) : null;
  const grantedApproval = await grantedApprovalOf(db, row);
  const workspace = await turnWorkspace(db, row, { conversation, run, grantedApproval, cloneUrl: (n) => n });
  if (workspace?.repo === target.repo && workspace.branch === target.branch) return;
  // A run that has a turn already (queued, or woken by someone else meanwhile) needs no other.
  const [turn] = await db
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(eq(dispatches.runId, target.runId))
    .limit(1);
  if (turn) return;
  await enqueueDispatches(services, {
    burrowId: row.burrowId,
    causedById: row.agentId,
    conversationId: row.conversationId,
    messageId: row.messageId ?? target.messageId,
    // The starting turn's thread even without a message of its own (a woken `vault_pass` turn, VA-02).
    threadRootId: row.threadRootId,
    requests: [{ agentId: row.agentId, trigger: 'run_control', mode: 'run' }],
    at,
    runId: target.runId,
    onBehalfOfAccountId: row.onBehalfOfAccountId,
  });
}

/* run_step --------------------------------------------------------------------------------------- */

export const runStep = defineCommand({
  name: 'run_step',
  schema: MCP_TOOLS.run_step.input,
  async apply(tx, ctx, input) {
    const row = await ownLiveRun(ctx, input.run);
    const steps = await loadSteps(ctx, row.id);
    const step = steps[input.step];
    if (!step)
      throw badRequest(`Run #${row.number} has ${steps.length} steps (0–${Math.max(0, steps.length - 1)}).`);
    await tx
      .update(runSteps)
      .set({
        state: input.state,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(step.at === null && input.state !== 'failed' ? { at: ctx.now } : {}),
      })
      .where(and(eq(runSteps.runId, row.id), eq(runSteps.idx, input.step)));
    const states = steps.map((s, i) => (i === input.step ? input.state : s.state));
    const progress = Math.max(row.progress, stepsProgress(states));
    await touch(ctx, row.id, {
      progress,
      ...(input.state === 'active' ? { activity: step.title } : {}),
    });
    const event = await ctx.emit({
      type: 'run.step',
      kind: 'Code',
      text: null,
      where: `Run #${row.number}`,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id, step: input.step, state: input.state },
    });
    await publishRun(ctx, row.id, event.id);
    return { progress };
  },
});

/* run_log ---------------------------------------------------------------------------------------- */

export const runLogLines = defineCommand({
  name: 'run_log',
  schema: MCP_TOOLS.run_log.input,
  async apply(tx, ctx, input) {
    const row = await ownLiveRun(ctx, input.run);
    const lines = input.lines.map((text, i) => ({ seq: row.logCount + i, at: ctx.now, text }));
    await tx.insert(runLog).values(lines.map((l) => ({ runId: row.id, ...l })));
    const logCount = row.logCount + lines.length;
    const last = lines[lines.length - 1]?.text ?? row.activity;
    await touch(ctx, row.id, { logCount, activity: last.slice(0, 280) });
    const event = await ctx.emit({
      type: 'run.log',
      kind: 'Code',
      text: null,
      where: `Run #${row.number}`,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id, from: row.logCount, count: lines.length },
    });
    ctx.publish(
      topics.run(row.id),
      {
        type: 'run.log',
        runId: row.id,
        runNumber: row.number,
        lines: lines.map((l) => ({ seq: l.seq, at: ctx.at, text: l.text })),
      },
      { eventId: event.id },
    );
    await publishRun(ctx, row.id, event.id);
    return { logCount };
  },
});

/* run_tests -------------------------------------------------------------------------------------- */

/** "Run the billing test suite" (active step) → "Ran the billing test suite". */
export function ranPhrase(stepTitle: string | undefined): string {
  if (stepTitle && /^run\s/i.test(stepTitle)) return `Ran ${stepTitle.replace(/^run\s+/i, '')}`;
  return 'Ran the tests';
}

export const runTests = defineCommand({
  name: 'run_tests',
  schema: MCP_TOOLS.run_tests.input,
  requiredKey: (input) => ({
    keyId: 'tests.run',
    attempt: `run the tests for run #${input.run}`,
    where: `Run #${input.run}`,
    ref: { type: 'run', number: input.run },
  }),
  async apply(_tx, ctx, input) {
    if (input.passed > input.total) throw badRequest('More tests passed than ran.');
    const row = await ownLiveRun(ctx, input.run);
    const steps = await loadSteps(ctx, row.id);
    const active = steps.find((s) => s.state === 'active');
    const failing =
      input.passed < input.total && input.failingIn
        ? ` ${input.total - input.passed} failing in ${input.failingIn}.`
        : '';
    await touch(ctx, row.id, {
      tests: { passed: input.passed, total: input.total },
      keysUsed: addKey(row, ctx.decision?.keyId),
    });
    const event = await ctx.emit({
      type: 'run.tests',
      kind: 'Code',
      text: `${ranPhrase(active?.title)}. ${formatOf(input.passed, input.total)} passed.${failing}`,
      where: `Run #${row.number}`,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id, passed: input.passed, total: input.total },
    });
    await publishRun(ctx, row.id, event.id);
    const services = ctx.services;
    ctx.after(() => services.approvals.reevaluate(ctx.burrow.id));
    return {};
  },
});

/* run_files -------------------------------------------------------------------------------------- */

export const runFilesTouched = defineCommand({
  name: 'run_files',
  schema: MCP_TOOLS.run_files.input,
  async apply(tx, ctx, input) {
    const row = await ownLiveRun(ctx, input.run);
    const byPath = new Map(input.files.map((f) => [f.path, f]));
    const files = [...byPath.values()];
    await tx.delete(runFiles).where(eq(runFiles.runId, row.id));
    if (files.length)
      await tx
        .insert(runFiles)
        .values(
          files.map((f, position) => ({ runId: row.id, path: f.path, add: f.add, del: f.del, position })),
        );
    const diff = {
      add: files.reduce((n, f) => n + f.add, 0),
      del: files.reduce((n, f) => n + f.del, 0),
      files: files.length,
    };
    await touch(ctx, row.id, { diff });
    const event = await ctx.emit({
      type: 'run.files',
      kind: 'Code',
      text: null,
      where: `Run #${row.number}`,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id, ...diff },
    });
    await publishRun(ctx, row.id, event.id);
    return { diff };
  },
});

/* finish_run ------------------------------------------------------------------------------------- */

async function finish(
  ctx: ApplyContext,
  row: RunRow,
  outcome: 'done' | 'failed',
  summary: string,
): Promise<RunStatus> {
  const steps = await loadSteps(ctx, row.id);
  if (outcome === 'done' && steps.some((s) => s.state !== 'done'))
    throw conflict(
      'The run still has unfinished steps. Complete and check each step before finishing, or report why the run failed.',
    );
  const evidence = await completionEvidence(ctx.tx, {
    burrowId: row.burrowId,
    agentId: row.agentId,
    runId: row.id,
  });
  for (const s of steps) {
    const next = outcome === 'failed' && s.state === 'active' ? 'failed' : null;
    if (!next) continue;
    await ctx.tx
      .update(runSteps)
      .set({ state: next })
      .where(and(eq(runSteps.runId, row.id), eq(runSteps.idx, s.idx)));
  }
  await touch(ctx, row.id, {
    status: outcome,
    finishedAt: ctx.now,
    progress: outcome === 'done' ? 100 : row.progress,
    summary: summary.slice(0, 280),
    activity: summary.slice(0, 280),
  });
  const event = await ctx.emit({
    type: 'run.finished',
    kind: 'Code',
    text: outcome === 'done' ? null : `Stopped run #${row.number}: ${summary}`.slice(0, 500),
    where: `Run #${row.number}`,
    ref: { type: 'run', number: row.number },
    payload: {
      runId: row.id,
      outcome,
      evidenceIds: evidence.map((e) => e.id),
      verification: evidence.length ? 'observed_activity' : 'agent_report_only',
    },
  });
  await publishRun(ctx, row.id, event.id);
  // A run turn still queued for it (RC-01: the one its starting turn woke) has nothing left to do.
  const dropped = await ctx.tx
    .update(dispatches)
    .set({ state: 'cancelled', cancelReason: 'cancelled', finishedAt: ctx.now })
    .where(and(eq(dispatches.runId, row.id), eq(dispatches.state, 'queued')))
    .returning();
  for (const d of dropped) publishDispatch(ctx, d);
  const services = ctx.services;
  const burrowId = ctx.burrow.id;
  ctx.after(() => indexRun(services.db, row.id));
  ctx.after(() => services.approvals.reevaluate(burrowId));
  return outcome;
}

export const finishRun = defineCommand({
  name: 'finish_run',
  /** `dispatchId` is set by the MCP adapter: the dispatch whose turn finishes the run (HRS-06). */
  schema: MCP_TOOLS.finish_run.input.extend({ dispatchId: DispatchId.optional() }),
  async apply(_tx, ctx, input) {
    const row = await ownLiveRun(ctx, input.run);
    const status = await finish(ctx, row, input.outcome, input.summary);
    // A run turn already claimed beside the starting turn that now finishes the run itself (health-run-start.md HRS-01,
    // HRS-06) is told to stop at its next beat; never this turn, which goes on to answer.
    if (input.dispatchId) {
      const stopped = await ctx.tx
        .update(dispatches)
        .set({ cancelReason: 'cancelled' })
        .where(
          and(
            eq(dispatches.runId, row.id),
            inArray(dispatches.state, ['claimed', 'running']),
            ne(dispatches.id, input.dispatchId),
          ),
        )
        .returning();
      for (const d of stopped) publishDispatch(ctx, d);
    }
    const evidence = await completionEvidence(ctx.tx, {
      burrowId: row.burrowId,
      agentId: row.agentId,
      runId: row.id,
    });
    return { status, evidenceIds: evidence.map((e) => e.id) };
  },
});

/**
 * Internal (runtime): a dispatch failed for good; its live runs stop as failed so they do not look live
 * forever — the runs it started and the run it was a turn of (RC-01). Signed by the agent whose turn crashed.
 */
export const failDispatchRuns = defineCommand({
  name: 'runtime.fail_dispatch_runs',
  schema: z.object({ dispatchId: DispatchId, reason: z.string().min(1).max(280) }),
  async apply(tx, ctx, input) {
    const [turn] = await tx
      .select({ runId: dispatches.runId })
      .from(dispatches)
      .where(eq(dispatches.id, input.dispatchId));
    const rows = await tx
      .select()
      .from(runs)
      .where(
        and(
          turn?.runId
            ? or(eq(runs.dispatchId, input.dispatchId), eq(runs.id, turn.runId))
            : eq(runs.dispatchId, input.dispatchId),
          eq(runs.agentId, ctx.actor.id),
          eq(runs.status, 'live'),
        ),
      );
    for (const row of rows) await finish(ctx, row, 'failed', input.reason);
    return { runs: rows.length };
  },
});
