/**
 * Review 3 of Whombat Feedback (docs/implementation/feedback/review-3-fixes.md): removing a report's content removes
 * the assessor's words too (N3); system principals can't be configured, added, DMed or mentioned (N4).
 */
import {
  type DispatchContext,
  FEEDBACK_REMOVED_TEXT,
  type FeedbackIntegration,
  runnerApi,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { verifyAgentToken } from '../auth/agent-tokens';
import { decideApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import {
  approvals,
  dispatches,
  events,
  feedbackReports,
  messages,
  principals,
  searchDocuments,
} from '../db/schema/index';
import { callTool } from '../mcp/server';
import {
  assessmentInput,
  attachmentOf,
  createIntegration,
  IDS,
  runnerProtocol,
  submitReport,
} from '../test/feedback';
import { makePng } from '../test/files';
import { useTestServer } from '../test/harness';
import { loadReportCards } from './cards';
import { requestHandoff } from './handoff';
import { feedbackPrincipal } from './principal';
import { redactFeedbackReport } from './reports';

const t = useTestServer({ seed: true, app: true });
let integration: FeedbackIntegration;

beforeAll(async () => {
  // Turns are driven by hand (N7).
  Object.assign(t.services.runtime.options, { sweepMs: 3_600_000 });
  // Dusty assesses and, once the person approves, builds the fix (one-agent.md OA-16).
  integration = await createIntegration(t, { handoff: 'on' });
});

afterEach(async () => {
  await t.services.db
    .update(dispatches)
    .set({ state: 'cancelled', finishedAt: new Date() })
    .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
});

async function claim(): Promise<DispatchContext | null> {
  const res = await t.api.inject({
    method: 'POST',
    url: '/internal/runner/claim',
    headers: { authorization: 'Bearer dev-runner-token' },
    payload: { runnerId: 'rnr_feedback-test', providers: ['claude'], waitMs: 0 },
  });
  if (res.statusCode !== 200) throw new Error(`claim ${res.statusCode} ${res.body}`);
  return runnerApi.claim.response.parse(res.json()).dispatch;
}

async function tool(ctx: DispatchContext, name: string, args: Record<string, unknown>) {
  const auth = await verifyAgentToken(t.services, ctx.agentToken.token);
  if (!auth) throw new Error('dead token');
  const res = await callTool(t.services, auth, name, args);
  return res.isError === true;
}

async function principal(id: string) {
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, id));
  if (!row) throw new Error(`no principal ${id}`);
  return row;
}

describe('N2: a visitor’s screenshots reach only the assessment and the approved handoff', () => {
  it('the person’s own message in the report thread or the room gets no screenshots; the approved handoff does', async () => {
    const report = await submitReport(t, integration.siteId, {
      description: 'The chart is blank.',
      attachments: [attachmentOf(makePng(12, 12), 'image/png')],
    });
    const [shot] = report.attachmentIds;
    if (!shot) throw new Error('no screenshot');
    // The assessment gets it.
    await t.services.feedback.runPending();
    const assessing = await claim();
    if (assessing?.feedback?.reportId !== report.id) throw new Error('claimed something else');
    expect(assessing.attachments.map((a) => a.id)).toContain(shot);
    expect(await tool(assessing, 'submit_assessment', { ...assessmentInput() })).toBe(false);
    await runnerProtocol(t).complete(assessing, { outcome: 'done' });

    // “@Dusty thoughts?” in the report's thread, and in the Feedback room itself.
    for (const threadRootId of [report.rootMessageId, undefined]) {
      const asked = await t.commit(IDS.mara, sendMessage, {
        conversationId: integration.conversationId,
        text: '@Dusty thoughts?',
        ...(threadRootId ? { threadRootId } : {}),
      });
      if (asked.status !== 'ok') throw new Error(asked.status);
      const ctx = await claim();
      if (ctx?.dispatch.messageId !== asked.result.id) throw new Error('claimed something else');
      expect(ctx.attachments.map((a) => a.id)).not.toContain(shot);
      expect(await tool(ctx, 'read_attachment', { attachmentId: shot })).toBe(true);
      const fetched = await t.api.inject({
        method: 'GET',
        url: `/internal/runner/dispatches/${ctx.dispatch.id}/attachments/${shot}?runnerId=rnr_feedback-test&attempt=${ctx.dispatch.attempts}`,
        headers: { authorization: 'Bearer dev-runner-token' },
      });
      expect(fetched.statusCode).toBe(404);
      await runnerProtocol(t).complete(ctx, { outcome: 'done' });
    }

    // The handoff the person approved gets the report's screenshots with the report.
    const asked = await t.commit(IDS.mara, requestHandoff, { reportId: report.id, note: '' });
    if (asked.status !== 'ok') throw new Error(asked.status);
    const [approval] = await t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, asked.result.approvalId));
    const decided = await t.commit(IDS.mara, decideApproval, {
      number: approval?.number as number,
      decision: 'approve',
    });
    expect(decided.status).toBe('ok');
    const dev = await claim();
    expect(dev?.feedbackHandoff?.reportId).toBe(report.id);
    expect(dev?.attachments.map((a) => a.id)).toContain(shot);
    if (dev) await runnerProtocol(t).complete(dev, { outcome: 'done' });
  });
});

