/** Approvals: approve in advance, undo, execute when conditions are met, decline with notice. */
import { ApprovalResponse, approvalPhase, approvalView } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { decideApproval, requestApproval, undoDecision } from '../commands/approvals';
import { recordChecks, reviewPr } from '../commands/prs';
import { approvals, dispatches, events, messages, notifications, plans } from '../db/schema/index';
import { toApproval } from '../read/work';
import { IDS } from '../seed/test-world';
import { simulateExecutors } from '../test/approvals';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });

// These tests are about deciding and conditions; the deploy itself is a stand-in they ask for (EA-02).
beforeAll(() => simulateExecutors(t.services, 'deploy'));

async function approval(id = 'apr_staging-482') {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('missing approval');
  return toApproval(row);
}

const greenChecks = [
  { name: 'lint', state: 'passed', note: '12s', durationMs: 12_000, tests: null, url: null },
  { name: 'typecheck', state: 'passed', note: '41s', durationMs: 41_000, tests: null, url: null },
  {
    name: 'unit · billing',
    state: 'passed',
    note: '41/41',
    durationMs: 60_000,
    tests: { passed: 41, total: 41 },
    url: null,
  },
  { name: 'pdf-snapshot', state: 'passed', note: '9s', durationMs: 9_000, tests: null, url: null },
] as const;

