/**
 * The assessment of a report through the commit pipeline (docs/decisions/feedback.md FB-20 … FB-23).
 *
 * - `feedback.start_assessment` (the burrow's Feedback principal, from the worker): under the burrow lock, re-reads a
 *   queued report and revalidates its **intake snapshot** (never the current configuration). Anything revoked →
 *   `blocked` with the reason; the integration paused or out of budget → `paused` / waits; otherwise one attempt row,
 *   the prompt message in the report thread, a `dispatches` row with trigger `feedback` (queued for nobody: an
 *   outsiders' turn, one-person.md OP-S41) and `running`, all in one transaction (a crash leaves both or neither).
 * - `feedback.settle_assessment` (Feedback principal): a running attempt whose dispatch ended without an assessment,
 *   failed, was refused or ran out of time becomes `failed` with the reason. Compare-and-set on the dispatch id.
 * - `feedback.record_assessment` (the assessing agent, `submit_assessment`): only for the report's current dispatch,
 *   once; the assessor's reply goes in the thread as inert text with the `assessment` card (verdict, decision and the
 *   full assessment, FB-32).
 * - `feedback.assessor_reply` (the assessing agent, `reply_in_thread` in a feedback dispatch): the report thread only,
 *   no mentions, never a dispatch.
 * - `feedback.retry_assessment` (the person, in the report's channel): `failed` / `blocked` (or `paused` while
 *   assessment is active) → `queued`; revalidation happens again at start.
 */
import {
  FEEDBACK_MAX_ASSESSMENT_ATTEMPTS,
  type FeedbackAssessment,
  FeedbackAssessmentSubmission,
  FeedbackReportId,
  newId,
  splitSubmission,
} from '@whombat/core';
import { and, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, min, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  attachments,
  dispatches,
  feedbackAssessments,
  feedbackIntegrations,
  feedbackReports,
  messages as messagesTable,
  repos,
} from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { linkAttachments } from '../files/commands';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { agentRuntimeOf, loadAgentRow, loadPrincipalRow } from '../read/principals';
import { publishDispatch } from '../runtime/activity';
import { destinationLabel, destinationOf } from './chat';
import { isFeedbackPrincipal } from './principal';
import { assessmentHash, inertReply } from './render';
import { reportChanged } from './reporters';
import { type AgentProblem, agentProblem, personHere, repoEnabled } from './rules';

export type ReportRow = typeof feedbackReports.$inferSelect;
export type AttemptRow = typeof feedbackAssessments.$inferSelect;

const DAY_MS = 24 * 3_600_000;

export const BUDGET_WAIT_REASON = 'Waiting for today’s assessment budget.';
export const BUDGET_ZERO_REASON =
  'Automatic assessment is off for this integration: its daily assessment budget is 0.';
export const PAUSED_REASON = 'Assessment is paused for this integration.';
export const NO_SUBMISSION_REASON = 'The agent finished without submitting an assessment.';
export const STOPPED_REASON = 'The assessment was stopped before the agent submitted one.';
export const timeoutReason = (minutes: number) => `The assessment took longer than ${minutes} minutes.`;
/** `dispatches.error` of a turn the worker stopped at its deadline. */
export const TIMEOUT_ERROR = 'feedback_timeout';
/**
 * How long a started assessment may wait for a runner to claim its turn (review-2 F6). `assessmentTimeoutMinutes`
 * counts from the claim, so a turn queued behind the same agent's other turns in the channel isn't failed for time it
 * never ran; one no runner takes at all fails after this, with its own reason.
 */
export const QUEUE_DEADLINE_MS = 12 * 3_600_000;
export const QUEUE_TIMEOUT_REASON = 'No runner started the assessment within 12 hours.';
/** `dispatches.error` of a turn the worker stopped because no runner claimed it in time. */
export const QUEUE_TIMEOUT_ERROR = 'feedback_queue_timeout';

/** Where a running assessment goes when Whombat itself refuses it after its start (review-2 F5). */
export type RefusedOutcome = 'blocked' | 'paused';

/** Why a running assessment may not go on now, and where its report goes (review-2 F5). */
export interface AssessmentProblem {
  outcome: RefusedOutcome;
  reason: string;
}

/** `dispatches.error` of an assessment turn Whombat refused after its start: `feedback_refused:<outcome>:<reason>`. */
const REFUSED_PREFIX = 'feedback_refused:';

export function refusedError(problem: AssessmentProblem): string {
  return `${REFUSED_PREFIX}${problem.outcome}:${problem.reason}`.slice(0, 2000);
}

export function parseRefusedError(error: string | null | undefined): AssessmentProblem | null {
  if (!error?.startsWith(REFUSED_PREFIX)) return null;
  const rest = error.slice(REFUSED_PREFIX.length);
  const at = rest.indexOf(':');
  const outcome = rest.slice(0, at);
  if (outcome !== 'blocked' && outcome !== 'paused') return null;
  return { outcome, reason: rest.slice(at + 1) };
}