describe('N3: removing a report’s content removes the assessor’s words too', () => {
  it('clears the assessment’s free text, the assessor’s posts and their search entries; the person’s replies stay', async () => {
    const report = await submitReport(t, integration.siteId, {
      description: 'My email is visitor@example.com and my order 4411 is wrong.',
    });
    await t.services.feedback.runPending();
    const ctx = await claim();
    if (ctx?.feedback?.reportId !== report.id) throw new Error('claimed something else');
    expect(
      await tool(ctx, 'reply_in_thread', {
        messageId: ctx.dispatch.threadRootId,
        text: 'The visitor visitor@example.com says order 4411 is wrong.',
      }),
    ).toBe(false);
    expect(
      await tool(ctx, 'submit_assessment', {
        ...assessmentInput({
          summary: 'Order 4411 of visitor@example.com rounds wrongly.',
          evidence: [{ kind: 'report', ref: 'order 4411', note: 'visitor@example.com', hypothesis: false }],
        }),
      } as unknown as Record<string, unknown>),
    ).toBe(false);
    const person = await t.commit(IDS.mara, sendMessage, {
      conversationId: integration.conversationId,
      threadRootId: report.rootMessageId,
      text: 'I’ll look at order 4411.',
    });
    if (person.status !== 'ok') throw new Error(person.status);
    const assessorPosts = async () =>
      t.services.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.threadRootId, report.rootMessageId),
            eq(messages.provenance, 'feedback_assessment'),
          ),
        );
    const before = await assessorPosts();
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(before.some((m) => m.text.includes('4411'))).toBe(true);

    const res = await t.commit(IDS.mara, redactFeedbackReport, { reportId: report.id });
    expect(res.status).toBe('ok');

    const [row] = await t.services.db.select().from(feedbackReports).where(eq(feedbackReports.id, report.id));
    expect(row?.assessmentState).toBe('done');
    expect(row?.assessment).toMatchObject({
      outcome: 'likely_bug',
      confidence: 'medium',
      summary: FEEDBACK_REMOVED_TEXT,
      uncertainty: '',
      nextAction: '',
      severity: { level: 'medium', rationale: '' },
      evidence: [{ kind: 'report', ref: FEEDBACK_REMOVED_TEXT, note: '', hypothesis: false }],
      revision: { inspected: null, reported: null, mismatch: null },
    });
    expect(JSON.stringify(row?.assessment)).not.toMatch(/4411|visitor@/);
    // The card shows no assessment summary any more.
    const card = (await loadReportCards(t.services.db, [report.id])).get(report.id);
    expect(card?.assessment).toMatchObject({ state: 'done', outcome: 'likely_bug', summary: null });
    // The assessor's posts keep their place with the fixed text; the person's reply is theirs and stays.
    const after = await assessorPosts();
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
    for (const m of after) expect(m.text).toBe(FEEDBACK_REMOVED_TEXT);
    const [kept] = await t.services.db.select().from(messages).where(eq(messages.id, person.result.id));
    expect(kept?.text).toBe('I’ll look at order 4411.');
    // No search entry holds the assessor's words; the signed event names the messages (ids only).
    const docs = await t.services.db
      .select({ id: searchDocuments.id })
      .from(searchDocuments)
      .where(
        inArray(
          searchDocuments.id,
          after.map((m) => m.id),
        ),
      );
    expect(docs).toEqual([]);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'feedback.report_redacted'))
      .orderBy(events.createdAt);
    const payload = (event?.payload ?? {}) as { assessorMessageIds?: string[] };
    expect(payload.assessorMessageIds?.sort()).toEqual(after.map((m) => m.id).sort());
    expect(JSON.stringify(event?.payload)).not.toMatch(/4411|visitor@/);
  });
});

describe('N4: system principals are part of Whombat, not agents anyone works with', () => {
  it('isn’t mentioned: `@Feedback` stays text, even where it posts', async () => {
    const feedback = await principal(await feedbackPrincipal(t.services, t.burrowId));
    const posted = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: `@${feedback.name} are you there?`,
    });
    if (posted.status !== 'ok') throw new Error(posted.status);
    const [row] = await t.services.db.select().from(messages).where(eq(messages.id, posted.result.id));
    expect(row?.mentions).toEqual([]);
  });
});
