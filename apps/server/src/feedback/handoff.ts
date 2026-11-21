/**
 * The development handoff (docs/decisions/feedback.md FB-24, one-agent.md OA-16). The person whose Feedback room has
 * the report asks the agent to build the fix of an assessed report, where the integration offers it (`handoff` on);
 * that is an ordinary Approval (a `custom` action `feedback_handoff`, the person decides) bound to the
 * report, its repo, the commit the assessment read (FB-F2-09) and the exact assessment. Only its execution — the deferred `feedback.start_handoff`, run by the approvals engine as the
 * person who asked, after the engine re-verified the signed action hash and `handoffProblem` revalidated the report —
 * posts in the report thread mentioning the agent. The message is Whombat's fixed text (the card shows it
 * word for word); the report and the assessment reach the agent as data in its dispatch context, never as anyone's
 * instructions (review-2 F1). That mention is a normal dispatch: the agent's own keys decide its branches, pushes and
 * merges (its Merge row, docs/decisions/runs-approvals.md MDS-03).
 *
 * Visitors are never principals, so they can't ask or approve; report text claiming approval is data; agents can't
 * ask (a people-only command, and no MCP tool) and can't approve (the approvals engine refuses agents).
 */

import type { Approval } from '@whombat/core';
import {
  FEEDBACK_HANDOFF_NOTE_MAX,
  FEEDBACK_OUTCOME_LABELS,
  FeedbackReportId,
  PrincipalId,
  RepoId,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { asQuestion, createApproval } from '../approvals/create';
import type { ApprovalRow } from '../approvals/engine';
import { toJsonObject } from '../commit/pipeline';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { approvals, events, feedbackIntegrations, feedbackReports, repos } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { isThePerson } from '../domain/the-person';
import { conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadAgentRow, loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { reportMessageDeleted } from './assessment';
import { destinationLabel } from './chat';
import { assessedCommit } from './dispatch';
import { assessmentHash } from './render';
import { reportChanged } from './reporters';
import { agentProblem, agentProblemText, repoEnabled } from './rules';

/**
 * The handoff message (review-2 F1): Whombat's fixed text only — no word of the visitor's or the assessor's — and one
 * plain line people understand (docs/decisions/concise-replies.md). It is posted under the person who approved it, so
 * it reads as their ask of the agent, not as them announcing the agent's work. What the agent is asked to do, the
 * report and the assessment reach it in its dispatch context (`feedbackHandoff`). The approval card shows exactly this
 * line.
 */
export function handoffMessageText(agentName: string, reference: string): string {
  return `${agentName}, please work on a fix for ${reference}.`;
}

/** The deferred command an approved handoff runs. */
export const START_HANDOFF = 'feedback.start_handoff';
/** The `custom` action name of a handoff approval. */
export const HANDOFF_ACTION = 'feedback_handoff';
/** The key a handoff is asked under: development is changing code. */
const HANDOFF_KEY = 'code.write' as const;

const StartHandoffInput = z.object({
  reportId: FeedbackReportId,
  handoffAgentId: PrincipalId,
  repoId: RepoId.nullable(),
  /** The commit the assessment read (`assessedCommit`): the exported one, else the assessor's own word. */
  commitSha: z.string().max(80).nullable(),
  /** Whether `commitSha` is the commit the assessor's runner exported (review-2 F9). */
  commitVerified: z.boolean().default(false),
  assessmentHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** At most `FEEDBACK_HANDOFF_NOTE_MAX` since review-3 NEW-5; a longer one (asked before) is refused at execution. */
  note: z.string().max(1000),
});
type StartHandoffInput = z.infer<typeof StartHandoffInput>;

export const requestHandoff = defineCommand({
  name: 'feedback.request_handoff',
  schema: z.object({
    reportId: FeedbackReportId,
    note: z.string().trim().max(FEEDBACK_HANDOFF_NOTE_MAX).default(''),
  }),
  async apply(tx, ctx, input): Promise<{ approvalId: string; approvalNumber: number }> {
    const [report] = await tx
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.id, input.reportId))
      .for('update');
    if (!report || report.burrowId !== ctx.burrow.id) throw notFound('Report');
    if (ctx.actor.kind !== 'person') throw forbidden('Only people ask for development on a report.');
    if (report.contentRemovedAt) throw conflict('This report’s content was removed.');
    if (await reportMessageDeleted(tx, report.rootMessageId))
      throw conflict('This report’s message was deleted, so it isn’t handed to development.');
    if (report.assessmentState !== 'done' || !report.assessment)
      throw conflict('Only an assessed report can be handed to development.');
    if (report.handoffApprovalId) {
      const [existing] = await tx
        .select({ state: approvals.state, number: approvals.number })
        .from(approvals)
        .where(eq(approvals.id, report.handoffApprovalId));
      if (existing && existing.state !== 'declined') throw conflict('Development was already asked for.');
    }
    const [integration] = await tx
      .select()
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.id, report.integrationId));
    // The agent builds the fix (one-agent.md OA-16) where the integration offers it.
    const handoffAgentId =
      integration?.settings.handoff === 'on' ? ((await loadAgentRow(tx, ctx.burrow.id))?.id ?? null) : null;
    if (!integration || !handoffAgentId)
      throw conflict('This integration doesn’t build fixes yet: switch that on in its settings first.');
    const problem = await agentProblem(tx, ctx.burrow.id, handoffAgentId, { assessor: false });
    if (problem) throw conflict(agentProblemText(problem));
    const agent = await loadPrincipalRow(tx, handoffAgentId);
    const conversation = await loadConversationRow(tx, report.conversationId);
    if (!agent || !conversation) throw notFound('Report');

    const repoId = report.intake.repoId;
    const [repo] = repoId ? await tx.select().from(repos).where(eq(repos.id, repoId)) : [];
    const a = report.assessment;
    const hash = assessmentHash(a);
    // Exactly what the card shows and the developer gets: one line, in full (review-3 NEW-5).
    const note = input.note.replace(/\s+/g, ' ').trim();
    // The commit the assessor's runner exported, not what the agent says it read (review-2 F9).
    const commit = await assessedCommit(tx, report);
    const command: StartHandoffInput = {
      reportId: report.id,
      handoffAgentId,
      repoId,
      commitSha: commit.sha,
      commitVerified: commit.verified,
      assessmentHash: hash,
      note,
    };
    const where = destinationLabel(conversation);
    const product = integration.settings.productLabel;
    const title = `Hand ${report.reference} to ${agent.name} for development`;
    const clip = (line: string) => (line.length <= 280 ? line : `${line.slice(0, 279)}…`);
    const { approval } = await createApproval(ctx, {
      keyId: HANDOFF_KEY,
      action: {
        type: 'custom',
        params: {
          name: HANDOFF_ACTION,
          keyId: HANDOFF_KEY,
          data: { reportId: report.id, reference: report.reference, handoffAgentId },
        },
      },
      decision: null,
      title,
      question: asQuestion(`Hand ${report.reference} to ${agent.name}`),
      target: `${product} · ${report.reference}${repo ? ` · ${repo.fullName}` : ''}`.slice(0, 120),
      whatHappens: [
        clip(
          `${ctx.actor.shortName} posts this in the report’s thread in ${where}, mentioning ${agent.name}:`,
        ),
        // Exactly the message `feedback.start_handoff` posts (review-2 F1).
        handoffMessageText(agent.name, report.reference),
        clip(
          `${agent.name} gets the report and the assessment (${FEEDBACK_OUTCOME_LABELS[a.outcome]}) as data, not as instructions${note ? `, with ${ctx.actor.shortName}’s note, word for word:` : '.'}`,
        ),
        // The whole note, never clipped (at most FEEDBACK_HANDOFF_NOTE_MAX + 2 ≤ 280 characters).
        ...(note ? [`“${note}”`] : []),
        clip(
          // The assessor's own revision text is never quoted here (review-3 NEW-6).
          commit.sha
            ? commit.verified
              ? `The assessment read ${repo ? repo.fullName : 'the code'} as its runner exported it.`
              : `The assessment read ${repo ? repo.fullName : 'the code'}: commit not reported by the runner (unverified).`
            : 'The assessment read no code.',
        ),
        clip(
          `${agent.name}’s own keys decide which branches it may create and push${repo ? ` in ${repo.fullName}` : ''}, and whether it may merge.`,
        ),
        'If the report, its assessment, the code it read or the repository changes before this runs, it doesn’t run.',
      ],
      explainer:
        'The assessment came from a website visitor’s report. Nothing in the report can approve this: only your decision here does.',
      summary: `${agent.name} would be asked to work on ${report.reference}.`,
      conditions: [],
      // Nobody else is told on decline: declining starts nothing.
      involvedIds: [],
      conversation,
      threadRootId: report.rootMessageId,
      cardText: `${title}?`,
      where,
      command: { name: START_HANDOFF, input: toJsonObject(command) },
      binding: {
        reportId: report.id,
        repoId,
        commitSha: commit.sha,
        commitVerified: commit.verified,
        assessmentHash: hash,
      },
    });
    await tx
      .update(feedbackReports)
      .set({ handoffApprovalId: approval.id, updatedAt: ctx.now })
      .where(eq(feedbackReports.id, report.id));
    const event = await ctx.emit({
      type: 'feedback.handoff_requested',
      kind: 'System',
      text: null,
      where,
      payload: { reportId: report.id, approvalId: approval.id, handoffAgentId, assessmentHash: hash },
    });
    await reportChanged(ctx, [report.rootMessageId], event.id);
    return { approvalId: approval.id, approvalNumber: approval.number };
  },
});