describe('approve in advance, undo, execute when met', () => {
  it('approves early without executing while checks and review are not green', async () => {
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const res = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/approvals/12/decide',
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const body = ApprovalResponse.parse(res.json());
    expect(body.approval.state).toBe('approved');
    expect(body.approval.decidedById).toBe(IDS.mara);
    expect(body.approval.executedAt).toBeNull();
    expect(approvalPhase(body.approval)).toBe('waiting');
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, body.eventId ?? ''));
    expect(event).toMatchObject({
      actorId: IDS.mara,
      type: 'approval.approved',
      kind: 'Asks',
      text: 'Approved Dusty’s staging deploy of feat/invoice-pdf',
      aboutId: IDS.dusty,
    });
    const [plan] = await t.services.db.select().from(plans).where(eq(plans.id, 'pln_invoice-pdf'));
    expect(plan?.steps[3]).toMatchObject({ state: 'gate', stateLabel: 'Approved' });
    // The log pill for the Asks event now reads APPROVED BY MARA.
    const log = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/audit/evt_9f18',
      headers: { cookie },
    });
    expect(log.json().event.approval).toMatchObject({ state: 'approved', decidedById: IDS.mara });
  });

  it('undoes back to pending (a signed event), then refuses a second undo', async () => {
    const res = await t.commit(IDS.mara, undoDecision, { number: 12 });
    expect(res.status).toBe('ok');
    expect((await approval()).state).toBe('pending');
    const again = t.commit(IDS.mara, undoDecision, { number: 12 });
    await expect(again).rejects.toMatchObject({ code: 'conflict' });
    const undone = await t.services.sql`select text from events where type = 'approval.undone'`;
    expect(undone[0]?.text).toBe('Undid approving Dusty’s staging deploy of feat/invoice-pdf');
  });

  it('refuses agents', async () => {
    const agent = await t.commit(IDS.dusty, decideApproval, { number: 12, decision: 'approve' });
    expect(agent).toMatchObject({ status: 'blocked', keyNeeded: { id: 'approvals.decide' } });
  });

  it('executes on its own once checks are green and the reviewer approves', async () => {
    expect((await t.commit(IDS.mara, decideApproval, { number: 12, decision: 'approve' })).status).toBe('ok');
    await t.commit(IDS.dusty, recordChecks, { prNumber: 482, headSha: '7be20f', checks: [...greenChecks] });
    let current = await approval();
    expect(current.conditions.find((c) => c.kind === 'checks_pass')).toMatchObject({
      met: true,
      passed: 41,
      total: 41,
      headSha: '7be20f',
    });
    expect(current.executedAt).toBeNull();
    await t.commit(IDS.dusty, reviewPr, {
      prNumber: 482,
      decision: 'approve',
      body: 'Approved. Rounding order is right.',
      comments: [],
    });
    current = await approval();
    expect(current.executedAt).not.toBeNull();
    expect(current.execution.state).toBe('succeeded');
    expect(approvalPhase(current)).toBe('executed');
    const view = approvalView(current, {
      names: () => ({ name: 'Mara Okafor', shortName: 'Mara' }),
      now: new Date(),
      timeZone: 'Europe/Amsterdam',
    });
    expect(view.label).toBe('DEPLOYED');
    const executed = await t.services.sql`select actor_id, text from events where type = 'approval.executed'`;
    expect(executed[0]).toMatchObject({ actor_id: IDS.dusty, text: 'Deployed feat/invoice-pdf to staging' });
    const [plan] = await t.services.db.select().from(plans).where(eq(plans.id, 'pln_invoice-pdf'));
    expect(plan?.steps[3]).toMatchObject({ state: 'done', stateLabel: 'Deployed' });
    // Undo is over once it executed (DECISIONS B-02).
    await expect(t.commit(IDS.mara, undoDecision, { number: 12 })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('the agent asking and the person declining', () => {
  it('lets an agent ask with its own copy and conditions, notifies approvers, and tells it on decline', async () => {
    const asked = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: {
        type: 'deploy',
        params: {
          environment: 'production',
          service: 'billing-api',
          ref: 'feat/invoice-pdf',
          sha: null,
          prNumber: 482,
        },
      },
      title: 'Deploy feat/invoice-pdf to production',
      question: 'Deploy feat/invoice-pdf to production?',
      target: 'production · billing-api',
      whatHappens: ['Roll billing-api to production'],
      explainer: 'Dusty holds a production key that only turns when a person approves.',
      summary: 'Dusty rolls billing-api to production.',
      conditions: [{ kind: 'checks_pass' }],
      approverIds: [IDS.mara],
    });
    expect(asked.status).toBe('ok');
    if (asked.status !== 'ok') return;
    const created = await approval(asked.result.approvalId);
    expect(created.conditions.map((c) => c.kind)).toEqual(['checks_pass', 'person_approves']);
    expect(created.messageId).toBe(asked.result.messageId);
    const needsYou = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.approvalId, created.id));
    expect(needsYou.map((n) => [n.principalId, n.kind])).toEqual([[IDS.mara, 'needs_you']]);

    const declined = await t.commit(IDS.mara, decideApproval, {
      number: created.number,
      decision: 'decline',
      note: 'Not before Friday.',
    });
    expect(declined.status).toBe('ok');
    expect((await approval(created.id)).state).toBe('declined');
    const [notice] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.threadRootId, created.messageId ?? ''));
    expect(notice?.text).toMatch(
      /^@Dusty, I declined “Deploy feat\/invoice-pdf to production”\. Not before Friday\.$/,
    );
    expect(notice?.mentions).toEqual([IDS.dusty]);
    const told = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.messageId, notice?.id ?? ''));
    expect(told.map((d) => [d.agentId, d.trigger])).toEqual([[IDS.dusty, 'approval_declined']]);
  });

  it('names each one involved once in the decline notice: not the requester again, not whoever said no', async () => {
    const asked = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: {
        type: 'deploy',
        params: { environment: 'staging', service: 'billing-api', ref: 'feat/retry', sha: null },
      },
      whatHappens: ['Roll billing-api to staging'],
      explainer: 'Dusty holds a staging key that only turns when a person approves.',
      summary: '',
      conditions: [],
      involvedIds: [IDS.dusty, IDS.mara, IDS.dusty],
    });
    if (asked.status !== 'ok') throw new Error('not asked');
    const created = await approval(asked.result.approvalId);
    await t.commit(IDS.mara, decideApproval, { number: created.number, decision: 'decline' });
    const [notice] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.threadRootId, created.messageId ?? ''));
    expect(notice?.text.match(/@Dusty/g)).toHaveLength(1);
    expect(notice?.text).not.toContain('@Mara');
    expect(notice?.mentions).toEqual([IDS.dusty]);
  });
});