/**
 * Whombat refuses a running assessment (review-2 F5): thrown while building its turn's context (the claim fails the
 * dispatch, so no runner ever gets the report) and by `feedback.record_assessment` (nothing is recorded). Either way
 * the report then leaves `running` with the reason — `blocked`, or `paused` when the integration was paused.
 */
export class AssessmentRefused extends ApiError {
  constructor(readonly problem: AssessmentProblem) {
    super('conflict', `Nothing was recorded: ${problem.reason}`);
    this.name = 'AssessmentRefused';
  }
}

/**
 * Why a failed assessment dispatch failed, in plain words for the report (FB-23): the runtime's error code (a queued
 * turn no runner could take, a runner that stopped answering twice) or the runner's refusal (the turn can't be kept
 * read-only on this host).
 */
export function failureReason(error: string | null, refusal: string | null): string {
  if (error?.startsWith('unrunnable:')) {
    switch (error.slice('unrunnable:'.length)) {
      case 'no_runner':
        return 'No agent runner is running on the host, so nothing could run the assessment.';
      case 'provider':
        return 'The agent’s AI provider isn’t set up on this Whombat, so the assessment couldn’t run.';
      case 'engine':
        return 'Part of this Whombat didn’t start, so the assessment couldn’t run.';
      case 'local':
        return 'The agent’s model on your network isn’t set up, so the assessment couldn’t run.';
      default:
        return 'The agent isn’t connected to Claude Code or ChatGPT, so the assessment couldn’t run.';
    }
  }
  if (refusal) return `The runner refused the assessment: ${refusal}`.slice(0, 600);
  if (error === 'lease_expired')
    return 'The agent’s runner stopped responding during the assessment, and again when it was retried.';
  if (error?.startsWith('context:')) return 'Whombat couldn’t prepare the assessment turn.';
  return `The agent’s turn failed${error ? `: ${error.slice(0, 200)}` : '.'}`;
}

/**
 * Whether the assessor's turn can run commands (FB-21): only a Codex turn, whose read-only OS sandbox runs commands
 * with the scrubbed environment and no network inside the disposable export. A Claude read-only turn only has Read,
 * Grep and Glob; the scripted provider has no shell. Planned at start, planned again from the agent's current runtime
 * when the turn's context is built (review-2 F4). Every turn runs in the runner's sandbox (hermes-engine.md HE-12), so
 * the plan is what the turn could do (`effectiveCanExecute`).
 */
export function canExecuteFor(provider: string): boolean {
  return provider === 'codex';
}

/** What the turn could really do: as planned when its context was built, in the runner's sandbox (HE-12, review-2 F4). */
export function effectiveCanExecute(attempt: Pick<AttemptRow, 'canExecute'>) {
  return attempt.canExecute;
}

async function assertFeedbackActor(tx: Tx, ctx: ApplyContext): Promise<void> {
  const actor = await loadPrincipalRow(tx, ctx.actor.id);
  if (!isFeedbackPrincipal(actor) || actor?.burrowId !== ctx.burrow.id)
    throw forbidden('Only Whombat Feedback runs assessments.');
}

async function lockReport(tx: Tx, burrowId: string, reportId: string): Promise<ReportRow | null> {
  const [row] = await tx.select().from(feedbackReports).where(eq(feedbackReports.id, reportId)).for('update');
  return row && row.burrowId === burrowId ? row : null;
}

async function whereOf(tx: Tx, conversationId: string): Promise<string> {
  const conv = await loadConversationRow(tx, conversationId);
  return conv ? destinationLabel(conv) : 'Feedback';
}

/**
 * The line that starts an assessment in the report's thread (fixed text, by the Feedback principal; the dispatch is
 * anchored to it). In a channel it asks the agent by name, as before; in a chat with the person's assistant it says in
 * plain words that the assistant is on it — instructions go to the agent, not into the chat (LM-F07, concise-replies).
 */
export function assessmentKickoff(
  agent: { id: string; name: string },
  reference: string,
  inChat: boolean,
): { text: string; mentions: string[] } {
  return inChat
    ? { text: `${agent.name} is having a look.`, mentions: [] }
    : { text: `@${agent.name} Please assess ${reference} (read-only).`, mentions: [agent.id] };
}

/** A short notice by the Feedback principal in the report thread (fixed text; no mentions, no dispatch). */
async function threadNotice(ctx: ApplyContext, report: ReportRow, text: string): Promise<void> {
  const conversation = await loadConversationRow(ctx.tx, report.conversationId);
  if (!conversation) return;
  await postMessage(ctx, {
    conversation,
    text,
    threadRootId: report.rootMessageId,
    mentions: [],
    dispatch: false,
  });
}

// --- Start ---------------------------------------------------------------------------------------------------

