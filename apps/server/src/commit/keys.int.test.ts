/** Keys engine outcomes end to end: allow / ask / blocked, each with its signed event. */
import { ApprovalRequiredBody, verifyEvent } from '@whombat/core';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { rowToSignedEvent } from '../audit/events';
import { updateAgent } from '../commands/agents';
import { createCanvas } from '../commands/content';
import { mergePr, reviewPr } from '../commands/prs';
import { approvals, canvases, events, grants, principals } from '../db/schema/index';
import { OutcomeReply, ok } from '../routes/define';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { holdsBurrowLock } from './lock-scope';

const t = useTestServer({ seed: true, app: true });

async function eventRow(id: string) {
  const [row] = await t.services.db.select().from(events).where(eq(events.id, id));
  if (!row) throw new Error(`no event ${id}`);
  return row;
}

async function publicKey(principalId: string) {
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, principalId));
  return row?.publicKey ?? '';
}

describe('cannot → Blocked', () => {
  it('blocks an agent merging into main and signs a Blocked event with the key it needed', async () => {
    const res = await t.commit(IDS.dusty, mergePr, { number: 482 });
    expect(res.status).toBe('blocked');
    if (res.status !== 'blocked') return;
    expect(res.keyNeeded).toEqual({ id: 'merge.main', label: 'Merge into main' });
    const row = await eventRow(res.eventId);
    expect(row).toMatchObject({
      actorId: IDS.dusty,
      type: 'action.blocked',
      kind: 'Blocked',
      text: 'Tried to merge PR #482 into main. Blocked.',
      where: 'whombat/billing · PR #482',
      keyNote: 'not one of Dusty’s keys',
    });
    expect(verifyEvent(rowToSignedEvent(row), await publicKey(IDS.dusty))).toEqual({ ok: true });
    // Nothing merged.
    const [pr] = await t.services.sql`select state from pull_requests where number = 482`;
    expect(pr?.state).toBe('open');
  });

  it('REST refuses agents’ tokens (agents meet a Blocked outcome over MCP)', async () => {
    const { bearer } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.pr482);
    const agent = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/prs/482/merge',
      headers: { authorization: bearer },
      payload: {},
    });
    expect(agent.statusCode).toBe(401);
  });

  it('blocks the agent from people-only keys', async () => {
    // Changing the agent is the person's (one-agent.md OA-09): the agent itself never holds that key.
    const hire = await t.commit(IDS.dusty, updateAgent, { name: 'Pebble' });
    expect(hire).toMatchObject({ status: 'blocked', keyNeeded: { id: 'burrow.manage' } });
  });
});

describe('ask → Approval', () => {
  /** Dusty asks before it writes a canvas; its turns are for Mara, so its asks land in her chat with it. */
  const asking = { onBehalfOf: { principalId: IDS.mara } };
  const canvas = (title: string) => ({ title, conversationId: IDS.dmDusty });
  beforeAll(async () => {
    await t.services.db
      .insert(grants)
      .values({ burrowId: t.burrowId, agentId: IDS.dusty, keyId: 'canvas.write', tier: 'ask' })
      .onConflictDoUpdate({ target: [grants.agentId, grants.keyId], set: { tier: 'ask' } });
  });

  it('turns an agent’s ask-first key into a pending approval with a signed Asks event', async () => {
    const res = await t.commit(IDS.dusty, createCanvas, canvas('Design'), asking);
    expect(res.status).toBe('pending_approval');
    if (res.status !== 'pending_approval') return;
    const [approval] = await t.services.db.select().from(approvals).where(eq(approvals.id, res.approvalId));
    expect(approval).toMatchObject({
      requesterId: IDS.dusty,
      keyId: 'canvas.write',
      state: 'pending',
      eventId: res.eventId,
      conversationId: IDS.dmDusty,
    });
    expect(approval?.command?.name).toBe('create_canvas');
    const row = await eventRow(res.eventId);
    expect(row).toMatchObject({ type: 'approval.requested', kind: 'Asks', approvalId: res.approvalId });
    expect(row.keyUsed?.id).toBe('canvas.write');
    // The canvas does not exist until a person says yes.
    expect(await t.services.db.select().from(canvases).where(eq(canvases.title, 'Design'))).toEqual([]);

    // Mara approves → the deferred command runs as Dusty → the canvas exists and the approval executed.
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const decided = await t.api.inject({
      method: 'POST',
      url: `/api/v1/burrows/burrow-hq/approvals/${res.approvalNumber}/decide`,
      headers: { cookie },
      payload: { decision: 'approve' },
    });
    expect(decided.statusCode).toBe(200);
    const [after] = await t.services.db.select().from(approvals).where(eq(approvals.id, res.approvalId));
    expect(after?.state).toBe('approved');
    expect(after?.executedAt).not.toBeNull();
    const [made] = await t.services.db.select().from(canvases).where(eq(canvases.title, 'Design'));
    expect(made).toMatchObject({ conversationId: IDS.dmDusty });
  });

  it('does not let an arbitrary approval id skip the ask', async () => {
    const forged = t.commit(IDS.dusty, createCanvas, canvas('Backdoor'), {
      ...asking,
      approvalId: 'apr_staging-482',
    });
    await expect(forged).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('maps an ask to the 202 ApprovalRequiredBody REST reply', async () => {
    const res = await t.commit(IDS.dusty, createCanvas, canvas('Service map'), asking);
    let reply: unknown;
    try {
      ok(res);
    } catch (err) {
      reply = err;
    }
    expect(reply).toBeInstanceOf(OutcomeReply);
    const outcome = reply as OutcomeReply;
    expect(outcome.status).toBe(202);
    const body = ApprovalRequiredBody.parse(outcome.body);
    expect((await eventRow(body.eventId)).kind).toBe('Asks');
  });
});

describe('can → allow', () => {
  it('runs the command and records KEY USED on the agent’s event', async () => {
    const res = await t.commit(IDS.dusty, reviewPr, {
      prNumber: 482,
      decision: 'request_changes',
      body: '',
      comments: [{ path: 'billing/pdf/format.ts', line: 12, text: 'Round first.' }],
    });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const rows = await Promise.all(res.eventIds.map(eventRow));
    const review = rows.find((r) => r.type === 'pr.changes_requested');
    expect(review).toMatchObject({ text: 'Requested 1 change on PR #482', actorId: IDS.dusty });
    expect(review?.keyUsed).toEqual({ id: 'pr.request_changes', label: 'Request changes' });
  });
});

describe('a write holds the burrow lock only so long', () => {
  it('limits its wait for the lock and its statements, and knows it holds the lock', async () => {
    const seen = await t.services.pipeline.transact(t.burrowId, async (s) => {
      const [row] = (await s.tx.execute(
        sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`,
      )) as unknown as { lock: string; statement: string }[];
      return { ...row, held: holdsBurrowLock() };
    });
    expect(seen.result).toEqual({ lock: '1min', statement: '1min', held: true });
    expect(holdsBurrowLock()).toBe(false);
  });
});
