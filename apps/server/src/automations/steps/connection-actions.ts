import { randomUUID } from 'node:crypto';
import type { JsonObject } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { callArgsAad } from '../../connections/call';
import { automationRuns } from '../../db/schema/index';
import { planConnectionActions } from '../proposed-actions';
import { approvedBranchRequest } from '../workspace';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import { block, skipStep, updateStep } from './state';
import type { StepExecution } from './types';

/**
 * Executes a `connection_actions` step: validates proposed actions from step `from`, ALWAYS asks the person on an
 * approval card first regardless of standing connection/key settings, and marks the step `running` only once that
 * approval card has been approved so `runExternal` executes the calls outside any DB transaction.
 */
export async function executeConnectionActions({
  ctx,
  run,
  steps,
  idx,
  attempt,
  scope,
  base,
  step,
}: StepExecution<'connection_actions'>): Promise<void> {
  const tx = ctx.tx;
  const previous = (steps[idx]?.output ?? {}) as JsonObject;
  const plan = await planConnectionActions(tx, ctx.services, run, steps, step);
  if (!plan.ok) {
    if (plan.fatal || step.otherwise === 'fail') return block(ctx, run, idx, plan.reason);
    return skipStep(ctx, run, idx, base, plan.reason, { ran: false, count: 0, reason: plan.reason });
  }
  if (plan.actions.length === 0) {
    return skipStep(ctx, run, idx, base, 'No actions were proposed.', { ran: false, count: 0 });
  }

  // Always ask the person on a card first, whatever standing settings on connections or keys say.
  const asked = typeof previous.actionsApprovalId === 'string' ? previous.actionsApprovalId : null;
  const approved = asked ? await approvedBranchRequest(tx, asked, run.id, step, attempt) : false;
  if (!approved || !asked) {
    const bulletLines = plan.actions.map((a) => `• ${a.label}: ${a.summary}`).join('\n');
    const approval = await requestStepApproval(
      ctx,
      run,
      step,
      attempt,
      scope,
      {
        name: CONTINUE_STEP,
        input: {
          runId: run.id,
          stepId: step.id,
          attempt,
          proposal: plan.proposal,
          actionsHash: plan.actionsHash,
        },
      },
      {
        ...plan.proposal,
        keyId: 'connections.write',
        cardText: `I need your yes before I run these actions:\n\n${bulletLines}`,
      },
    );
    await updateStep(
      tx,
      run.id,
      idx,
      {
        ...base,
        state: 'waiting',
        approvalId: approval.id,
        inputSummary: `Asked you to approve ${plan.actions.length} ${plan.actions.length === 1 ? 'action' : 'actions'}`,
        output: { actionsHash: plan.actionsHash, count: plan.actions.length },
      },
      ctx.now,
    );
    await tx
      .update(automationRuns)
      .set({ status: 'waiting', updatedAt: ctx.now })
      .where(eq(automationRuns.id, run.id));
    return;
  }

  // Approved on the card: seal each call's arguments and mark the step `running` so `runExternal` executes them.
  const prepared = plan.actions.map((a) => {
    const callId = randomUUID();
    return {
      callId,
      connectionId: a.connectionId,
      handle: a.handle,
      label: a.label,
      tool: a.tool,
      toolHash: a.toolHash,
      summary: a.summary,
      argsEnc: ctx.services.custody.seal(callArgsAad(callId), JSON.stringify(a.args)),
    };
  });
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'running',
      inputSummary: `Run ${prepared.length} approved ${prepared.length === 1 ? 'action' : 'actions'}`,
      output: {
        actionsApprovalId: asked,
        actionsHash: plan.actionsHash,
        actions: prepared,
      },
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'running', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
}