/** Why an intake snapshot no longer authorizes an assessment (FB-20), or null. */
async function snapshotProblem(
  tx: Db,
  report: ReportRow,
): Promise<{ reason: string; agentId: string | null } | null> {
  const snap = report.intake;
  const burrowId = report.burrowId;
  // The Whombat's agent assesses (one-agent.md OA-16).
  const agent = await loadAgentRow(tx, burrowId);
  if (!agent) return { reason: 'This Whombat has no agent to assess the report.', agentId: null };
  const agentName = agent.name;
  const channel = await destinationOf(tx, burrowId, snap.conversationId, report.integrationId);
  if (!channel || channel.id !== report.conversationId) {
    const sent = await loadConversationRow(tx, report.conversationId);
    return {
      reason:
        sent?.kind === 'dm'
          ? 'The chat this report was sent to is closed.'
          : 'The room this report was sent to is gone.',
      agentId: agent.id,
    };
  }
  if (!(await personHere(tx, burrowId, snap.configuredById))) {
    const saver = await loadPrincipalRow(tx, snap.configuredById);
    return {
      reason: `${saver?.name ?? 'The person who set this integration up'} isn’t on this Whombat any more, so the assessment set up under their authority can’t run. Save the integration again, then Retry.`,
      agentId: agent.id,
    };
  }
  const problem = await agentProblem(tx, burrowId, agent.id, { assessor: true });
  if (problem) return { reason: agentBlockedText(problem, agentName), agentId: agent.id };
  if (snap.repoId && !(await repoEnabled(tx, burrowId, snap.repoId))) {
    const [repo] = await tx.select({ fullName: repos.fullName }).from(repos).where(eq(repos.id, snap.repoId));
    return {
      reason: `The repository ${repo?.fullName ?? `${agentName} was to read`} is switched off for ${agentName}.`,
      agentId: agent.id,
    };
  }
  return null;
}

/**
 * The start's revalidation again, for an assessment that is already running (review-2 F5): when its turn's context
 * is built and when it records its result. The integration gone or its content removed, or the intake snapshot no
 * longer authorized (the person who configured it, the agent — guarded, on Claude, Codex or scripted, in the channel — and
 * the repo) → `blocked`; the integration paused → `paused`. So the server itself refuses a trusted or ACP assessor,
 * whatever the runner does. Null: it may go on.
 */
export async function runningAssessmentProblem(db: Db, report: ReportRow): Promise<AssessmentProblem | null> {
  const [integration] = await db
    .select({ assessment: feedbackIntegrations.assessment })
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.id, report.integrationId));
  if (!integration)
    return { outcome: 'blocked', reason: 'The feedback integration this report came through is gone.' };
  if (report.contentRemovedAt)
    return { outcome: 'blocked', reason: 'The report’s content was removed, so there is nothing to assess.' };
  if (integration.assessment === 'paused') return { outcome: 'paused', reason: PAUSED_REASON };
  const problem = await snapshotProblem(db, report);
  return problem ? { outcome: 'blocked', reason: problem.reason } : null;
}

function agentBlockedText(problem: AgentProblem, name: string): string {
  switch (problem) {
    case 'agent_missing':
      return 'The assessment agent isn’t on this Whombat any more.';
    case 'agent_not_eligible':
      return `Only ${name} can assess reports, not Whombat’s own signers.`;
    case 'agent_unsupported_provider':
      return `${name} isn’t on Claude or ChatGPT any more: an ACP runtime can’t be kept read-only.`;
  }
}

export type StartOutcome =
  | { outcome: 'started'; dispatchId: string; assessmentId: string }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'paused'; reason: string }
  | { outcome: 'waiting'; until: string }
  | { outcome: 'busy' }
  | { outcome: 'skipped' };

