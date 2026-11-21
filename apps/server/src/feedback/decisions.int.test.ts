/**
 * The assessor's conclusion (docs/decisions/feedback.md FB-32): its reply is the message, inert, with the `assessment`
 * card (verdict, decision, the full assessment); a bug report always gets a verdict; a person picks an option once and
 * its fixed action runs as them — a status, or the development handoff's approval — and the card follows.
 */
import type { AssessmentCard, FeedbackAssessmentSubmissionInput, FeedbackIntegration } from '@whombat/core';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { verifyAgentToken } from '../auth/agent-tokens';
import { approvals, dispatches, feedbackReports, messages } from '../db/schema/index';
import { callTool } from '../mcp/server';
import { loadMessages } from '../read/messages';
import { assessmentInput, createIntegration, IDS, runnerProtocol, submitReport } from '../test/feedback';
import { useTestServer } from '../test/harness';
import { loadAssessmentCards } from './cards';
import { reportPermissions, toFeedbackReport } from './read';
import { inertReply } from './render';
import { decideFeedbackReport, redactFeedbackReport } from './reports';

const t = useTestServer({ seed: true, app: true });
let integration: FeedbackIntegration;

const decision: FeedbackAssessmentSubmissionInput['decision'] = {
  question: 'Shall Dusty fix the rounding?',
  options: [
    { label: 'Hand to Dusty', action: 'hand_off', recommended: true },
    { label: 'Leave it for now', action: 'keep_open' },
    { label: 'Won’t fix', action: 'close' },
  ],
};

beforeAll(async () => {
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

async function reportRow(id: string) {
  const [row] = await t.services.db.select().from(feedbackReports).where(eq(feedbackReports.id, id));
  if (!row) throw new Error(`no report ${id}`);
  return row;
}

/** A report whose assessment turn is claimed: submit with the assessor's own tool. */
async function claimed(site = integration.siteId, over: Parameters<typeof submitReport>[2] = {}) {
  const report = await submitReport(t, site, { description: 'The invoice total is off by a cent.', ...over });
  await t.services.feedback.runPending();
  let ctx = await runnerProtocol(t).claim();
  for (let i = 0; ctx && ctx.feedback?.reportId !== report.id && i < 5; i++) {
    await runnerProtocol(t).complete(ctx, { outcome: 'done' });
    await t.services.feedback.runPending();
    ctx = await runnerProtocol(t).claim();
  }
  if (!ctx || ctx.feedback?.reportId !== report.id) throw new Error('claimed something else');
  const auth = await verifyAgentToken(t.services, ctx.agentToken.token);
  if (!auth) throw new Error('dead token');
  const turn = ctx;
  return {
    report,
    submit: (input: FeedbackAssessmentSubmissionInput) =>
      callTool(t.services, auth, 'submit_assessment', input as Record<string, unknown>),
    done: () => runnerProtocol(t).complete(turn, { outcome: 'done' }),
  };
}

async function assessed(over: Partial<FeedbackAssessmentSubmissionInput> = {}) {
  const c = await claimed();
  const res = await c.submit(assessmentInput({ decision, ...over }));
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  await c.done();
  return reportRow(c.report.id);
}

async function cardOf(reportId: string): Promise<AssessmentCard> {
  const row = await reportRow(reportId);
  const [m] = await t.services.db
    .select()
    .from(messages)
    .where(eq(messages.id, row.assessmentMessageId as string));
  if (!m) throw new Error('no assessment message');
  const [loaded] = await loadMessages(t.services.db, [m], IDS.mara);
  if (loaded?.card?.kind !== 'assessment') throw new Error('no assessment card');
  return loaded.card;
}

const decide = (reportId: string, option: number, by: string = IDS.mara) =>
  t.commit(by, decideFeedbackReport, { reportId, option });

describe('the assessor’s reply and card', () => {
  it('posts the reply as inert text with the assessment card; the full assessment stays on the card', async () => {
    const reply = 'This is a real bug. @Mara see [this](https://evil.example) **now**';
    const row = await assessed({
      reply,
      bugVerdict: 'bug',
      evidence: [
        { kind: 'file', ref: 'src/billing/invoice.ts:88', note: 'rounds per line', hypothesis: false },
      ],
    });
    const [m] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row.assessmentMessageId as string));
    expect(m).toMatchObject({
      authorId: IDS.dusty,
      threadRootId: row.rootMessageId,
      mentions: [],
      text: inertReply(reply),
      card: { kind: 'assessment', reportId: row.id },
      provenance: 'feedback_assessment',
    });
    expect(m?.text).not.toContain('**now**');
    expect(row.assessment).not.toHaveProperty('reply');
    expect(row.conclusion).toMatchObject({ reply, bugVerdict: 'bug' });
    expect(await cardOf(row.id)).toMatchObject({
      kind: 'assessment',
      reference: row.reference,
      type: 'bug',
      status: 'new',
      bugVerdict: 'bug',
      decision: { question: 'Shall Dusty fix the rounding?' },
      decided: null,
      contentRemoved: false,
      assessment: { outcome: 'likely_bug' },
    });
    const report = await toFeedbackReport(t.services.db, row);
    expect(report.assessment).toMatchObject({ conclusion: { bugVerdict: 'bug' }, decided: null });
  });

  it('a bug report needs a verdict; hand_off needs an integration that builds fixes', async () => {
    const c = await claimed();
    const missing = await c.submit(assessmentInput({ bugVerdict: null }));
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('bugVerdict');
    await c.done();

    const noFixes = await createIntegration(t, { name: 'No fixes' });
    const d = await claimed(noFixes.siteId, { description: 'No fixes here.' });
    const handOff = await d.submit(assessmentInput({ decision }));
    expect(handOff.isError).toBe(true);
    expect(JSON.stringify(handOff.content)).toContain('validation_failed');
    expect(JSON.stringify(handOff.content)).toContain('hand_off');
    const ok = await d.submit(
      assessmentInput({
        decision: {
          question: 'Keep it?',
          options: [
            { label: 'Keep it open', action: 'keep_open' },
            { label: 'Close it', action: 'close' },
          ],
        },
      }),
    );
    expect(ok.isError).toBeFalsy();
    await d.done();
  });

  it('a feature request may go without a verdict', async () => {
    const c = await claimed(integration.siteId, { type: 'feature', description: 'Add iDEAL links.' });
    const res = await c.submit(
      assessmentInput({ outcome: 'feature_request', bugVerdict: null, decision: null }),
    );
    expect(res.isError).toBeFalsy();
    await c.done();
    const card = await cardOf(c.report.id);
    expect(card).toMatchObject({ type: 'feature', bugVerdict: null, decision: null });
  });
});

