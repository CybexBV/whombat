/**
 * What each approval action does once a person said yes, and what Whombat refuses to ask for because it can't do it
 * (docs/decisions/essentials-agents.md EA-02, EA-03). No production path signs success for something Whombat didn't
 * do: an action type without an executor here is refused up front (`request_approval`, `perform_action`) and an old
 * approval of that type that gets approved fails honestly (“… so nothing happened”).
 *
 * | action               | executor                                                                           |
 * |----------------------|------------------------------------------------------------------------------------|
 * | `merge_pr`           | merges (GitHub, or a local origin) as the person who approved (`merge_pr`, rules kept) |
 * | `custom`             | the yes itself: a person agrees the agent may do it; “{Person} approved: {title}”  |
 * | `push_shared_branch` | allows that agent's next push of that branch (approvals/push.ts)                   |
 * | `deploy`             | the GitHub Actions deploy workflow, only when one is configured (github/deploy.ts) |
 * | `grant_key`, `vault_use`, connector actions | their own executors (grant-key.ts, vault/passes.ts, connectors) |
 * | `refund`, `message_external`, `deploy` without a workflow | none: refused up front                        |
 */
import type { ApprovalAction, ApprovalActionType } from '@whombat/core';
import { mergePr } from '../commands/prs';
import { badRequest } from '../lib/errors';
import type { ApprovalEngine, Executor } from './engine';
import { pushExecutor } from './push';
import { notPerformable, unavailableAction } from './unavailable';
import { wakeRequester } from './wake';

/** The request that asks is refused before anything is asked or done (bad request: the agent reads why). */
export async function refuseUnavailable(
  action: ApprovalAction,
  engine: ApprovalEngine,
  opts: { perform?: boolean } = {},
): Promise<void> {
  const problem = (opts.perform ? notPerformable(action) : null) ?? unavailableAction(action, engine);
  if (problem) throw badRequest(problem);
}

/**
 * An agent's merge at Ask (its Merge row, docs/decisions/runs-approvals.md MDS-03, MDS-D02): the approved request merges
 * as the person who approved it — through GitHub for a connected repo, in the origin for a repository kept on this
 * Whombat — with every rule of `merge_pr` (checks green, a review approving). An agent holding Merge On merges itself.
 */
const mergeExecutor: Executor = async (approval, services) => {
  if (approval.action.type !== 'merge_pr') throw new Error('Not a merge_pr approval.');
  if (!approval.decidedById) return { ok: false, error: 'Nobody approved this.' };
  const p = approval.action.params;
  const res = await services.pipeline.commit(
    mergePr,
    { number: p.prNumber, ...(p.repo ? { repo: p.repo } : {}), method: p.method ?? 'squash' },
    { burrowId: approval.burrowId, actorId: approval.decidedById },
  );
  if (res.status !== 'ok') return { ok: false, error: res.message };
  await wakeRequester(services, approval);
  // The person's “Merged PR #… into …” is the log's line; the agent signs no second one.
  return { ok: true, resultUrl: null, logged: true };
};

/** A `custom` yes is the outcome: a person agrees the agent may do this itself, and it is woken to go on (EA-07). */
const customExecutor: Executor = async (approval, services) => {
  await wakeRequester(services, approval);
  return { ok: true, resultUrl: null };
};

/** The executors every Whombat has (deploys, connectors, keys and the Vault register their own). */
export function registerApprovalExecutors(engine: ApprovalEngine): void {
  const builtIn: Partial<Record<ApprovalActionType, Executor>> = {
    merge_pr: mergeExecutor,
    custom: customExecutor,
    push_shared_branch: pushExecutor((approval, services) => wakeRequester(services, approval)),
  };
  for (const [type, executor] of Object.entries(builtIn) as [ApprovalActionType, Executor][])
    engine.setExecutor(type, executor);
}