export const startAssessment = defineCommand({
  name: 'feedback.start_assessment',
  schema: z.object({
    reportId: FeedbackReportId,
    /** The worker's lease on the report (its expiry); only the holder may start it. */
    lease: z.string().datetime({ offset: true }).nullable(),
  }),
  async apply(tx, ctx, input): Promise<StartOutcome> {
    await assertFeedbackActor(tx, ctx);
    const report = await lockReport(tx, ctx.burrow.id, input.reportId);
    if (report?.assessmentState !== 'queued') return { outcome: 'skipped' };
    const held = report.assessmentLeaseExpiresAt?.toISOString() ?? null;
    if (input.lease !== null && held !== new Date(input.lease).toISOString()) return { outcome: 'skipped' };
    if (report.assessmentNotBefore && report.assessmentNotBefore > ctx.now) return { outcome: 'skipped' };

    const [integration] = await tx
      .select()
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.id, report.integrationId))
      .for('update');

    const where = await whereOf(tx, report.conversationId);
    const settle = async (
      state: 'paused' | 'queued',
      reason: string | null,
      notBefore: Date | null = null,
    ) => {
      await tx
        .update(feedbackReports)
        .set({
          assessmentState: state,
          assessmentReason: reason,
          assessmentNotBefore: notBefore,
          assessmentLeaseExpiresAt: null,
          assessmentUpdatedAt: ctx.now,
          updatedAt: ctx.now,
        })
        .where(eq(feedbackReports.id, report.id));
    };

    if (integration?.assessment === 'paused') {
      await settle('paused', PAUSED_REASON);
      await reportChanged(ctx, [report.rootMessageId]);
      return { outcome: 'paused', reason: PAUSED_REASON };
    }

    // Revalidation against the intake snapshot (FB-20). Content removed or anything revoked: blocked.
    const assessor = (await loadAgentRow(tx, report.burrowId))?.id ?? null;
    const problem = !integration
      ? { reason: 'The feedback integration this report came through is gone.', agentId: assessor }
      : report.contentRemovedAt
        ? { reason: 'The report’s content was removed, so there is nothing to assess.', agentId: assessor }
        : await snapshotProblem(tx, report);
    const attempt = report.assessmentAttempts + 1;
    if (problem || !integration) {
      const reason = problem?.reason ?? 'The feedback integration this report came through is gone.';
      const assessmentId = newId('feedbackAssessment');
      if (problem?.agentId)
        await tx.insert(feedbackAssessments).values({
          id: assessmentId,
          burrowId: report.burrowId,
          reportId: report.id,
          integrationId: report.integrationId,
          attempt,
          agentId: problem.agentId,
          dispatchId: null,
          state: 'blocked',
          error: reason,
          workspace: null,
          canExecute: false,
          requestedById: report.assessmentRequestedById,
          startedAt: ctx.now,
          finishedAt: ctx.now,
        });
      await tx
        .update(feedbackReports)
        .set({
          assessmentState: 'blocked',
          assessmentReason: reason,
          assessmentAttempts: problem?.agentId ? attempt : report.assessmentAttempts,
          assessmentDispatchId: null,
          assessmentLeaseExpiresAt: null,
          assessmentNotBefore: null,
          assessmentRequestedById: null,
          assessmentUpdatedAt: ctx.now,
          updatedAt: ctx.now,
        })
        .where(eq(feedbackReports.id, report.id));
      const event = await ctx.emit({
        type: 'feedback.assessment_blocked',
        kind: 'System',
        text: null,
        where,
        payload: {
          reportId: report.id,
          ...(problem?.agentId ? { assessmentId, attempt } : {}),
          agentId: problem?.agentId ?? null,
        },
      });
      await threadNotice(
        ctx,
        report,
        report.contentRemovedAt || !integration
          ? `Assessment blocked: ${reason}`
          : `Assessment blocked: ${reason} Fix it, then press Retry on the report.`,
      );
      await reportChanged(ctx, [report.rootMessageId], event.id);
      return { outcome: 'blocked', reason };
    }

    // Budget and concurrency: the integration's current limits (operational, not routing).
    const limits = integration.settings.limits;
    if (limits.assessmentsPerDay === 0) {
      await settle('paused', BUDGET_ZERO_REASON);
      await reportChanged(ctx, [report.rootMessageId]);
      return { outcome: 'paused', reason: BUDGET_ZERO_REASON };
    }
    const [running] = await tx
      .select({ n: count() })
      .from(feedbackReports)
      .where(
        and(
          eq(feedbackReports.integrationId, integration.id),
          eq(feedbackReports.assessmentState, 'running'),
        ),
      );
    if ((running?.n ?? 0) >= limits.maxConcurrentAssessments) {
      await tx
        .update(feedbackReports)
        .set({ assessmentLeaseExpiresAt: null })
        .where(eq(feedbackReports.id, report.id));
      return { outcome: 'busy' };
    }
    const since = new Date(ctx.now.getTime() - DAY_MS);
    // Attempts that got a dispatch in the last 24 h and ran, or may still run: one a runner claimed, or one still
    // running. A turn no runner ever claimed (refused at the claim, unrunnable, or past the queue deadline) cost
    // nothing and doesn't count (review-2 F6).
    const [today] = await tx
      .select({ n: count(), oldest: min(feedbackAssessments.startedAt) })
      .from(feedbackAssessments)
      .where(
        and(
          eq(feedbackAssessments.integrationId, integration.id),
          isNotNull(feedbackAssessments.dispatchId),
          gt(feedbackAssessments.startedAt, since),
          or(isNotNull(feedbackAssessments.claimedAt), eq(feedbackAssessments.state, 'running')),
        ),
      );
    if ((today?.n ?? 0) >= limits.assessmentsPerDay) {
      const until = new Date((today?.oldest ?? ctx.now).getTime() + DAY_MS + 1000);
      const changed = report.assessmentReason !== BUDGET_WAIT_REASON;
      await settle('queued', BUDGET_WAIT_REASON, until);
      if (changed) await reportChanged(ctx, [report.rootMessageId]);
      return { outcome: 'waiting', until: until.toISOString() };
    }

    // Start: the attempt, the prompt in the report thread, the dispatch, `running` (one transaction).
    const agent = await loadAgentRow(tx, report.burrowId);
    const conversation = await loadConversationRow(tx, report.conversationId);
    if (!agent || !conversation) throw conflict('The report’s room disappeared.');
    const runtime = agentRuntimeOf(agent.runtime);
    const canExecute = canExecuteFor(runtime.provider);
    let workspace: { repo: string; ref: string } | null = null;
    if (report.intake.repoId) {
      const [repo] = await tx.select().from(repos).where(eq(repos.id, report.intake.repoId));
      if (repo) workspace = { repo: repo.fullName, ref: repo.defaultBranch };
    }
    const kickoff = assessmentKickoff(agent, report.reference, conversation.kind === 'dm');
    const posted = await postMessage(ctx, {
      conversation,
      text: kickoff.text,
      threadRootId: report.rootMessageId,
      mentions: kickoff.mentions,
      dispatch: false,
    });
    const dispatchId = newId('dispatch');
    // A stranger's report: an outsiders' turn, queued for nobody (one-person.md OP-17, OP-S41).
    const [queuedTurn] = await tx
      .insert(dispatches)
      .values({
        id: dispatchId,
        burrowId: report.burrowId,
        agentId: agent.id,
        onBehalfOfAccountId: null,
        // The claim re-checks it (SUB-30): switched meanwhile onto someone else's own sign-in, the turn is refused.
        trigger: 'feedback',
        mode: 'reply',
        conversationId: conversation.id,
        messageId: posted.id,
        threadRootId: report.rootMessageId,
        state: 'queued',
        createdAt: ctx.now,
      })
      .returning();
    if (queuedTurn) publishDispatch(ctx, queuedTurn);
    await ctx.emit({
      type: 'dispatch.created',
      kind: 'System',
      text: null,
      where: null,
      aboutId: agent.id,
      payload: {
        dispatchId,
        agentId: agent.id,
        trigger: 'feedback',
        mode: 'reply',
        messageId: posted.id,
        reportId: report.id,
      },
    });
    const assessmentId = newId('feedbackAssessment');
    await tx.insert(feedbackAssessments).values({
      id: assessmentId,
      burrowId: report.burrowId,
      reportId: report.id,
      integrationId: report.integrationId,
      attempt,
      agentId: agent.id,
      dispatchId,
      state: 'running',
      error: null,
      workspace,
      canExecute,
      requestedById: report.assessmentRequestedById,
      startedAt: ctx.now,
      finishedAt: null,
    });
    await tx
      .update(feedbackReports)
      .set({
        assessmentState: 'running',
        assessmentReason: null,
        assessmentAttempts: attempt,
        assessmentDispatchId: dispatchId,
        assessmentLeaseExpiresAt: null,
        assessmentNotBefore: null,
        assessmentRequestedById: null,
        assessmentUpdatedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(feedbackReports.id, report.id));
    const event = await ctx.emit({
      type: 'feedback.assessment_started',
      kind: 'System',
      text: null,
      where,
      aboutId: agent.id,
      payload: {
        reportId: report.id,
        assessmentId,
        attempt,
        dispatchId,
        agentId: agent.id,
        repoId: report.intake.repoId,
        canExecute,
      },
    });
    await reportChanged(ctx, [report.rootMessageId], event.id);
    await ctx.services.feedback.faults.beforeAssessmentStartCommit?.();
    const services = ctx.services;
    const threadRootId = report.rootMessageId;
    ctx.after(async () => {
      services.typing.start({ conversationId: conversation.id, threadRootId, principalId: agent.id });
      services.runtime.wake();
    });
    return { outcome: 'started', dispatchId, assessmentId };
  },
});

