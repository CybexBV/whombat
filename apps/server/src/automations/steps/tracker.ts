import { randomUUID } from 'node:crypto';
import { blockedEventFields, type JsonObject, keyLabel, renderTemplate, TrackerItemId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { automationRuns, trackerItems } from '../../db/schema/index';
import { trackerConnectionRow, trackerWords } from '../../trackers/connection';
import {
  alreadyDecided,
  decidedRequest,
  openFeatureRequest,
  REPORT_CLOSED,
  replaceWaitingRequests,
} from '../../trackers/features';
import { quoted, replyAgent, trackerReplyPlan } from '../../trackers/reply';
import { trackerWritePlan } from '../../trackers/write';
import { reportedAssessment } from '../assessment';
import { keyDecision } from '../authority';
import { approvedBranchRequest } from '../workspace';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import { automationPrincipal } from './checks';
import { block, skipStep, updateStep } from './state';
import type { StepExecution } from './types';

export async function executeTrackerReply({
  ctx,
  run,
  steps,
  idx,
  attempt,
  scope,
  publisher,
  base,
  step,
}: StepExecution<'tracker_reply'>): Promise<void> {
  const tx = ctx.tx;
  // Replying to the customer of a tracker report (report-trackers.md TA-25…TA-28).
  const previous = (steps[idx]?.output ?? {}) as JsonObject;
  const plan = await trackerReplyPlan(tx, run, steps, step, scope);
  if (!plan.ok) {
    if (plan.fatal) return block(ctx, run, idx, plan.reason);
    return skipStep(ctx, run, idx, base, plan.reason, { sent: false, reason: plan.reason });
  }
  const decision = await keyDecision(
    tx,
    (await automationPrincipal(tx, run)) ?? '',
    publisher,
    'report.reply',
    { connection: step.connectionId },
  );
  const target = {
    connectionId: plan.connectionId,
    connection: plan.connection,
    reportId: plan.reportId,
    number: plan.number,
  };
  if (decision.outcome === 'deny') {
    const reason = `It may not reply to customers in ${plan.connection}: it doesn’t hold “${keyLabel('report.reply')}” for it.`;
    await ctx.emit({
      ...blockedEventFields(
        decision,
        ctx.actor.shortName,
        `reply to the customer of ${plan.connection} #${plan.number}`,
      ),
      where: plan.connection,
      payload: { runId: run.id, keyId: 'report.reply', reason: decision.reason },
    });
    if (step.otherwise === 'fail') return block(ctx, run, idx, reason);
    return skipStep(ctx, run, idx, base, reason, { ...target, sent: false, reason });
  }
  // A reply with something to check, and a test run's, waits for a person whatever the key says (TA-28).
  let replyApprovalId: string | null = null;
  if (decision.outcome === 'ask' || plan.problem || plan.test) {
    const asked = typeof previous.replyApprovalId === 'string' ? previous.replyApprovalId : null;
    if (asked && (await approvedBranchRequest(tx, asked, run.id, step, attempt))) replyApprovalId = asked;
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
        {
          ...plan.proposal,
          keyId: 'report.reply',
          // The card's message quotes exactly what the customer would get.
          cardText: `I need a person to say yes before I go on: ${plan.proposal.title}\n\n${quoted(plan.message)}`,
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
          inputSummary: `Asked to reply to the customer of ${plan.connection} #${plan.number}`,
          output: {
            ...target,
            ...(typeof previous.requestId === 'string' ? { requestId: previous.requestId } : {}),
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
  }
  // Allowed (or approved): marked running first — it reaches the customer — and the engine sends it in its own pass,
  // with a request id kept across the step's attempts (the tracker replays it, so the customer gets it once).
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'running',
      inputSummary: `Reply to the customer of ${plan.connection} #${plan.number}`.slice(0, 1000),
      output: {
        ...target,
        message: plan.message,
        asks: plan.asks,
        // A finished report is closed by its reply, a repeat linked to its original (TA-54).
        ...(plan.closes ? { closes: true } : {}),
        ...(plan.solved ? { solved: true } : {}),
        ...(plan.duplicateOf ? { duplicateOf: plan.duplicateOf } : {}),
        // The person's decision on a feature request sets its own status (TA-46).
        ...(plan.decisionStatus ? { decisionStatus: plan.decisionStatus } : {}),
        // Sent only with a person's yes, whatever the key says (TA-28).
        mustAsk: !!plan.problem || plan.test,
        agent: plan.agent,
        requestId: typeof previous.requestId === 'string' ? previous.requestId : randomUUID(),
        ...(replyApprovalId ? { replyApprovalId } : {}),
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

export async function executeTrackerUpdate({
  ctx,
  run,
  steps,
  idx,
  attempt,
  scope,
  publisher,
  base,
  step,
}: StepExecution<'tracker_update'>): Promise<void> {
  const tx = ctx.tx;
  // Writing the assessment back to a tracker report (report-trackers.md TA-11…TA-13).
  const previous = (steps[idx]?.output ?? {}) as JsonObject;
  const plan = await trackerWritePlan(tx, run, steps, step, scope, (row) => trackerWords(ctx.services, row));
  if (!plan.ok) {
    if (plan.fatal) return block(ctx, run, idx, plan.reason);
    return skipStep(ctx, run, idx, base, plan.reason, { wrote: false, reason: plan.reason });
  }
  const decision = await keyDecision(
    tx,
    (await automationPrincipal(tx, run)) ?? '',
    publisher,
    'report.update',
    { connection: step.connectionId },
  );
  const target = { connectionId: plan.connectionId, reportId: plan.reportId, number: plan.number };
  if (decision.outcome === 'deny') {
    const reason = `It may not write to ${plan.connection}: it doesn’t hold “${keyLabel('report.update')}” for it.`;
    await ctx.emit({
      ...blockedEventFields(decision, ctx.actor.shortName, `update ${plan.connection} #${plan.number}`),
      where: plan.connection,
      payload: { runId: run.id, keyId: 'report.update', reason: decision.reason },
    });
    if (step.otherwise === 'fail') return block(ctx, run, idx, reason);
    return skipStep(ctx, run, idx, base, reason, { ...target, wrote: false, reason });
  }
  let writeApprovalId: string | null = null;
  if (decision.outcome === 'ask') {
    const asked = typeof previous.writeApprovalId === 'string' ? previous.writeApprovalId : null;
    if (asked && (await approvedBranchRequest(tx, asked, run.id, step, attempt))) writeApprovalId = asked;
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
        { ...plan.proposal, keyId: 'report.update' },
      );
      await updateStep(
        tx,
        run.id,
        idx,
        {
          ...base,
          state: 'waiting',
          approvalId: approval.id,
          inputSummary: `Asked to write ${plan.proposal.title}`,
          output: {
            ...target,
            connection: plan.connection,
            ...(typeof previous.requestId === 'string' ? { requestId: previous.requestId } : {}),
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
  }
  // Allowed (or approved): marked running first — it reaches the tracker — and the engine writes in its own pass, with
  // a request id kept across the step's attempts (TA-13: the tracker replays it, so a write is never applied twice).
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'running',
      inputSummary: `Write ${plan.proposal.title}`.slice(0, 1000),
      output: {
        ...target,
        connection: plan.connection,
        write: { assessment: plan.write.assessment, priority: plan.write.priority },
        agent: plan.agent,
        requestId: typeof previous.requestId === 'string' ? previous.requestId : randomUUID(),
        ...(writeApprovalId ? { writeApprovalId } : {}),
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

/**
 * A feature request put to the person (report-trackers.md TA-44): only when step `from` assessed a feature request
 * that doesn't wait for the customer and the report wasn't approved or declined before; else the step is skipped with
 * why. A waiting request of the same report in another run is replaced, the card posted, and the step waits for the
 * person's answer (`tracker.decide` settles it).
 */
export async function executeTrackerDecision({
  ctx,
  run,
  steps,
  idx,
  attempt,
  scope,
  base,
  step,
}: StepExecution<'tracker_decision'>): Promise<void> {
  const tx = ctx.tx;
  const skip = (reason: string) => skipStep(ctx, run, idx, base, reason, { decided: false, reason });
  const reportId = renderTemplate(step.report, scope, 100).trim();
  if (!reportId || !TrackerItemId.safeParse(reportId).success)
    return skip('Nothing to decide: this run didn’t start from a tracker’s report.');
  const connection = await trackerConnectionRow(tx, run.burrowId, step.connectionId);
  if (!connection) return block(ctx, run, idx, 'Its tracker connection is gone.');
  const kept = steps.find((s) => s.stepId === step.from)?.output as { assessment?: unknown } | undefined;
  const assessment = reportedAssessment(kept?.assessment);
  // A report the run's reply closed (TA-54) — what the reply did, not what the agent asked — or one that isn't a
  // feature request any more, ends a card still waiting for it.
  const replied = run.definition.steps
    .filter((s) => s.kind === 'tracker_reply' && !s.decision && s.connectionId === step.connectionId)
    .map(
      (s) => steps.find((r) => r.stepId === s.id)?.output as { sent?: unknown; status?: unknown } | undefined,
    );
  if (replied.some((o) => o?.sent === true && (o.status === 'closed' || o.status === 'duplicate'))) {
    await replaceWaitingRequests(ctx, connection.id, reportId, run.id, REPORT_CLOSED);
    return skip('Nothing to decide: the report was closed.');
  }
  if (assessment.kind !== 'feature') {
    await replaceWaitingRequests(ctx, connection.id, reportId, run.id);
    return skip('Not a feature request.');
  }
  if (assessment.replyAsks) return skip('Waiting for the customer’s answer first.');
  const earlier = await decidedRequest(tx, connection.id, reportId);
  if (earlier) return skip(await alreadyDecided(tx, earlier));
  const trigger = scope.trigger as {
    reportId?: unknown;
    connectionId?: unknown;
    number?: unknown;
    title?: unknown;
    organization?: unknown;
  } | null;
  const same = trigger?.reportId === reportId && trigger.connectionId === step.connectionId;
  const [mirrored] = await tx
    .select({
      number: trackerItems.number,
      title: trackerItems.title,
      organization: trackerItems.organization,
    })
    .from(trackerItems)
    .where(and(eq(trackerItems.connectionId, step.connectionId), eq(trackerItems.externalId, reportId)));
  const number = same && typeof trigger?.number === 'number' ? trigger.number : (mirrored?.number ?? 0);
  if (!number) return skip('Nothing to decide: Whombat doesn’t know this report.');
  const title =
    same && typeof trigger?.title === 'string' ? trigger.title : (mirrored?.title ?? `Report #${number}`);
  const organization =
    same && typeof trigger?.organization === 'string'
      ? trigger.organization
      : (mirrored?.organization ?? null);
  await replaceWaitingRequests(ctx, connection.id, reportId, run.id);
  const { agent, signature } = await replyAgent(
    tx,
    run.burrowId,
    run.definition.steps,
    step.from,
    connection.fields,
  );
  const request = await openFeatureRequest(ctx, {
    run,
    stepId: step.id,
    attempt,
    connection: { id: connection.id, label: connection.label },
    reportId,
    number,
    title,
    organization,
    assessment,
    agent,
    signature,
    canBuild: step.build,
  });
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'waiting',
      inputSummary: `Asked you about feature request #${number}`,
      output: { requestId: request.id, decided: false },
      ...(request.messageId ? { messageIds: [request.messageId] } : {}),
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'waiting', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
}
