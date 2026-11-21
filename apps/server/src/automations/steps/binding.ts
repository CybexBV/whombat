import { type ActionBinding, type AutomationStep, renderTemplate } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client';
import { githubBranchHeads, pullRequests, repos } from '../../db/schema/index';
import { mergePlan } from '../merge';
import type { AutomationRunRow } from '../store';

/** The head commit of a branch as Whombat last saw it (an open PR's head, else the poller's branch head). */
export async function branchHead(
  tx: Db,
  burrowId: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const [pr] = await tx
    .select({ sha: pullRequests.headSha })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.burrowId, burrowId),
        eq(repos.fullName, repo),
        eq(pullRequests.branch, branch),
        eq(pullRequests.state, 'open'),
      ),
    );
  if (pr) return pr.sha;
  const [head] = await tx
    .select({ sha: githubBranchHeads.sha })
    .from(githubBranchHeads)
    .where(
      and(
        eq(githubBranchHeads.burrowId, burrowId),
        eq(githubBranchHeads.repo, repo),
        eq(githubBranchHeads.branch, branch),
      ),
    );
  return head?.sha ?? null;
}

/** The binding an automation approval is hashed with (the commit is read live). */
export async function stepBinding(
  tx: Tx,
  run: AutomationRunRow,
  step: AutomationStep,
  attempt: number,
  scope: Record<string, unknown>,
): Promise<ActionBinding> {
  let commitSha: string | null = null;
  if (step.kind === 'request_approval' && step.bindBranch)
    commitSha = await branchHead(
      tx,
      run.burrowId,
      step.bindBranch.repo,
      renderTemplate(step.bindBranch.branch, scope, 255),
    );
  if (step.kind === 'open_pull_request')
    commitSha = await branchHead(tx, run.burrowId, step.repo, renderTemplate(step.branch, scope, 255));
  // A merge's yes is for the pull request as it is now (AR-45): a new commit asks again.
  if (step.kind === 'merge_pull_request') {
    const plan = await mergePlan(tx, run, step, scope);
    commitSha = plan.ok ? plan.headSha : null;
  }
  return {
    automationId: run.automationId,
    version: run.version,
    runId: run.id,
    stepId: `${step.id}#${attempt}`,
    commitSha,
  };
}