// --- Settle (failure) ----------------------------------------------------------------------------------------

export const settleAssessment = defineCommand({
  name: 'feedback.settle_assessment',
  schema: z.object({
    reportId: FeedbackReportId,
    dispatchId: z.string(),
    reason: z.string().min(1).max(600),
    /**
     * `failed` (the turn ended without an assessment, failed or ran out of time), or Whombat refused it after its start
     * (review-2 F5): `blocked`, or `paused` for a paused integration (resuming requeues it).
     */
    outcome: z.enum(['failed', 'blocked', 'paused']).default('failed'),
    /** Stop the dispatch too (the worker's deadline, a refusal), with this `dispatches.error`. */
    cancelDispatch: z.boolean().default(false),
    cancelError: z.string().max(2000).default(TIMEOUT_ERROR),
    /**
     * The queue deadline: cancel and settle only a turn that is still queued. A runner that claimed it meanwhile
     * (after the worker read it) keeps it, and nothing is settled (review-3 F6 race).
     */
    onlyIfQueued: z.boolean().default(false),
  }),
  async apply(tx, ctx, input): Promise<{ settled: boolean }> {
    await assertFeedbackActor(tx, ctx);
    const report = await lockReport(tx, ctx.burrow.id, input.reportId);
    // Compare-and-set: only the running attempt of exactly this dispatch.
    if (report?.assessmentState !== 'running' || report.assessmentDispatchId !== input.dispatchId)
      return { settled: false };
    if (input.cancelDispatch || input.onlyIfQueued) {
      const cancelled = await tx
        .update(dispatches)
        .set({ state: 'cancelled', cancelReason: 'cancelled', error: input.cancelError, finishedAt: ctx.now })
        .where(
          and(
            eq(dispatches.id, input.dispatchId),
            // Only a turn that hasn't ended: a finished one keeps its outcome. The queue deadline: only a queued one.
            inArray(dispatches.state, input.onlyIfQueued ? ['queued'] : ['queued', 'claimed', 'running']),
          ),
        )
        .returning();
      for (const d of cancelled) publishDispatch(ctx, d);
      if (input.onlyIfQueued && cancelled.length === 0) return { settled: false };
    }
    const [attempt] = await tx
      .update(feedbackAssessments)
      .set({
        state: input.outcome === 'failed' ? 'failed' : input.outcome === 'blocked' ? 'blocked' : 'cancelled',
        error: input.reason,
        finishedAt: ctx.now,
      })
      .where(
        and(eq(feedbackAssessments.dispatchId, input.dispatchId), eq(feedbackAssessments.state, 'running')),
      )
      .returning();
    await tx
      .update(feedbackReports)
      .set({
        assessmentState: input.outcome,
        assessmentReason: input.reason,
        assessmentUpdatedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(feedbackReports.id, report.id));
    const event = await ctx.emit({
      type: `feedback.assessment_${input.outcome}`,
      kind: 'System',
      text: null,
      where: await whereOf(tx, report.conversationId),
      payload: {
        reportId: report.id,
        assessmentId: attempt?.id ?? null,
        attempt: attempt?.attempt ?? report.assessmentAttempts,
        dispatchId: input.dispatchId,
      },
    });
    const more = report.assessmentAttempts < FEEDBACK_MAX_ASSESSMENT_ATTEMPTS;
    await threadNotice(
      ctx,
      report,
      input.outcome === 'failed'
        ? `Assessment failed: ${input.reason}${more ? ' Press Retry on the report to try again.' : ''}`
        : input.outcome === 'blocked'
          ? `Assessment blocked: ${input.reason}${more ? ' Fix it, then press Retry on the report.' : ''}`
          : `Assessment paused: ${input.reason} It starts again when you resume assessment.`,
    );
    await reportChanged(ctx, [report.rootMessageId], event.id);
    const feedback = ctx.services.feedback;
    ctx.after(async () => feedback.nudge());
    return { settled: true };
  },
});

// --- The assessor's own writes (MCP, trigger `feedback`) -------------------------------------------------------

/** The live `feedback` dispatch `dispatchId` of the acting agent, or a refusal. */
async function assessorDispatch(tx: Tx, ctx: ApplyContext, dispatchId: string) {
  if (ctx.actor.kind !== 'agent') throw forbidden('Only the assessing agent does this.');
  const [d] = await tx.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!d || d.burrowId !== ctx.burrow.id || d.agentId !== ctx.actor.id || d.trigger !== 'feedback')
    throw forbidden('This is only for the agent assessing a report, in that turn.');
  if (d.state !== 'claimed' && d.state !== 'running')
    throw conflict('This assessment turn has ended, so it can’t record anything any more.');
  return d;
}

