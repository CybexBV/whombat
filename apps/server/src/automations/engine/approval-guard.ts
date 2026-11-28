/**
 * An automation's approvals inside the approvals engine (bp-automations BP-C08…BP-C10): the guard `StartExecution` runs
 * before an approved action of an automation runs, and the reconciler of `automation.continue_step` after a crash.
 */
import { type AutomationStep, type JsonObject, renderTemplate } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { approvalActionHash } from '../../approvals/create';
import type { ApprovalRow } from '../../approvals/engine';
import type { ApplyContext } from '../../commit/types';
import type { Db } from '../../db/client';
import { automationRunSteps } from '../../db/schema/index';
import { burrowLocale } from '../../i18n/locale';
import { loadAgentRow, loadPrincipalRow } from '../../read/principals';
import { trackerWords } from '../../trackers/connection';
import { trackerReplyPlan } from '../../trackers/reply';
import { trackerWritePlan } from '../../trackers/write';
import { keyDecision, publisherCheck } from '../authority';
import { planDirectAction } from '../direct-action';
import { MERGE_WORDS, mergePlan } from '../merge';
import { isAutomationPrincipal } from '../principal';
import { planConnectionActions } from '../proposed-actions';
import { CONTINUE_STEP, commentPlan, definitionStep, stepBinding, stepRoomsCheck, stepScope } from '../steps';
import { pullRequestText } from '../steps/open-pull-request';
import { runActionProposal } from '../steps/run-action';
import { type AutomationRunRow, loadRunRow, loadStepRows } from '../store';
import { branchDecision, branchProposal, resolveStepWorkspace } from '../workspace';

/**
 * Inside `StartExecution`: an automation's approval runs only while its run still waits for it, its publisher
 * still has the authority, and the action it would run — re-rendered from the definition, with the branch's
 * commit read now — hashes to what was approved. A stale one is refused and the run asks again.
 */
