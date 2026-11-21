/**
 * The assessor's MCP tools (docs/decisions/feedback.md FB-21, FB-22): `submit_assessment` records the assessment of
 * the report the calling dispatch assesses, `feedback_similar_reports` lists other reports of the same website in the
 * same channel, and `reply_in_thread` (in a `feedback` dispatch) posts in the report thread only, inert. The MCP
 * server lists and allows these (plus `read_attachment`) only for a dispatch with trigger `feedback`.
 */
import { FEEDBACK_SIMILAR_EXCERPT, FEEDBACK_SIMILAR_MAX } from '@whombat/core';
import { conflict, forbidden } from '../lib/errors';
import { iso } from '../lib/time';
import { type ToolContext, type ToolHandler, toOutcome } from '../mcp/tools';
import {
  type AssessmentProblem,
  AssessmentRefused,
  assessorReply,
  recordAssessment,
  refusedError,
  reportOfDispatch,
  settleAssessment,
  similarReports,
} from './assessment';
import { assessorBrowsed } from './browser';
import { feedbackPrincipal } from './principal';

function options(ctx: ToolContext) {
  return { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf };
}

function requireFeedback(ctx: ToolContext): void {
  if (ctx.dispatch.trigger !== 'feedback')
    throw forbidden('This tool is only available while assessing a report.');
}

export const submitAssessmentTool: ToolHandler<'submit_assessment'> = async (ctx, input) => {
  requireFeedback(ctx);
  try {
    // Whether it opened pages of the reported website in its browser (FB-28, HE-S140): what it saw there counts as
    // reproduced. Hermes's browser attaches no screenshots of its own.
    const screenshots: string[] = [];
    const browsed = await assessorBrowsed(ctx.services.db, ctx.dispatch.id);
    const res = await ctx.services.pipeline.commit(
      recordAssessment,
      { dispatchId: ctx.dispatch.id, assessment: input, screenshots, browsed },
      options(ctx),
    );
    return toOutcome(res, (r) => ({ reportId: r.reportId, messageId: r.messageId }));
  } catch (err) {
    // Whombat refused the assessment after its start (review-2 F5): nothing was recorded; the report leaves `running`
    // with the reason (as the Feedback principal, compare-and-set on this dispatch) and the turn is stopped.
    if (err instanceof AssessmentRefused) await refuseRunning(ctx, err.problem);
    throw err;
  }
};

async function refuseRunning(ctx: ToolContext, problem: AssessmentProblem): Promise<void> {
  const report = await reportOfDispatch(ctx.services.db, ctx.dispatch.id);
  if (report?.assessmentState !== 'running') return;
  const actorId = await feedbackPrincipal(ctx.services, ctx.burrowId);
  await ctx.services.pipeline.commit(
    settleAssessment,
    {
      reportId: report.id,
      dispatchId: ctx.dispatch.id,
      reason: problem.reason.slice(0, 600),
      outcome: problem.outcome,
      cancelDispatch: true,
      cancelError: refusedError(problem),
    },
    { burrowId: ctx.burrowId, actorId },
  );
}

export const similarReportsTool: ToolHandler<'feedback_similar_reports'> = async (ctx, input) => {
  requireFeedback(ctx);
  const report = await reportOfDispatch(ctx.services.db, ctx.dispatch.id);
  if (report?.assessmentState !== 'running')
    throw conflict('This turn isn’t the report’s current assessment any more.');
  const rows = await similarReports(ctx.services.db, report, input.query, FEEDBACK_SIMILAR_MAX);
  return {
    status: 'ok',
    reports: rows.map((r) => {
      const flat = r.description.replace(/\s+/g, ' ').trim();
      return {
        reference: r.reference,
        type: r.type,
        status: r.status,
        assessment: r.assessmentState,
        outcome: r.assessmentState === 'done' ? (r.assessment?.outcome ?? null) : null,
        excerpt:
          flat.length > FEEDBACK_SIMILAR_EXCERPT ? `${flat.slice(0, FEEDBACK_SIMILAR_EXCERPT - 1)}…` : flat,
        receivedAt: iso(r.createdAt),
      };
    }),
  };
};

/** `reply_in_thread` in a feedback dispatch: the report thread only, no mentions, no dispatch. */
export const assessorReplyTool: ToolHandler<'reply_in_thread'> = async (ctx, input) => {
  requireFeedback(ctx);
  if (input.attachmentIds?.length) throw forbidden('You can’t attach files while assessing a report.');
  const res = await ctx.services.pipeline.commit(
    assessorReply,
    { dispatchId: ctx.dispatch.id, messageId: input.messageId, text: input.text },
    options(ctx),
  );
  return toOutcome(res, (r) => ({ messageId: r.id }));
};