function fieldError(field: string, message: string): ApiError {
  return new ApiError('validation_failed', message, { fields: { [field]: [message] } });
}

export const recordAssessment = defineCommand({
  name: 'feedback.record_assessment',
  schema: z.object({
    dispatchId: z.string(),
    assessment: FeedbackAssessmentSubmission,
    /** Screenshots the assessor attached in this turn's browser (FB-28): the summary carries them. */
    screenshots: z.array(z.string()).max(4).default([]),
    /** The turn opened pages of the reported website (FB-28): what it saw there may count as reproduced. */
    browsed: z.boolean().default(false),
  }),
  async apply(tx, ctx, input): Promise<{ reportId: string; messageId: string; assessmentHash: string }> {
    const dispatch = await assessorDispatch(tx, ctx, input.dispatchId);
    const [report] = await tx
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.assessmentDispatchId, dispatch.id))
      .for('update');
    if (!report || report.burrowId !== ctx.burrow.id)
      throw conflict('This turn isn’t the report’s current assessment any more, so nothing was recorded.');
    if (report.assessmentState === 'done')
      throw conflict('An assessment was already recorded for this report; submit_assessment works once.');
    if (report.assessmentState !== 'running')
      throw conflict(
        `This assessment was stopped${report.assessmentReason ? `: ${report.assessmentReason}` : '.'}`,
      );
    const [attempt] = await tx
      .select()
      .from(feedbackAssessments)
      .where(
        and(eq(feedbackAssessments.dispatchId, dispatch.id), eq(feedbackAssessments.reportId, report.id)),
      )
      .for('update');
    if (attempt?.state !== 'running')
      throw conflict('An assessment was already recorded for this attempt; submit_assessment works once.');
    // The start's revalidation once more (review-2 F5): nothing is recorded for an assessment that may not go on; the
    // tool then settles the report as blocked (or paused) with the reason.
    const problem = await runningAssessmentProblem(tx, report);
    if (problem) throw new AssessmentRefused(problem);

    const split = splitSubmission(input.assessment);
    const a: FeedbackAssessment = split.assessment;
    const conclusion = split.conclusion;
    // For a bug report the assessor always answers: bug, not a bug or unsure (FB-32).
    if (report.type === 'bug' && !conclusion.bugVerdict)
      throw fieldError(
        'bugVerdict',
        'This is a bug report: set bugVerdict to bug (with observed evidence), not_a_bug or unsure.',
      );
    if (conclusion.decision?.options.some((o) => o.action === 'hand_off')) {
      const [integration] = await tx
        .select({ settings: feedbackIntegrations.settings })
        .from(feedbackIntegrations)
        .where(eq(feedbackIntegrations.id, report.integrationId));
      if (integration?.settings.handoff !== 'on')
        throw fieldError(
          'decision',
          'This integration doesn’t offer to build the fix, so hand_off can’t be offered. Use resolve, close or keep_open.',
        );
    }
    if (a.duplicateOf) {
      const [other] = await tx
        .select({
          id: feedbackReports.id,
          integrationId: feedbackReports.integrationId,
          conversationId: feedbackReports.conversationId,
        })
        .from(feedbackReports)
        .where(eq(feedbackReports.reference, a.duplicateOf));
      if (
        !other ||
        other.id === report.id ||
        other.integrationId !== report.integrationId ||
        other.conversationId !== report.conversationId
      )
        throw fieldError(
          'duplicateOf',
          `${a.duplicateOf} isn’t another report of this website that you can see. Use a reference from feedback_similar_reports, or leave duplicateOf null.`,
        );
    }
    if (a.reproduction.status === 'reproduced' && !input.browsed && !effectiveCanExecute(attempt))
      throw fieldError(
        'reproduction.status',
        'You could only inspect this time (no commands could run), so you can’t have reproduced it. Use not_attempted (or attempted_not_reproduced / unknown with what you read) and label code-reading findings as hypotheses.',
      );

    const hash = assessmentHash(a);
    await tx
      .update(feedbackAssessments)
      .set({ state: 'done', error: null, finishedAt: ctx.now })
      .where(eq(feedbackAssessments.id, attempt.id));
    await tx
      .update(feedbackReports)
      .set({
        assessment: a,
        conclusion,
        decided: null,
        assessmentState: 'done',
        assessmentReason: null,
        assessmentUpdatedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(feedbackReports.id, report.id));
    const conversation = await loadConversationRow(tx, report.conversationId);
    if (!conversation) throw notFound('Conversation');
    // The assessor's reply as inert text (no Markdown, mentions or links), as the agent, with no mentions and no
    // dispatch; the `assessment` card carries the verdict, the decision and the full assessment (FB-32).
    // The assessor's screenshots that are still its own, ready and on no message (a stale one is left out, not refused).
    const shots = input.screenshots.length
      ? await tx
          .select()
          .from(attachments)
          .where(
            and(
              inArray(attachments.id, input.screenshots),
              eq(attachments.burrowId, ctx.burrow.id),
              eq(attachments.conversationId, conversation.id),
              eq(attachments.uploadedById, ctx.actor.id),
              eq(attachments.state, 'ready'),
              isNull(attachments.messageId),
            ),
          )
          .for('update')
          .then((rows) =>
            rows.sort((x, y) => input.screenshots.indexOf(x.id) - input.screenshots.indexOf(y.id)),
          )
      : [];
    const posted = await postMessage(ctx, {
      conversation,
      text: inertReply(conclusion.reply),
      card: { kind: 'assessment', reportId: report.id },
      attachmentIds: shots.map((r) => r.id),
      threadRootId: report.rootMessageId,
      mentions: [],
      dispatch: false,
      // Rendered from what the assessor wrote (review-2 F1): other agents read it as untrusted data only.
      provenance: 'feedback_assessment',
    });
    await linkAttachments(tx, ctx, posted.id, shots);
    await tx
      .update(feedbackReports)
      .set({ assessmentMessageId: posted.id })
      .where(eq(feedbackReports.id, report.id));
    const event = await ctx.emit({
      type: 'feedback.assessment_recorded',
      kind: 'System',
      text: null,
      where: destinationLabel(conversation),
      payload: {
        reportId: report.id,
        assessmentId: attempt.id,
        attempt: attempt.attempt,
        dispatchId: dispatch.id,
        messageId: posted.id,
        assessmentHash: hash,
      },
    });
    await reportChanged(ctx, [report.rootMessageId], event.id);
    const feedback = ctx.services.feedback;
    ctx.after(async () => feedback.nudge());
    return { reportId: report.id, messageId: posted.id, assessmentHash: hash };
  },
});

