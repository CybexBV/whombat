import { randomUUID } from 'node:crypto';
import {
  type AutomationStep,
  directActionAsksEachTime,
  directActionText,
  type JsonObject,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { callTarget } from '../../connections/call-target';
import type { Db, Tx } from '../../db/client';
import { automationRuns, automations } from '../../db/schema/index';
import { tServer } from '../../i18n/catalog';
import { burrowLocale } from '../../i18n/locale';
import { directAsks, planDirectAction, withNames } from '../direct-action';
import type { AutomationRunRow } from '../store';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import { block, skipStep, updateStep } from './state';
import type { StepExecution } from './types';

type RunActionStep = Extract<AutomationStep, { kind: 'run_action' }>;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * What the approval card of a `run_action` step proposes: the action, and why it asks (a test run, a scene or a script,
 * or the person's settings), and where the call goes and as whom (`callTarget` of the connection now). The approval
 * guard renders it again before the yes runs, so what was approved is what runs, there. `step` carries the names
 * Whombat knows now (`withNames`).
 */
export async function runActionProposal(
  tx: Db | Tx,
  run: Pick<AutomationRunRow, 'automationId' | 'test'>,
  step: RunActionStep,
  target: string,
): Promise<{ title: string; details: string; target: string }> {
  const what = directActionText(step);
  const [automation] = await tx
    .select({ name: automations.name })
    .from(automations)
    .where(eq(automations.id, run.automationId));
  const name = automation?.name ?? 'An automation';
  const why = run.test
    ? 'This is a try, so it asks before it changes anything.'
    : directActionAsksEachTime(step)
      ? 'Whombat can’t see what a scene or a script does, so it asks you each time.'
      : 'Your settings say to ask you first.';
  return { title: what, details: `“${name}” wants to ${lowerFirst(what)} now. ${why}`, target };
}

/**
 * Executes a `run_action` step (docs/decisions/direct-automations.md): checks it can run now, asks on the approval card
 * when the person's own rules ask for this call, it starts a scene or a script, or it is a test run (a yes for this
 * attempt only), and otherwise marks it `running` so
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
  step: saved,
}: StepExecution<'run_action'>): Promise<void> {
  const tx = ctx.tx;
  const previous = (steps[idx]?.output ?? {}) as JsonObject;
  // What the run page says is in the person's language; the approval's own words stay as the guard renders them again.
  const locale = await burrowLocale(ctx.services, run.burrowId);
  const plan = await planDirectAction(tx, ctx.services, run.burrowId, saved, locale);
  const cannot = (reason: string, fatal: boolean) =>
    fatal || saved.otherwise === 'fail'
      ? block(ctx, run, idx, reason)
      : skipStep(ctx, run, idx, base, reason, { ran: false, text: reason, summary: reason });
  if (!plan.ok) return cannot(plan.reason, plan.fatal);
  // The card and the run page name what it acts on as Whombat knows it now, not as it was saved.
  const step = withNames(saved, plan.names);
  const what = directActionText(step);
  const target = callTarget(plan.conn);
  const yes =
    typeof previous.approvalId === 'string' && previous.approvalAttempt === attempt
      ? previous.approvalId
      : null;
  // A yes is for the connection as it was on the card: one that went elsewhere or as someone else since sends nothing.
  const approvedTarget = yes && typeof previous.approvedTarget === 'string' ? previous.approvedTarget : null;
  if (approvedTarget && approvedTarget !== target)
    return cannot(tServer(locale, 'automations.direct.changedSinceYes', { name: plan.conn.label }), false);
  // A test run never acts unattended: like the person's own rules, it asks on the card first.
  if (directAsks(plan, run) && !yes) {
    const proposal = await runActionProposal(tx, run, step, target);
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
      {
        ...base,
        state: 'waiting',
        approvalId: approval.id,
        inputSummary: tServer(locale, 'automations.direct.askedFirst', {
          what: directActionText(step, locale),
        }),
      },
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
      inputSummary: directActionText(step, locale),
      output: {
        ...(yes ? { approvalId: yes, approvalAttempt: attempt } : {}),
        callId: randomUUID(),
        // Where the call goes and as whom now (as the yes saw it): nothing is sent should that change before it runs.
        target: approvedTarget ?? target,
      },
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'running', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
}