export async function approvalGuard(ctx: ApplyContext, row: ApprovalRow): Promise<string | null> {
  const requester = await loadPrincipalRow(ctx.tx, row.requesterId);
  if (!isAutomationPrincipal(requester)) return null;
  const [stepRow] = await ctx.tx
    .select()
    .from(automationRunSteps)
    .where(eq(automationRunSteps.approvalId, row.id));
  if (!stepRow) return 'This approval doesn’t belong to an automation run any more.';
  const run = await loadRunRow(ctx.tx, stepRow.runId);
  if (!['running', 'waiting'].includes(run.status) || stepRow.state !== 'waiting')
    return 'This automation run isn’t waiting for it any more.';
  const mark = async (refusal: 'stale' | 'blocked') => {
    await ctx.tx
      .update(automationRunSteps)
      .set({ output: { ...(stepRow.output as JsonObject), refusal }, updatedAt: ctx.now })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, stepRow.idx)));
  };
  const who = await publisherCheck(ctx.tx, run.burrowId, run.publishedById);
  if (!who.ok) {
    await mark('blocked');
    return who.reason;
  }
  // The run's room and every room whose content went into this step (BP-C20), as before the step itself.
  const rooms = await stepRoomsCheck(ctx.tx, run, stepRow.idx, who.publisher);
  if (!rooms.ok) {
    await mark('blocked');
    return rooms.reason;
  }
  const step = definitionStep(run.definition, stepRow.idx);
  // The scope the step was rendered with (`run.today` too), so what a person approved re-renders the same.
  const scope = await stepScope(ctx.tx, run, await loadStepRows(ctx.tx, run.id), ctx.now);
  if (row.command?.name === 'open_pr' && step.kind === 'open_pull_request') {
    const decision = await keyDecision(ctx.tx, row.requesterId, who.publisher, 'pr.open', {
      repo: step.repo,
      branch: renderTemplate(step.branch, scope, 255),
    });
    if (decision.outcome === 'deny') {
      await mark('blocked');
      return 'It may no longer open pull requests there.';
    }
  }
  const binding = await stepBinding(ctx.tx, run, step, stepRow.attempt, scope);
  let input = await liveInput(ctx, run, step, stepRow.attempt, scope, row);
  if (step.kind === 'dispatch_agent' && step.workspace && row.command?.name === CONTINUE_STEP) {
    // A person lets the agent work on its branch (BP-C26): the same agent, repo and branch, and the agent's key
    // still no more than asks for it.
    const agent = await loadAgentRow(ctx.tx, run.burrowId);
    const ws = await resolveStepWorkspace(ctx.tx, run.burrowId, step.workspace, scope);
    if (!agent || !ws.ok) {
      await mark('blocked');
      return ws.ok ? 'That agent is gone.' : ws.reason;
    }
    if ((await branchDecision(ctx.tx, agent, who.publisher, ws.workspace)).outcome === 'deny') {
      await mark('blocked');
      return `${agent.name} may no longer work on ${ws.workspace.branch}.`;
    }
    input = {
      runId: run.id,
      stepId: step.id,
      attempt: stepRow.attempt,
      proposal: branchProposal(agent.name, ws.workspace),
    };
  }
  if (step.kind === 'github_comment' && row.command?.name === CONTINUE_STEP) {
    // A person lets it comment on GitHub: the same issue or pull request and words, and its key still no more than
    // asks for it.
    const plan = await commentPlan(ctx.tx, run, stepRow.idx, step, scope);
    if (!plan.ok) {
      await mark('blocked');
      return plan.reason;
    }
    const decision = await keyDecision(ctx.tx, row.requesterId, who.publisher, 'pr.comment', {
      repo: step.repo,
    });
    if (decision.outcome === 'deny') {
      await mark('blocked');
      return `It may no longer comment on ${step.repo}.`;
    }
    input = { runId: run.id, stepId: step.id, attempt: stepRow.attempt, proposal: plan.proposal };
  }
  if (step.kind === 'merge_pull_request' && row.command?.name === CONTINUE_STEP) {
    // A person lets it merge (AR-45): the same pull request into the same base, and its key still no more than asks
    // for it. The merge itself still waits for the checks.
    const plan = await mergePlan(ctx.tx, run, step, scope);
    if (!plan.ok) {
      await mark('blocked');
      return plan.reason;
    }
    const decision = await keyDecision(ctx.tx, row.requesterId, who.publisher, plan.keyId, plan.keyScope);
    if (decision.outcome === 'deny') {
      await mark('blocked');
      return MERGE_WORDS.mayNoLonger(plan.base, step.repo);
    }
    input = { runId: run.id, stepId: step.id, attempt: stepRow.attempt, proposal: plan.proposal };
  }
  if (step.kind === 'tracker_reply' && row.command?.name === CONTINUE_STEP) {
    // A person lets it reply to the customer (TA-27, TA-28): the same report and exactly the same signed words, and
    // its key still lets it at all.
    const plan = await trackerReplyPlan(ctx.tx, run, await loadStepRows(ctx.tx, run.id), step, scope);
    if (!plan.ok) {
      await mark('blocked');
      return plan.reason;
    }
    const decision = await keyDecision(ctx.tx, row.requesterId, who.publisher, 'report.reply', {
      connection: step.connectionId,
    });
    if (decision.outcome === 'deny') {
      await mark('blocked');
      return `It may no longer reply to customers in ${plan.connection}.`;
    }
    input = { runId: run.id, stepId: step.id, attempt: stepRow.attempt, proposal: plan.proposal };
  }
  if (step.kind === 'tracker_update' && row.command?.name === CONTINUE_STEP) {
    // A person lets it write to the tracker (TA-12): the same report and words, and its key still no more than asks.
    const plan = await trackerWritePlan(ctx.tx, run, await loadStepRows(ctx.tx, run.id), step, scope, (r) =>
      trackerWords(ctx.services, r),
    );
    if (!plan.ok) {
      await mark('blocked');
      return plan.reason;
    }
    const decision = await keyDecision(ctx.tx, row.requesterId, who.publisher, 'report.update', {
      connection: step.connectionId,
    });
    if (decision.outcome === 'deny') {
      await mark('blocked');
      return `It may no longer write to ${plan.connection}.`;
    }
    input = { runId: run.id, stepId: step.id, attempt: stepRow.attempt, proposal: plan.proposal };
  }
  if (step.kind === 'connection_actions' && row.command?.name === CONTINUE_STEP) {
    // Re-validate proposed actions and their exact hash before letting an approved card execute them.
    const plan = await planConnectionActions(
      ctx.tx,
      ctx.services,
      run,
      await loadStepRows(ctx.tx, run.id),
      step,
    );
    if (!plan.ok) {
      await mark('blocked');
      return plan.reason;
    }
    if (plan.actions.length === 0) {
      await mark('blocked');
      return 'There are no actions left to run.';
    }
    input = {
      runId: run.id,
      stepId: step.id,
      attempt: stepRow.attempt,
      proposal: plan.proposal,
      actionsHash: plan.actionsHash,
    };
  }
  if (step.kind === 'run_action' && row.command?.name === CONTINUE_STEP) {
    // A person lets it act without AI where their settings ask: the same action on the same thing, which can still run.
    const plan = await planDirectAction(
      ctx.tx,
      ctx.services,
      run.burrowId,
      step,
      await burrowLocale(ctx.services, run.burrowId),
    );
    if (!plan.ok) {
      await mark('blocked');
      return plan.reason;
    }
    input = {
      runId: run.id,
      stepId: step.id,
      attempt: stepRow.attempt,
      proposal: await runActionProposal(ctx.tx, run, step),
    };
  }
  if (
    !input ||
    approvalActionHash(row.action, { name: row.command?.name ?? '', input }, binding) !== row.actionHash
  ) {
    await mark('stale');
    return 'The commit or the input changed since it was approved, so it needs a new approval.';
  }
  return null;
}