/**
 * `reply_in_thread` for an assessor (FB-21): only in the report's thread, as inert plain text (`inertReply`: no
 * Markdown, links or mentions) and no mention stored, never a dispatch (so it wakes nobody), and without quick replies or “More detail” (either would let a tap
 * wake the agent outside this turn).
 */
export const assessorReply = defineCommand({
  name: 'feedback.assessor_reply',
  schema: z.object({
    dispatchId: z.string(),
    messageId: z.string(),
    text: z.string().trim().min(1).max(8000),
  }),
  async apply(tx, ctx, input): Promise<{ id: string }> {
    const dispatch = await assessorDispatch(tx, ctx, input.dispatchId);
    const [target] = await tx
      .select({
        id: messagesTable.id,
        threadRootId: messagesTable.threadRootId,
        burrowId: messagesTable.burrowId,
      })
      .from(messagesTable)
      .where(eq(messagesTable.id, input.messageId));
    const root = target ? (target.threadRootId ?? target.id) : null;
    if (!target || target.burrowId !== ctx.burrow.id || root !== dispatch.threadRootId)
      throw forbidden('While assessing a report you can only reply in the report’s thread.');
    const conversation = await loadConversationRow(tx, dispatch.conversationId);
    if (!conversation) throw notFound('Conversation');
    const posted = await postMessage(ctx, {
      conversation,
      // Inert plain text like the summary (review-2 F2): no Markdown, mention or link reaches the channel.
      text: inertReply(input.text),
      threadRootId: root,
      mentions: [],
      dispatch: false,
      // Steerable by the visitor (review-2 F1): other agents read it as untrusted data, automations ignore it.
      provenance: 'feedback_assessment',
    });
    return { id: posted.id };
  },
});

