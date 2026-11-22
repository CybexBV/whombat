/**
 * After the work is done (docs/decisions/automation-recipes.md AR-42): an automation's branch goes once the pull
 * request it opened from it — or used, AR-41 — is merged, on GitHub or here, as GitHub's own “Automatically delete head
 * branches” would. Only a branch of the repository itself (not a fork's), not its default branch, and still where the
 * pull request left it: a branch someone pushed to since stays. The pull request keeps its commits, and GitHub can
 * restore the branch from it. The outcome is kept on the step (`output.branchCleanup`), so each branch is looked at
 * once; a deleted one is signed by the automation (`automation.branch_deleted`).
 */
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { externalEffect } from '../commit/scope';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { automationRunSteps, automationRuns, automations, pullRequests, repos } from '../db/schema/index';
import { sameSha } from '../github/poll-plan';
import { githubRefused } from '../github/service';
import { notFound } from '../lib/errors';
import { githubScope } from '../managed/providers/github-adapter';
import type { Services } from '../services';
import { reportProduct } from '../trackers/connection';
import { fixOf } from '../trackers/fixes';
import { scopeReport } from '../trackers/items';
import { postInRunThread } from './steps';
import { withStepMessages } from './steps/state';
import { publishRun } from './store';

/** How long after a merge a branch is still cleaned up (older merges, e.g. from before AR-42, are left alone). */
export const BRANCH_CLEANUP_WINDOW_MS = 7 * 86_400_000;
/** At most this many branches a pass. */
const BRANCH_CLEANUP_BATCH = 20;
/** After GitHub couldn't be reached about a branch, it is tried again after this long. */
const BRANCH_CLEANUP_RETRY_MS = 10 * 60_000;

export const BRANCH_CLEANUP_OUTCOMES = ['deleted', 'gone', 'moved', 'kept', 'refused'] as const;
export type BranchCleanupOutcome = (typeof BRANCH_CLEANUP_OUTCOMES)[number];

/** `automation.branch_cleanup` (the automation): what became of the branch of a merged pull request it opened. */
export const recordBranchCleanup = defineCommand({
  name: 'automation.branch_cleanup',
  schema: z.object({
    runId: z.string(),
    idx: z.number().int().nonnegative(),
    repo: z.string(),
    branch: z.string(),
    prNumber: z.number().int().positive(),
    outcome: z.enum(BRANCH_CLEANUP_OUTCOMES),
    detail: z.string().max(500),
  }),
  async apply(tx, ctx, input) {
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, input.runId))
      .for('update');
    if (!run || run.burrowId !== ctx.burrow.id) throw notFound('Automation run');
    const [row] = await tx
      .select()
      .from(automationRunSteps)
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, input.idx)));
    if (!row) throw notFound('Automation step');
    const output = row.output as Record<string, unknown>;
    if (output.branchCleanup) return { status: 'unchanged' as const };
    // A fix for a tracker report is merged: one line says so, and who tells the customer (RN-S5) — unless Whombat
    // follows that fix (report-trackers.md TA-29), which says it itself, in TA-36's words when the automation replies.
    const report = scopeReport(run.scope);
    const said =
      report && !output.mergedNotice && !(await fixOf(tx, run.id, input.repo, input.prNumber))
        ? await postInRunThread(
            ctx,
            run,
            await mergedLine(
              tx,
              run.burrowId,
              input,
              report.number,
              await reportProduct(ctx.services, tx, report.connectionId, report.reportId),
            ),
          )
        : null;
    await tx
      .update(automationRunSteps)
      .set({
        output: {
          ...output,
          branchCleanup: {
            outcome: input.outcome,
            branch: input.branch,
            detail: input.detail,
            at: ctx.now.toISOString(),
          },
          ...(said ? { mergedNotice: true } : {}),
        },
        ...(said ? { messageIds: withStepMessages([said]) } : {}),
        updatedAt: ctx.now,
      })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, row.idx)));
    if (input.outcome === 'deleted')
      await ctx.emit({
        type: 'automation.branch_deleted',
        kind: 'System',
        text: `Deleted ${input.branch} in ${input.repo}: PR #${input.prNumber} was merged`.slice(0, 500),
        where: input.repo,
        payload: {
          runId: run.id,
          number: run.number,
          repo: input.repo,
          branch: input.branch,
          prNumber: input.prNumber,
        },
      });
    await publishRun(ctx, run.id);
    return { status: input.outcome };
  },
});

/**
 * “[PR #52](…) was merged. If the customer should hear, set Acme Desk #16 to “Fixed, waiting for a release” on the run
 * page.” (RN-S5)
 */
async function mergedLine(
  db: Db,
  burrowId: string,
  pr: { repo: string; prNumber: number },
  report: number,
  product: string,
): Promise<string> {
  const [row] = await db
    .select({ url: pullRequests.url })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.burrowId, burrowId),
        eq(repos.fullName, pr.repo),
        eq(pullRequests.number, pr.prNumber),
      ),
    );
  const link = row?.url ? `[PR #${pr.prNumber}](${row.url})` : `PR #${pr.prNumber}`;
  return `${link} was merged. If the customer should hear, set ${product} #${report} to “Fixed, waiting for a release” on the run page.`;
}

interface Candidate {
  runId: string;
  idx: number;
  burrowId: string;
  principalId: string;
  repo: string;
  source: string;
  enabled: boolean;
  defaultBranch: string;
  branch: string;
  prNumber: number;
  headSha: string;
}

