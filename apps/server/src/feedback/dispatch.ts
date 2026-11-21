/**
 * The restricted context of an assessment turn (docs/decisions/feedback.md FB-21), for `buildDispatchContext` when
 * the dispatch's trigger is `feedback`: only the report's thread (no channel window, so no other reports), the report
 * as data with the approved project context, a read-only checkout of the snapshot repo's default branch (or none),
 * no knowledge, summary or checkpoint memory and no provider session. A dispatch that is not the report's current
 * assessment gets no context at all (the claim fails it): never an unrestricted one.
 */
import { type DispatchContext, FeedbackContext, type Message } from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  approvals,
  events,
  feedbackAssessments,
  feedbackIntegrations,
  feedbackReports,
  repos,
} from '../db/schema/index';
import { loadMessage } from '../read/messages';
import { agentRuntimeOf, loadPrincipalRow } from '../read/principals';
import { threadView } from '../read/views';
import type { DispatchRow } from '../runtime/context';
import type { Services } from '../services';
import { AssessmentRefused, canExecuteFor, runningAssessmentProblem } from './assessment';

/**
 * The dispatch's assessment is already recorded (the report is `done` with it): a retry of a turn cut off after it
 * submitted (a runner restart, a lost lease) has nothing left to do. The claim ends it as done, without a turn.
 */
export class AssessmentAlreadyRecorded extends Error {
  constructor(dispatchId: string) {
    super(`feedback dispatch ${dispatchId} already recorded its assessment`);
    this.name = 'AssessmentAlreadyRecorded';
  }
}

export interface FeedbackDispatchParts {
  feedback: NonNullable<DispatchContext['feedback']>;
  trigger: DispatchContext['trigger'];
  thread: DispatchContext['thread'];
  workspace: DispatchContext['workspace'];
}

export async function feedbackDispatchParts(
  services: Services,
  row: DispatchRow,
  cloneUrl: (fullName: string) => string,
): Promise<FeedbackDispatchParts> {
  const db = services.db;
  const [found] = await db
    .select({
      report: feedbackReports,
      attempt: feedbackAssessments,
      settings: feedbackIntegrations.settings,
    })
    .from(feedbackAssessments)
    .innerJoin(feedbackReports, eq(feedbackReports.id, feedbackAssessments.reportId))
    .innerJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
    .where(and(eq(feedbackAssessments.dispatchId, row.id), eq(feedbackAssessments.burrowId, row.burrowId)));
  const report = found?.report;
  if (report?.assessmentState === 'done' && report.assessmentDispatchId === row.id)
    throw new AssessmentAlreadyRecorded(row.id);
  if (!found || !report || report.assessmentState !== 'running' || report.assessmentDispatchId !== row.id)
    throw new Error(`feedback dispatch ${row.id} is not the current assessment of a report`);
  if (
    !row.threadRootId ||
    row.threadRootId !== report.rootMessageId ||
    row.conversationId !== report.conversationId
  )
    throw new Error(`feedback dispatch ${row.id} is not in its report's thread`);
  // The start's revalidation again, now (review-2 F5): the person who set it up gone, the agent made trusted, moved to ACP or out of
  // the channel, the repo switched off, the integration paused — no context, so no runner ever gets the report; the
  // claim fails the dispatch and the report is blocked (or paused) with the reason.
  const problem = await runningAssessmentProblem(db, report);
  if (problem) throw new AssessmentRefused(problem);

  const trigger = row.messageId ? ((await loadMessage(db, row.messageId, row.agentId)) ?? null) : null;
  const view = await threadView(db, row.agentId, report.rootMessageId);
  const thread: DispatchContext['thread'] = { root: view.root, replies: view.replies };

  let workspace: DispatchContext['workspace'] = null;
  if (report.intake.repoId) {
    const [repo] = await db.select().from(repos).where(eq(repos.id, report.intake.repoId));
    if (repo?.enabled && repo.burrowId === row.burrowId)
      workspace = {
        repo: repo.fullName,
        branch: repo.defaultBranch,
        baseBranch: repo.defaultBranch,
        defaultBranch: repo.defaultBranch,
        cloneUrl: cloneUrl(repo.fullName),
        access: 'read',
        writeApproved: false,
      };
  }

  // Whether this turn can run commands, from the agent's runtime now — not as planned at start (review-2 F4): stored
  // on the attempt, which `record_assessment` checks together with the access the runner reports for this dispatch.
  const agent = await loadPrincipalRow(db, row.agentId);
  const runtime = agentRuntimeOf(agent?.runtime);
  const canExecute = canExecuteFor(runtime.provider);
  // The first claim also starts the assessment's clock (`assessmentTimeoutMinutes`, review-2 F6).
  await services.pipeline.transactAccount((tx) =>
    tx
      .update(feedbackAssessments)
      .set({
        canExecute,
        claimedAt: sql`coalesce(${feedbackAssessments.claimedAt}, ${services.clock().toISOString()}::timestamptz)`,
        // The commit this claim's runner exports is reported afresh (review-2 F9).
        workspaceCommit: null,
      })
      .where(and(eq(feedbackAssessments.id, found.attempt.id), eq(feedbackAssessments.state, 'running'))),
  );

  const removed = report.contentRemovedAt !== null;
  return {
    trigger,
    thread,
    workspace,
    feedback: {
      reportId: report.id,
      reference: report.reference,
      type: report.type,
      productLabel: found.settings.productLabel,
      submitted: {
        description: report.description,
        expected: report.expected,
        steps: report.steps,
        context: report.context ?? FeedbackContext.parse({}),
        reporterGiven: !!(report.reporterName || report.reporterEmail),
        screenshots: report.attachmentIds.length,
        contentRemoved: removed,
      },
      projectContext: report.intake.projectContext,
      attempt: found.attempt.attempt,
      canExecute,
    },
  };
}

