import { blockedEventFields, keyLabel } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { automationRuns } from '../../db/schema/index';
import { keyDecision } from '../authority';
import { MERGE_WORDS, mergeOutputOf, mergePlan } from '../merge';
import { approvedBranchRequest } from '../workspace';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import { automationPrincipal } from './checks';
import { block, skipStep, updateStep } from './state';
import type { StepExecution } from './types';

export async function executeMergePullRequest({
  ctx,
  run,
  steps,
  idx,
  attempt,
  scope,
  publisher,
  base,
  step,
}: StepExecution<'merge_pull_request'>): Promise<void> {
  const tx = ctx.tx;
  // Merging a pull request once its checks pass (automation-recipes.md AR-45…AR-47).
  const previous = mergeOutputOf(steps[idx]?.output);
  const plan = await mergePlan(tx, run, step, scope);
  if (!plan.ok) {
    // No pull request was opened: nothing to merge, and the run goes on. The repo not switched on: `otherwise`.
    if (plan.nothing || step.otherwise === 'skip') return skipStep(ctx, run, idx, base, plan.reason);
    return block(ctx, run, idx, plan.reason);
  }
  const n = plan.number;
  const decision = await keyDecision(
    tx,
    (await automationPrincipal(tx, run)) ?? '',
    publisher,
    plan.keyId,
    plan.keyScope,
  );
  if (decision.outcome === 'deny') {
    const reason = MERGE_WORDS.mayNot(plan.base, plan.repo.fullName, keyLabel(plan.keyId));
    await ctx.emit({
      ...blockedEventFields(decision, ctx.actor.shortName, `merge PR #${n} into ${plan.base}`),
      where: plan.repo.fullName,
      payload: { runId: run.id, keyId: plan.keyId, reason: decision.reason },
    });
    if (step.otherwise === 'fail') return block(ctx, run, idx, reason);
    return skipStep(ctx, run, idx, base, reason);
  }
  const target = { repo: plan.repo.fullName, number: n, base: plan.base };
  let mergeApprovalId: string | null = null;
  if (decision.outcome === 'ask') {
    const asked = previous.mergeApprovalId ?? null;
    if (asked && (await approvedBranchRequest(tx, asked, run.id, step, attempt))) mergeApprovalId = asked;
    else {
      // A card in the run's thread; its yes lets it merge, still only once the checks pass.
      const approval = await requestStepApproval(
        ctx,
        run,
        step,
        attempt,
        scope,
        {
          name: CONTINUE_STEP,
          input: { runId: run.id, stepId: step.id, attempt, proposal: plan.proposal },
        },
        { ...plan.proposal, keyId: plan.keyId },
      );
      await updateStep(
        tx,
        run.id,
        idx,
        {
          ...base,
          state: 'waiting',
          approvalId: approval.id,
          prNumber: n,
          inputSummary: MERGE_WORDS.asked(n, plan.base, approval.number),
          output: target,
        },
        ctx.now,
      );
      await tx
        .update(automationRuns)
        .set({ status: 'waiting', updatedAt: ctx.now })
        .where(eq(automationRuns.id, run.id));
      return;
    }
  }
  // Allowed (or approved): it waits for the checks (AR-46). The engine looks each pass and, once they let it, marks
  // it running and merges in its own pass, outside any transaction (AR-47). `wakeAt` is when it gives up waiting
  // (the apps show “until” it); nothing wakes on it, the engine looks every pass.
  const givesUp = new Date(ctx.now.getTime() + step.waitMinutes * 60_000);
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'waiting',
      deadlineAt: givesUp,
      wakeAt: givesUp,
      prNumber: n,
      inputSummary: MERGE_WORDS.waiting(n),
      output: {
        ...target,
        waitingSince: ctx.now.toISOString(),
        ...(mergeApprovalId ? { mergeApprovalId } : {}),
      },
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'waiting', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
  return;
}
