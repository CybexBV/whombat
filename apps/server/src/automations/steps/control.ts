import {
  evaluateCondition,
  type JsonObject,
  recipeConditionStory,
  recipeOf,
  renderTemplate,
} from '@whombat/core';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { automationRunSteps, automationRuns } from '../../db/schema/index';
import { loadAgentRow } from '../../read/principals';
import { followUpHold } from '../../trackers/reply';
import { type AutomationRunRow, stepSummary } from '../store';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import type { GateFacts } from './scope';
import { updateStep } from './state';
import type { StepExecution } from './types';
import { ownQuestion } from './words';

export async function executeCondition({
  ctx,
  run,
  idx,
  scope,
  base,
  step,
  facts,
}: StepExecution<'condition'> & { facts?: GateFacts }): Promise<void> {
  const tx = ctx.tx;
  // What GitHub says now about who opened the issue, who is assigned and which pull requests link it (AR-28).
  const { unreadable, ...fresh } = facts ?? {};
  const read = facts ? { ...scope, trigger: { ...(scope.trigger as JsonObject), ...fresh } } : scope;
  let result: boolean;
  try {
    result = evaluateCondition(step.if, read);
  } catch (err) {
    await updateStep(
      tx,
      run.id,
      idx,
      {
        ...base,
        state: 'failed',
        finishedAt: ctx.now,
        error: err instanceof Error ? err.message : String(err),
      },
      ctx.now,
    );
    return;
  }
  // A customer's answer on a report whose fix is under way, or live with nothing new to change, doesn't fix it again
  // (report-trackers.md TA-70): the run stops after its reply, whatever the recipe's words say.
  const held = result && step.id === 'worth_fixing' ? await followUpHold(tx, run, read) : null;
  if (held) result = false;
  // A recipe's check also says what it decided in plain words (AR-38), from exactly what it read.
  const story = held ?? (await conditionStory(tx, run, step.id, result, read));
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'succeeded',
      finishedAt: ctx.now,
      // The rule itself, cut to what the run page carries (a 0.71 “Fix it when sure” check is longer, AR-D03).
      inputSummary: stepSummary(unreadable ? `${step.if} · ${unreadable}` : step.if),
      output: {
        result,
        ...(facts ? { checked: { ...fresh, ...(unreadable ? { unreadable } : {}) } } : {}),
        ...(story ? { story } : {}),
      },
    },
    ctx.now,
  );
  if (!result) {
    if (step.else === 'stop') {
      await tx
        .update(automationRunSteps)
        .set({ state: 'skipped', finishedAt: ctx.now, updatedAt: ctx.now })
        .where(and(eq(automationRunSteps.runId, run.id), gt(automationRunSteps.idx, idx)));
    } else {
      const skipTo = step.else.skipTo;
      const target = run.definition.steps.findIndex((s) => s.id === skipTo);
      await tx
        .update(automationRunSteps)
        .set({ state: 'skipped', finishedAt: ctx.now, updatedAt: ctx.now })
        .where(
          and(
            eq(automationRunSteps.runId, run.id),
            gt(automationRunSteps.idx, idx),
            sql`${automationRunSteps.idx} < ${target}`,
          ),
        );
    }
  }
  return;
}

export async function executeWait({ ctx, run, idx, base, step }: StepExecution<'wait'>): Promise<void> {
  const tx = ctx.tx;
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'waiting',
      wakeAt: new Date(ctx.now.getTime() + step.minutes * 60_000),
      inputSummary: `Waiting ${step.minutes} min`,
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'waiting', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
  return;
}

export async function executeRequestApproval({
  ctx,
  run,
  idx,
  attempt,
  scope,
  base,
  step,
}: StepExecution<'request_approval'>): Promise<void> {
  const tx = ctx.tx;
  const title = renderTemplate(step.title, scope, 160);
  const details = renderTemplate(step.details, scope, 2000);
  const approval = await requestStepApproval(
    ctx,
    run,
    step,
    attempt,
    scope,
    {
      name: CONTINUE_STEP,
      input: { runId: run.id, stepId: step.id, attempt, proposal: { title, details } },
    },
    { title, details, keyId: 'approvals.decide', question: ownQuestion(step.details, details) },
  );
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'waiting',
      approvalId: approval.id,
      inputSummary: 'Asked you to approve',
      output: { title },
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'waiting', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
  return;
}

/**
 * What a recipe's check decided, in plain words (AR-38, core `recipeConditionStory`): “No: Dusty says it’s not a bug.”
 * `scope` is what the condition was evaluated with — the gate's fresh GitHub facts, `run.test` and `run.today` — and
 * the names are the recipe's agent, its developer (when set) and its reviewer. Null for a definition that isn't a
 * recipe's (`recipeOf`, by shape: older words count too) and for a step that isn't one of its checks.
 */
async function conditionStory(
  tx: Db,
  run: AutomationRunRow,
  stepId: string,
  holds: boolean,
  scope: Record<string, unknown>,
): Promise<string | null> {
  const recipe = recipeOf(run.definition);
  if (!recipe) return null;
  // The agent by its name (one-agent.md OA-15).
  const agent = await loadAgentRow(tx, run.burrowId);
  return recipeConditionStory(recipe, stepId, holds, scope, { agent: agent?.name ?? 'the agent' });
}