/**
 * The developer agent's side of an approved handoff (FB-24, review-2 F1): for a dispatch whose trigger is the handoff
 * message (`provenance: feedback_handoff`) — the one `feedback.start_handoff` posted, as its signed
 * `feedback.handoff_started` event records, in this report's thread, for exactly this agent — the report and its
 * validated assessment as data. Null for anything else (a forged or copied message gets nothing).
 */
export async function feedbackHandoffPart(
  db: Db,
  row: DispatchRow,
  trigger: Message | null,
): Promise<NonNullable<DispatchContext['feedbackHandoff']> | null> {
  if (trigger?.provenance !== 'feedback_handoff' || !row.threadRootId) return null;
  const [started] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.burrowId, row.burrowId),
        eq(events.type, 'feedback.handoff_started'),
        sql`${events.payload}->>'messageId' = ${trigger.id}`,
      ),
    )
    .limit(1);
  const payload = started?.payload as
    | { reportId?: string; approvalId?: string; handoffAgentId?: string }
    | undefined;
  if (!payload?.reportId || !payload.approvalId || payload.handoffAgentId !== row.agentId) return null;
  const [found] = await db
    .select({ report: feedbackReports, settings: feedbackIntegrations.settings })
    .from(feedbackReports)
    .innerJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
    .where(and(eq(feedbackReports.id, payload.reportId), eq(feedbackReports.burrowId, row.burrowId)));
  const report = found?.report;
  if (!found || !report?.assessment || report.rootMessageId !== row.threadRootId) return null;
  const [approval] = await db
    .select({ number: approvals.number, requesterId: approvals.requesterId, command: approvals.command })
    .from(approvals)
    .where(eq(approvals.id, payload.approvalId));
  if (!approval) return null;
  const commit = await assessedCommit(db, report);
  const [repo] = report.intake.repoId
    ? await db.select({ fullName: repos.fullName }).from(repos).where(eq(repos.id, report.intake.repoId))
    : [];
  const note = approval.command?.input.note;
  return {
    reportId: report.id,
    reference: report.reference,
    type: report.type,
    productLabel: found.settings.productLabel,
    approvalNumber: approval.number,
    requestedById: approval.requesterId,
    note: typeof note === 'string' ? note : '',
    submitted: {
      description: report.description,
      expected: report.expected,
      steps: report.steps,
      context: report.context ?? FeedbackContext.parse({}),
      reporterGiven: !!(report.reporterName || report.reporterEmail),
      screenshots: report.attachmentIds.length,
      contentRemoved: report.contentRemovedAt !== null,
    },
    assessment: report.assessment,
    repo: repo?.fullName ?? null,
    commit: commit.sha ? { sha: commit.sha, verified: commit.verified } : null,
  };
}

/**
 * The code a recorded assessment read (review-2 F9): the commit its runner reported exporting for the attempt that
 * recorded it (`verified`), else — a runner that didn't report one — the revision the assessor wrote itself, marked
 * unverified. A handoff binds exactly this.
 */
export async function assessedCommit(
  db: Db,
  report: Pick<typeof feedbackReports.$inferSelect, 'id' | 'assessment'>,
): Promise<{ sha: string | null; verified: boolean }> {
  const [attempt] = await db
    .select({ workspaceCommit: feedbackAssessments.workspaceCommit })
    .from(feedbackAssessments)
    .where(and(eq(feedbackAssessments.reportId, report.id), eq(feedbackAssessments.state, 'done')))
    .orderBy(desc(feedbackAssessments.attempt))
    .limit(1);
  if (attempt?.workspaceCommit) return { sha: attempt.workspaceCommit, verified: true };
  return { sha: report.assessment?.revision.inspected ?? null, verified: false };
}