/** After a crash mid-execution of `automation.continue_step`: did it continue the run? */
export async function reconcileContinue(db: Db, row: ApprovalRow): Promise<'done' | 'not_done' | 'unknown'> {
  const [step] = await db.select().from(automationRunSteps).where(eq(automationRunSteps.approvalId, row.id));
  if (!step) return 'unknown';
  if (step.state === 'succeeded' && (step.output as { decision?: string }).decision === 'approved')
    return 'done';
  // A branch approval continued its dispatch step: it went back to pending (and on) with the approval (BP-C26).
  if ((step.output as { branchApprovalId?: string }).branchApprovalId === row.id) return 'done';
  // A comment approval continued its step the same way (automation-recipes.md).
  if ((step.output as { commentApprovalId?: string }).commentApprovalId === row.id) return 'done';
  // A tracker write approval likewise (report-trackers.md TA-12), and a reply's (TA-27).
  if ((step.output as { writeApprovalId?: string }).writeApprovalId === row.id) return 'done';
  if ((step.output as { replyApprovalId?: string }).replyApprovalId === row.id) return 'done';
  // And a merge approval (automation-recipes.md AR-45).
  if ((step.output as { mergeApprovalId?: string }).mergeApprovalId === row.id) return 'done';
  // And a proposed connection-actions approval.
  if ((step.output as { actionsApprovalId?: string }).actionsApprovalId === row.id) return 'done';
  // And an action without AI that the person's settings ask about.
  if ((step.output as { approvalId?: string }).approvalId === row.id && step.kind === 'run_action')
    return 'done';
  if (step.state === 'waiting') return 'not_done';
  return 'unknown';
}

/** The deferred command's input as the definition renders it now (null when it can't be rendered). */
async function liveInput(
  ctx: ApplyContext,
  run: AutomationRunRow,
  step: AutomationStep,
  attempt: number,
  scope: Record<string, unknown>,
  row: ApprovalRow,
): Promise<JsonObject | null> {
  if (step.kind === 'request_approval' && row.command?.name === CONTINUE_STEP)
    return {
      runId: run.id,
      stepId: step.id,
      attempt,
      proposal: {
        title: renderTemplate(step.title, scope, 160),
        details: renderTemplate(step.details, scope, 2000),
      },
    };
  if (step.kind === 'open_pull_request' && row.command?.name === 'open_pr') {
    const stored = row.command.input as { base?: string };
    // Rendered exactly as the step renders it (the tracker's line, no organization, no line for the customer).
    const { branch, title, body } = await pullRequestText(ctx, run, step, scope);
    return {
      repo: step.repo,
      branch,
      base: stored.base ?? step.base ?? 'main',
      title,
      body,
      conversationId: run.conversationId,
    };
  }
  return null;
}
