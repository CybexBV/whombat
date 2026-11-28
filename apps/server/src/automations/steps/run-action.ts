import { randomUUID } from 'node:crypto';
import { type AutomationStep, directActionText, type JsonObject } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { callTarget } from '../../connections/call-target';
import type { Db, Tx } from '../../db/client';
import { automationRuns, automations } from '../../db/schema/index';
import { planDirectAction } from '../direct-action';
import type { AutomationRunRow } from '../store';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import { block, skipStep, updateStep } from './state';
import type { StepExecution } from './types';

type RunActionStep = Extract<AutomationStep, { kind: 'run_action' }>;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * What the approval card of a `run_action` step proposes: the action, and why it asks. The approval guard renders it
 * again before the yes runs, so what was approved is what runs.
 */
export async function runActionProposal(
  tx: Db | Tx,
  run: Pick<AutomationRunRow, 'automationId'>,
  step: RunActionStep,
): Promise<{ title: string; details: string }> {
  const what = directActionText(step);
  const [automation] = await tx
    .select({ name: automations.name })
    .from(automations)
    .where(eq(automations.id, run.automationId));
  const name = automation?.name ?? 'An automation';
  return {
    title: what,
    details: `“${name}” wants to ${lowerFirst(what)} now. Your settings say to ask you first.`,
  };
}

/**
 * Executes a `run_action` step (docs/decisions/direct-automations.md): checks it can run now, asks on the approval card
 * when the person's own rules ask for this call (a yes for this attempt only), and otherwise marks it `running` so
 * `runExternal` makes the call outside any transaction (`direct-action.ts`). Something that can't run skips the step
 * or stops the run, as `otherwise` says.
 */
export async function executeRunAction({
  ctx,
  run,
  steps,
  idx,
  attempt,
  scope,
  base,
  step,
}: StepExecution<'run_action'>): Promise<void> {
  const tx = ctx.tx;
  const previous = (steps[idx]?.output ?? {}) as JsonObject;
  const plan = await planDirectAction(tx, ctx.services, run.burrowId, step);
  if (!plan.ok) {
    if (plan.fatal || step.otherwise === 'fail') return block(ctx, run, idx, plan.reason);
    return skipStep(ctx, run, idx, base, plan.reason, {
      ran: false,
      text: plan.reason,
      summary: plan.reason,
    });
  }
  const what = directActionText(step);
  const yes =
    typeof previous.approvalId === 'string' && previous.approvalAttempt === attempt
      ? previous.approvalId
      : null;
  if (plan.asks && !yes) {
    const proposal = await runActionProposal(tx, run, step);
    const details = proposal.details;
    const approval = await requestStepApproval(
      ctx,
      run,
      step,
      attempt,
      scope,
      {
        name: CONTINUE_STEP,
        input: { runId: run.id, stepId: step.id, attempt, proposal },
      },
      {
        title: what,
        details,
        keyId: 'connections.write',
        question: `${what}?`,
        whatHappens: [`${what} now, on this Whombat, without AI.`, 'If you decline, it’s left as it is.'],
        summary: details,
      },
    );
    await updateStep(
      tx,
      run.id,
      idx,
      { ...base, state: 'waiting', approvalId: approval.id, inputSummary: `Asked you first: ${what}` },
      ctx.now,
    );
    await tx
      .update(automationRuns)
      .set({ status: 'waiting', updatedAt: ctx.now })
      .where(eq(automationRuns.id, run.id));
    return;
  }
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'running',
      inputSummary: what,
      output: {
        ...(yes ? { approvalId: yes, approvalAttempt: attempt } : {}),
        callId: randomUUID(),
        // Where the call goes and as whom now: nothing is sent should that change before it runs.
        target: callTarget(plan.conn),
      },
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'running', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
}