/**
 * The automations' pull request steps whose pull request has merged in the window and whose branch nobody has looked
 * at yet. The step's repo is its definition's (the PR number is only unique within a repo).
 */
async function candidates(db: Db, now: Date): Promise<Candidate[]> {
  return db
    .select({
      runId: automationRuns.id,
      idx: automationRunSteps.idx,
      burrowId: automationRuns.burrowId,
      principalId: automations.principalId,
      repo: repos.fullName,
      source: repos.source,
      enabled: repos.enabled,
      defaultBranch: repos.defaultBranch,
      branch: pullRequests.branch,
      prNumber: pullRequests.number,
      headSha: pullRequests.headSha,
    })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .innerJoin(
      pullRequests,
      and(
        eq(pullRequests.burrowId, automationRuns.burrowId),
        eq(pullRequests.number, automationRunSteps.prNumber),
      ),
    )
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(automationRunSteps.kind, 'open_pull_request'),
        eq(automationRunSteps.state, 'succeeded'),
        isNotNull(automationRunSteps.prNumber),
        isNull(automations.deletedAt),
        eq(pullRequests.state, 'merged'),
        gt(pullRequests.mergedAt, new Date(now.getTime() - BRANCH_CLEANUP_WINDOW_MS)),
        sql`${automationRunSteps.output} -> 'branchCleanup' is null`,
        sql`lower(${repos.fullName}) = lower(${automationRuns.definition} -> 'steps' -> ${automationRunSteps.idx} ->> 'repo')`,
      ),
    )
    .limit(BRANCH_CLEANUP_BATCH);
}

/** Why a branch is left alone without asking GitHub (null: GitHub decides). */
function keptBecause(c: Candidate): string | null {
  // A fork's branch is `owner:ref` (AR-09): it isn't this repository's to delete.
  if (c.branch.includes(':')) return 'it is a fork’s branch';
  if (c.source !== 'github') return 'the repository is kept on this Whombat';
  if (c.branch === c.defaultBranch) return 'it is the default branch';
  if (!c.enabled) return 'the repository is switched off';
  return null;
}

/**
 * Deletes the branches of the automations' merged pull requests (AR-42). Network outside any transaction; each
 * outcome committed as the automation. `retryAt` holds back a branch GitHub couldn't be asked about (in memory: after a
 * restart it is simply tried again).
 */
export async function cleanUpMergedBranches(
  services: Services,
  now: Date,
  retryAt: Map<string, number>,
): Promise<number> {
  let done = 0;
  for (const c of await candidates(services.db, now)) {
    const key = `${c.runId}:${c.idx}`;
    if ((retryAt.get(key) ?? 0) > now.getTime()) continue;
    const record = (outcome: BranchCleanupOutcome, detail: string) =>
      services.pipeline.commit(
        recordBranchCleanup,
        { runId: c.runId, idx: c.idx, repo: c.repo, branch: c.branch, prNumber: c.prNumber, outcome, detail },
        { burrowId: c.burrowId, actorId: c.principalId },
      );
    // A record that can't be saved waits like a GitHub failure, and the pass goes on with the next branch.
    const recordFailed = (err: unknown) => {
      retryAt.set(key, now.getTime() + BRANCH_CLEANUP_RETRY_MS);
      services.log.warn(
        { err: err instanceof Error ? err.message : String(err), runId: c.runId, branch: c.branch },
        'automations: saving a branch cleanup failed',
      );
    };
    const kept = keptBecause(c);
    if (kept) {
      try {
        await record('kept', `Kept ${c.branch}: ${kept}.`);
        retryAt.delete(key);
        done++;
      } catch (err) {
        recordFailed(err);
      }
      continue;
    }
    const adapter = services.github.adapter;
    if (!adapter) continue;
    try {
      const outcome = await githubScope.run({ burrowId: c.burrowId }, async () => {
        const read = await adapter.branchHead(c.repo, c.branch, null);
        // Asked without an ETag, GitHub always answers in full.
        const head = read.modified ? read.data : null;
        if (head === null) return { outcome: 'gone' as const, detail: `${c.branch} was already deleted.` };
        if (!sameSha(head, c.headSha))
          return {
            outcome: 'moved' as const,
            detail: `Kept ${c.branch}: it has commits that came after PR #${c.prNumber}.`,
          };
        const deleted = await externalEffect(
          'github.branch_delete',
          () => adapter.deleteBranch(c.repo, c.branch),
          {
            refused: githubRefused,
          },
        );
        return deleted === 'deleted'
          ? { outcome: 'deleted' as const, detail: `Deleted ${c.branch}: PR #${c.prNumber} was merged.` }
          : { outcome: 'gone' as const, detail: `${c.branch} was already deleted.` };
      });
      await record(outcome.outcome, outcome.detail);
      retryAt.delete(key);
      done++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (githubRefused(err)) {
        try {
          await record('refused', `GitHub kept ${c.branch}: ${message}`.slice(0, 500));
          retryAt.delete(key);
          done++;
        } catch (recordErr) {
          recordFailed(recordErr);
        }
      } else {
        retryAt.set(key, now.getTime() + BRANCH_CLEANUP_RETRY_MS);
        services.log.warn(
          { err: message, runId: c.runId, branch: c.branch },
          'automations: branch cleanup failed',
        );
      }
    }
  }
  return done;
}