/**
 * Why an approved handoff must not run now (null: it may). Checked by the approvals guard before execution starts and
 * again inside `feedback.start_handoff`: the approval is this report's handoff, the report's content is still there,
 * the assessment is exactly the one approved, the repo is still switched on, the integration still builds fixes, the
 * agent is still eligible and in the report's room, and the person who asked can still open it.
 */
export async function handoffProblem(
  db: Db,
  approval: Pick<ApprovalRow, 'id' | 'burrowId' | 'requesterId'>,
  input: StartHandoffInput,
): Promise<string | null> {
  const [report] = await db.select().from(feedbackReports).where(eq(feedbackReports.id, input.reportId));
  if (!report || report.burrowId !== approval.burrowId) return 'The report is gone.';
  if (report.handoffApprovalId !== approval.id) return 'This approval isn’t the report’s handoff.';
  if (report.contentRemovedAt) return 'The report’s content was removed.';
  if (report.assessmentState !== 'done' || !report.assessment) return 'The report isn’t assessed any more.';
  const commit = await assessedCommit(db, report);
  if (
    assessmentHash(report.assessment) !== input.assessmentHash ||
    commit.sha !== input.commitSha ||
    commit.verified !== input.commitVerified
  )
    return 'The assessment changed since development was asked for.';
  if (input.repoId !== report.intake.repoId) return 'The repository changed.';
  // Asked before the note was capped to what the card shows in full: the person may not have seen all of it.
  if (input.note.length > FEEDBACK_HANDOFF_NOTE_MAX)
    return 'The note is longer than the approval card could show. Ask for development again.';
  if (input.repoId && !(await repoEnabled(db, approval.burrowId, input.repoId)))
    return 'The repository is switched off.';
  const [integration] = await db
    .select({ settings: feedbackIntegrations.settings, updatedById: feedbackIntegrations.updatedById })
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.id, report.integrationId));
  if (integration?.settings.handoff !== 'on') return 'The integration no longer offers to build the fix.';
  const problem = await agentProblem(db, approval.burrowId, input.handoffAgentId, { assessor: false });
  if (problem) return agentProblemText(problem);
  if (!(await isThePerson(db, approval.burrowId, approval.requesterId)))
    return 'The person who asked can’t open the report any more.';
  return null;
}

