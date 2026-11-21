/**
 * After a coding turn ended (docs/decisions/run-checkout.md RC-08…RC-11), Whombat does what an agent could forget or never
 * learn about: what the runner could not do with the checkout goes on the run and in the conversation, pushed work gets
 * its pull request, a run the agent left live having asked a person what it needs to go on needs that person, in the
 * question's words (resourceful-agents.md RA-DS62), and one left live with nothing to wait on wakes the agent once,
 * then needs a person.
 * Best effort: a failure here is logged and changes nothing about the turn.
 */
import type { WorkspaceReport } from '@whombat/core';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { automationOwnsPullRequest } from '../automations/workspace';
import { openPr } from '../commands/agent-tools';
import { reportWorkspace, stallRun } from '../commands/run-recovery';
import { dispatches, pullRequests, repos, runSteps, runs } from '../db/schema/index';
import { onBehalfOf } from '../mcp/tools';
import type { Services } from '../services';

type RunRow = typeof runs.$inferSelect;
type DispatchRow = typeof dispatches.$inferSelect;

export async function afterRunTurn(
  services: Services,
  dispatchId: string,
  body: { workspace?: WorkspaceReport | undefined },
): Promise<void> {
  const db = services.db;
  const [row] = await db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  // Only a turn that ended for good: a failed one is retried (or fails its runs, RC-03), a cancelled one was stopped.
  if (row?.state !== 'done') return;
  const opts = { burrowId: row.burrowId, actorId: row.agentId };
  const report = body.workspace;
  if (report?.problems.length)
    await services.pipeline.commit(reportWorkspace, { dispatchId, problems: report.problems }, opts);
  const turnRuns = await db
    .select()
    .from(runs)
    .where(row.runId ? or(eq(runs.id, row.runId), eq(runs.dispatchId, row.id)) : eq(runs.dispatchId, row.id));
  if (report && report.pushedCommits > 0)
    for (const run of turnRuns) await openPullRequestFor(services, row, run);
  for (const run of turnRuns) {
    await services.pipeline.commit(
      stallRun,
      {
        runId: run.id,
        dispatchId,
        pushed: (report?.pushedCommits ?? 0) > 0,
      },
      opts,
    );
  }
}

/**
 * Pushed work on a run's feature branch without a pull request gets one (RC-08): the ordinary `open_pr` as the agent,
 * so its key decides (can: opened; ask: a person approves; no: nothing), titled after the run, its steps in the body.
 */
async function openPullRequestFor(services: Services, turn: DispatchRow, run: RunRow): Promise<void> {
  if (!run.repoId || run.prNumber || (run.status !== 'live' && run.status !== 'done')) return;
  const db = services.db;
  // Started in an automation's coding step whose pull request the automation opens after the review (run9 RN-S3c).
  if (run.dispatchId && (await automationOwnsPullRequest(db, run.dispatchId))) return;
  const [repo] = await db.select().from(repos).where(eq(repos.id, run.repoId));
  if (!repo?.enabled || repo.source === 'local' || run.branch === repo.defaultBranch) return;
  const [open] = await db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoId, repo.id),
        eq(pullRequests.branch, run.branch),
        eq(pullRequests.state, 'open'),
      ),
    );
  if (open) return;
  const steps = await db.select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(runSteps.idx);
  const body = [
    run.summary ?? '',
    `Run #${run.number}:`,
    ...steps.map((s) => `- ${s.state === 'done' ? '✓' : '·'} ${s.title}`),
  ]
    .filter(Boolean)
    .join('\n');
  const res = await services.pipeline.commit(
    openPr,
    {
      repo: repo.fullName,
      branch: run.branch,
      base: repo.defaultBranch,
      title: run.title,
      body,
      conversationId: run.conversationId,
    },
    { burrowId: run.burrowId, actorId: run.agentId, onBehalfOf: await onBehalfOf(services, turn) },
  );
  if (res.status !== 'ok')
    services.log.info(
      { runId: run.id, status: res.status },
      'did not open a pull request for the pushed run',
    );
}

/**
 * Live runs themselves are the durable recovery queue. A missed completion callback, approval wake or server restart
 * cannot hide one from the next sweep. Reconciliation rechecks dependencies inside the run's commit.
 */
export async function reconcileLiveRuns(services: Services): Promise<void> {
  const live = await services.db
    .select()
    .from(runs)
    .where(and(eq(runs.status, 'live'), isNull(runs.attention)));
  for (const run of live) {
    const [turn] = await services.db
      .select()
      .from(dispatches)
      .where(
        and(
          eq(dispatches.burrowId, run.burrowId),
          eq(dispatches.agentId, run.agentId),
          or(eq(dispatches.runId, run.id), run.dispatchId ? eq(dispatches.id, run.dispatchId) : undefined),
        ),
      )
      .orderBy(desc(dispatches.createdAt), desc(dispatches.id))
      .limit(1);
    if (!turn || !['done', 'failed', 'cancelled'].includes(turn.state)) continue;
    try {
      await services.pipeline.commit(
        stallRun,
        { runId: run.id, dispatchId: turn.id },
        {
          burrowId: run.burrowId,
          actorId: run.agentId,
        },
      );
    } catch (err) {
      services.log.warn({ err: String(err), runId: run.id }, 'could not reconcile unfinished run');
    }
  }
}