// --- Retry ---------------------------------------------------------------------------------------------------

/** The report's message was deleted (EC-04a): nothing more is posted in its thread. */
export async function reportMessageDeleted(tx: Tx, rootMessageId: string): Promise<boolean> {
  const [root] = await tx
    .select({ deletedAt: messagesTable.deletedAt })
    .from(messagesTable)
    .where(eq(messagesTable.id, rootMessageId));
  return !root || root.deletedAt !== null;
}

export const retryAssessment = defineCommand({
  name: 'feedback.retry_assessment',
  schema: z.object({ reportId: FeedbackReportId }),
  async apply(tx, ctx, input): Promise<{ reportId: string }> {
    const report = await lockReport(tx, ctx.burrow.id, input.reportId);
    if (!report) throw notFound('Report');
    if (ctx.actor.kind !== 'person') throw forbidden('Only people retry an assessment.');
    if (report.contentRemovedAt)
      throw conflict('This report’s content was removed: there is nothing to assess.');
    if (await reportMessageDeleted(tx, report.rootMessageId))
      throw conflict('This report’s message was deleted, so it isn’t assessed again.');
    const [integration] = await tx
      .select({ assessment: feedbackIntegrations.assessment })
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.id, report.integrationId));
    const retryable =
      report.assessmentState === 'failed' ||
      report.assessmentState === 'blocked' ||
      (report.assessmentState === 'paused' && integration?.assessment === 'active');
    if (!retryable)
      throw conflict(
        report.assessmentState === 'paused'
          ? 'Assessment is paused for this integration: resume it in the integration’s settings.'
          : 'Only a failed or blocked assessment can be retried.',
      );
    if (report.assessmentAttempts >= FEEDBACK_MAX_ASSESSMENT_ATTEMPTS)
      throw conflict(
        `This report was assessed ${FEEDBACK_MAX_ASSESSMENT_ATTEMPTS} times already; that is the limit.`,
      );
    await tx
      .update(feedbackReports)
      .set({
        assessmentState: 'queued',
        assessmentReason: null,
        assessmentRequestedById: ctx.actor.id,
        assessmentNotBefore: null,
        assessmentLeaseExpiresAt: null,
        assessmentUpdatedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(feedbackReports.id, report.id));
    const event = await ctx.emit({
      type: 'feedback.assessment_retried',
      kind: 'System',
      text: null,
      where: await whereOf(tx, report.conversationId),
      payload: { reportId: report.id, from: report.assessmentState, attempts: report.assessmentAttempts },
    });
    await reportChanged(ctx, [report.rootMessageId], event.id);
    const feedback = ctx.services.feedback;
    ctx.after(async () => feedback.nudge());
    return { reportId: report.id };
  },
});

// --- Reads for the assessor ------------------------------------------------------------------------------------

/** The report a live feedback dispatch assesses (null when it isn't the current one). */
export async function reportOfDispatch(db: Db, dispatchId: string) {
  const [row] = await db
    .select()
    .from(feedbackReports)
    .where(eq(feedbackReports.assessmentDispatchId, dispatchId));
  return row ?? null;
}

/**
 * Other reports of the same integration in the same channel (FB-21 `feedback_similar_reports`): references, type,
 * status, assessment and the first characters of the description. Never contact details or other integrations.
 */
export async function similarReports(db: Db, report: ReportRow, query: string | undefined, limit: number) {
  const words = (query ?? '').trim();
  const pattern = `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .select({
      reference: feedbackReports.reference,
      type: feedbackReports.type,
      status: feedbackReports.status,
      assessmentState: feedbackReports.assessmentState,
      assessment: feedbackReports.assessment,
      description: feedbackReports.description,
      createdAt: feedbackReports.createdAt,
    })
    .from(feedbackReports)
    .where(
      and(
        eq(feedbackReports.integrationId, report.integrationId),
        eq(feedbackReports.conversationId, report.conversationId),
        ne(feedbackReports.id, report.id),
        words
          ? or(ilike(feedbackReports.description, pattern), ilike(feedbackReports.reference, pattern))
          : undefined,
      ),
    )
    .orderBy(desc(feedbackReports.createdAt))
    .limit(limit);
}