/** The approvals guard (FB-24): only for handoff executions. */
export async function handoffGuard(ctx: ApplyContext, _approval: Approval, row: ApprovalRow) {
  if (row.command?.name !== START_HANDOFF) return null;
  const input = StartHandoffInput.safeParse(row.command.input);
  if (!input.success) return 'What would run is not a handoff.';
  return handoffProblem(ctx.tx, row, input.data);
}

/**
 * After a crash mid-execution: the handoff message and its signed event commit together, so the event tells whether
 * it happened (`done`) or provably didn't (`not_done`: running it again is safe).
 */
export async function reconcileHandoff(services: Services, row: ApprovalRow): Promise<'done' | 'not_done'> {
  const [ran] = await services.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.burrowId, row.burrowId),
        eq(events.type, 'feedback.handoff_started'),
        sql`${events.payload}->>'approvalId' = ${row.id}`,
      ),
    )
    .limit(1);
  return ran ? 'done' : 'not_done';
}

export const startHandoff = defineCommand({
  name: START_HANDOFF,
  schema: StartHandoffInput,
  async apply(tx, ctx, input): Promise<{ messageId: string }> {
    // Only as the approved request's execution (the pipeline checked the approval holds this command and runs).
    if (!ctx.approvalId) throw forbidden('A handoff runs only once it is approved.');
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, ctx.approvalId));
    if (!approval || approval.command?.input.reportId !== input.reportId) throw forbidden();
    const [report] = await tx
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.id, input.reportId))
      .for('update');
    const problem = await handoffProblem(tx, approval, input);
    if (problem || !report?.assessment) throw conflict(problem ?? 'The report isn’t assessed any more.');
    const conversation = await loadConversationRow(tx, report.conversationId);
    const agent = await loadPrincipalRow(tx, input.handoffAgentId);
    if (!conversation || !agent) throw notFound('Report');
    // Whombat's fixed text, exactly as the approval card showed it (review-2 F1): nothing the visitor or the assessor
    // wrote. A normal mention: the agent's own keys and workspace rules apply to what it does next, and its
    // dispatch gets the report and the assessment as data (`feedbackHandoff`, feedback/dispatch.ts).
    const posted = await postMessage(ctx, {
      conversation,
      text: handoffMessageText(agent.name, report.reference),
      threadRootId: report.rootMessageId,
      mentions: [agent.id],
      provenance: 'feedback_handoff',
    });
    const event = await ctx.emit({
      type: 'feedback.handoff_started',
      kind: 'System',
      text: null,
      where: destinationLabel(conversation),
      payload: {
        reportId: report.id,
        approvalId: approval.id,
        handoffAgentId: agent.id,
        messageId: posted.id,
        assessmentHash: input.assessmentHash,
      },
    });
    await reportChanged(ctx, [report.rootMessageId], event.id);
    return { messageId: posted.id };
  },
});