describe('deciding (FB-32)', () => {
  it('a status option sets the status once, as the person, and the card shows who picked what', async () => {
    const row = await assessed();
    expect((await reportPermissions(t.services.db, row, { id: IDS.mara, kind: 'person' })).decide).toBe(true);
    const res = await decide(row.id, 2);
    expect(res.status).toBe('ok');
    const after = await reportRow(row.id);
    expect(after.status).toBe('closed');
    expect(after.decided).toMatchObject({
      option: 2,
      label: 'Won’t fix',
      action: 'close',
      decidedById: IDS.mara,
    });
    expect(await cardOf(row.id)).toMatchObject({ status: 'closed', decided: { label: 'Won’t fix' } });
    await expect(decide(row.id, 1)).rejects.toMatchObject({ code: 'conflict' });
    expect((await reportPermissions(t.services.db, after, { id: IDS.mara, kind: 'person' })).decide).toBe(
      false,
    );
  });

  it('hand_off asks the person with the label as the note; no agent is woken by the click', async () => {
    const row = await assessed();
    const before = await t.services.db.select().from(dispatches).where(eq(dispatches.agentId, IDS.dusty));
    expect((await decide(row.id, 0)).status).toBe('ok');
    const after = await reportRow(row.id);
    const [approval] = await t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, after.handoffApprovalId as string));
    expect(approval).toMatchObject({ requesterId: IDS.mara, state: 'pending' });
    expect(approval?.whatHappens.join(' ')).toContain('“Hand to Dusty”');
    expect(after.status).toBe('new');
    expect(after.decided).toMatchObject({ action: 'hand_off' });
    const now = await t.services.db.select().from(dispatches).where(eq(dispatches.agentId, IDS.dusty));
    expect(now.length).toBe(before.length);
  });

  it('agents, bad options and assessments without a decision are refused', async () => {
    const row = await assessed();
    await expect(decide(row.id, 1, IDS.dusty)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(decide(row.id, 3)).rejects.toMatchObject({ code: 'validation_failed' });
    const plain = await assessed({ decision: null });
    await expect(decide(plain.id, 0)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('removing the content removes the assessor’s words; the verdict and actions stay', async () => {
    const row = await assessed();
    await decide(row.id, 1);
    expect((await t.commit(IDS.mara, redactFeedbackReport, { reportId: row.id })).status).toBe('ok');
    const after = await reportRow(row.id);
    expect(after.conclusion).toMatchObject({ bugVerdict: 'unsure' });
    expect(after.conclusion?.reply).not.toBe(row.conclusion?.reply);
    // The options keep their actions; their labels become Whombat's own words for them.
    expect(after.conclusion?.decision?.options.map((o) => o.action)).toEqual([
      'hand_off',
      'keep_open',
      'close',
    ]);
    expect(after.conclusion?.decision?.options.map((o) => o.label)).not.toContain('Hand to Dusty');
    expect(after.decided).toMatchObject({ action: 'keep_open' });
    const cards = await loadAssessmentCards(t.services.db, [row.id]);
    expect(cards.get(row.id)).toMatchObject({ contentRemoved: true, decided: { action: 'keep_open' } });
  });
});
