import {
  type AutomationStep,
  blockedEventFields,
  type JsonObject,
  keyLabel,
  renderTemplate,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { automationRuns, repos } from '../../db/schema/index';
import { loadAgentRow } from '../../read/principals';
import { keyDecision } from '../authority';
import type { AutomationRunRow } from '../store';
import { approvedBranchRequest } from '../workspace';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import { automationPrincipal } from './checks';
import { block, skipStep, updateStep } from './state';
import type { StepExecution } from './types';

export async function executeGitHubComment({
  ctx,
  run,
  steps,
  idx,
  attempt,
  scope,
  publisher,
  base,
  step,
}: StepExecution<'github_comment'>): Promise<void> {
  const tx = ctx.tx;
  const previous = (steps[idx]?.output ?? {}) as JsonObject;
  const plan = await commentPlan(tx, run, idx, step, scope);
  if (!plan.ok) return skipStep(ctx, run, idx, base, plan.reason);
  const [repo] = await tx
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, run.burrowId), eq(repos.fullName, step.repo)));
  const decision = await keyDecision(
    tx,
    (await automationPrincipal(tx, run)) ?? '',
    publisher,
    'pr.comment',
    { repo: step.repo },
  );
  const onGitHub = !!repo?.enabled && repo.source === 'github';
  if (!onGitHub || decision.outcome === 'deny') {
    const reason = !onGitHub
      ? `${step.repo} isn’t switched on, so it can’t comment there.`
      : `It may not comment on ${step.repo}: it doesn’t hold “${keyLabel('pr.comment')}” for it.`;
    if (decision.outcome === 'deny')
      await ctx.emit({
        ...blockedEventFields(decision, ctx.actor.shortName, `comment on ${plan.target}`),
        where: step.repo,
        payload: { runId: run.id, keyId: 'pr.comment', reason: decision.reason },
      });
    if (step.otherwise === 'fail') return block(ctx, run, idx, reason);
    return skipStep(ctx, run, idx, base, reason);
  }
  let commentApprovalId: string | null = null;
  if (decision.outcome === 'ask') {
    const asked = typeof previous.commentApprovalId === 'string' ? previous.commentApprovalId : null;
    if (asked && (await approvedBranchRequest(tx, asked, run.id, step, attempt))) commentApprovalId = asked;
    else {
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
        { ...plan.proposal, keyId: 'pr.comment' },
      );
      await updateStep(
        tx,
        run.id,
        idx,
        {
          ...base,
          state: 'waiting',
          approvalId: approval.id,
          inputSummary: `Asked to comment on ${plan.target}`,
          output: { repo: step.repo, number: plan.number },
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
  // Allowed (or approved): marked running first — it reaches GitHub — and the engine comments in its own pass.
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'running',
      inputSummary: `Comment on ${plan.target}`,
      output: {
        repo: step.repo,
        number: plan.number,
        body: plan.body,
        ...(commentApprovalId ? { commentApprovalId } : {}),
      },
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'running', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
  return;
}

/** Why a `github_comment` step has nothing to comment on (no number). */
export const NOTHING_TO_COMMENT_ON =
  'Nothing to comment on: this run didn’t start from an issue or pull request.';

/**
 * What a `github_comment` step would post, as the definition renders it for this run: the issue or pull request, the
 * text with its footer (“— Dusty via Whombat”, the agent of the nearest agent step before it that isn't a review's
 * verdict), and the proposal a person
 * approves when its key asks. Also the approval guard's re-render (engine.ts).
 */
export async function commentPlan(
  db: Db,
  run: Pick<AutomationRunRow, 'burrowId' | 'definition'>,
  idx: number,
  step: Extract<AutomationStep, { kind: 'github_comment' }>,
  scope: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      number: number;
      target: string;
      body: string;
      proposal: { title: string; details: string };
    }
  | { ok: false; reason: string }
> {
  const number = renderTemplate(step.number, scope, 20).trim();
  if (!/^[1-9][0-9]{0,9}$/.test(number)) return { ok: false, reason: NOTHING_TO_COMMENT_ON };
  const text = renderTemplate(step.text, scope, 8000).trim();
  if (!text) return { ok: false, reason: 'Nothing to comment: the text came out empty.' };
  const target = `${step.repo}#${number}`;
  // The agent that did the work: a reviewer's verdict step doesn't sign (a fix's “ready for review” is the fixer's).
  const asker = run.definition.steps
    .slice(0, idx)
    .reverse()
    .find((s) => s.kind === 'dispatch_agent' && !s.verdict);
  const agent = asker?.kind === 'dispatch_agent' ? await loadAgentRow(db, run.burrowId) : undefined;
  const body = `${text}\n\n— ${agent ? `${agent.name} ` : ''}via Whombat`;
  return {
    ok: true,
    number: Number(number),
    target,
    body,
    proposal: { title: `Comment on ${target}`.slice(0, 160), details: body.slice(0, 2000) },
  };
}
