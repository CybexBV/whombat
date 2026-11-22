import { randomUUID } from 'node:crypto';
import type { JsonObject } from '@whombat/core';
import { eq, inArray } from 'drizzle-orm';
import { callArgsAad } from '../../connections/call';
import { callTarget } from '../../connections/call-target';
import type { Db, Tx } from '../../db/client';
import { automationRuns, catalogConnections } from '../../db/schema/index';
import { approvedActionsRequest, planConnectionActions } from '../proposed-actions';
import type { CardNames } from '../proposed-card';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import { block, skipStep, updateStep } from './state';
import type { StepExecution } from './types';

/**
 * Executes a `connection_actions` step: validates proposed actions from step `from`, ALWAYS asks the person on an
 * approval card first regardless of standing connection/key settings, and marks the step `running` only once that
 * approval card has been approved so `runExternal` executes the calls outside any DB transaction. `names` are the names
 * of the ids the actions name, read just before (`card-names.ts`); the card's are kept on the step.
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
  names,
}: StepExecution<'connection_actions'> & { names?: CardNames }): Promise<void> {
  const tx = ctx.tx;
  const previous = (steps[idx]?.output ?? {}) as JsonObject;
  const plan = await planConnectionActions(tx, ctx.services, run, steps, step, names);
  if (!plan.ok) {
    if (plan.fatal || step.otherwise === 'fail') return block(ctx, run, idx, plan.reason);
    return skipStep(ctx, run, idx, base, plan.reason, { ran: false, count: 0, reason: plan.reason });
  }
  if (plan.actions.length === 0 || !plan.card) {
    return skipStep(ctx, run, idx, base, 'No actions were proposed.', { ran: false, count: 0 });
  }
  const card = plan.card;

  // Always ask the person on a card first, whatever standing settings on connections or keys say, and require the
  // approved card's `actionsHash` to match what was just re-planned (if anything changed, ask again instead of running).
  const asked = typeof previous.actionsApprovalId === 'string' ? previous.actionsApprovalId : null;
  const previousHash = typeof previous.actionsHash === 'string' ? previous.actionsHash : null;
  const approved =
    asked !== null &&
    previousHash === plan.actionsHash &&
    (await approvedActionsRequest(tx, asked, run.id, step, attempt, plan.actionsHash));
  if (asked !== null && !approved) {
    // A yes to a card that no longer matches what would run (a connection got another address, account or sign-in, say):
    // asked again on a fresh card, its names read again from where the calls go now (the engine's next pass).
    await updateStep(
      tx,
      run.id,
      idx,
      {
        ...base,
        state: 'pending',
        approvalId: null,
        output: freshCardOutput(changedTargets(previous, plan.actions)),
      },
      ctx.now,
    );
    return;
  }
  if (!approved || !asked) {
    // The card shows every line of every action, asks Whombat's own question, and its message names the actions in
    // Whombat's words only: nothing the agent or the email wrote leads it.
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
        question: card.question,
        whatHappens: card.whatHappens,
        summary: card.summary,
        cardText: againText(previous) + card.cardText,
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
        output: {
          actionsHash: plan.actionsHash,
          count: plan.actions.length,
          // Where each connection's calls went when the card was made: what a later change is told by.
          targets: Object.fromEntries(plan.actions.map((a) => [a.connectionId, a.target])),
          ...(Object.keys(plan.names).length ? { cardNames: plan.names } : {}),
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

  // Approved on the card: seal each call's arguments and mark the step `running` so `runExternal` executes them.
  const prepared = plan.actions.map((a) => {
    const callId = randomUUID();
    return {
      callId,
      connectionId: a.connectionId,
      target: a.target,
      handle: a.handle,
      label: a.label,
      tool: a.tool,
      toolHash: a.toolHash,
      description: a.description,
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

/** The labels of the connections whose calls go elsewhere, or as someone else, than when the card was made. */
function changedTargets(
  previous: JsonObject,
  actions: readonly { connectionId: string; target: string; label: string }[],
): string[] {
  const was = previous.targets;
  if (!was || typeof was !== 'object' || Array.isArray(was)) return [];
  const before = was as Record<string, unknown>;
  return [
    ...new Set(
      actions
        .filter((a) => typeof before[a.connectionId] === 'string' && before[a.connectionId] !== a.target)
        .map((a) => a.label),
    ),
  ];
}

/** The labels of the connections a waiting card's calls would now send elsewhere, or as someone else. */
export async function changedSinceCard(db: Db | Tx, output: unknown): Promise<string[]> {
  const was = (output as { targets?: unknown } | null)?.targets;
  if (!was || typeof was !== 'object' || Array.isArray(was)) return [];
  const ids = Object.keys(was);
  if (!ids.length) return [];
  const rows = await db.select().from(catalogConnections).where(inArray(catalogConnections.id, ids));
  return changedTargets(
    output as JsonObject,
    rows.map((r) => ({ connectionId: r.id, target: callTarget(r), label: r.label })),
  );
}

/**
 * A `connection_actions` step's output when it asks again: nothing of the card before (no yes, no names), and which
 * connections changed since the yes, so the fresh card says so.
 */
export function freshCardOutput(changed: readonly string[]): JsonObject {
  return changed.length ? { changedSinceYes: [...changed] } : {};
}

/** The first words of a card asked again because connections changed since the person's yes. */
function againText(previous: JsonObject): string {
  const changed = Array.isArray(previous.changedSinceYes)
    ? previous.changedSinceYes.filter((l): l is string => typeof l === 'string')
    : [];
  if (!changed.length) return '';
  const names =
    changed.length === 1 ? changed[0] : `${changed.slice(0, -1).join(', ')} and ${changed.at(-1)}`;
  return `${names} changed since you said yes. `;
}
