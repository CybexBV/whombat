/**
 * “Always allow” on a risk row's card (docs/decisions/resourceful-agents.md RA-06, RA-DC08; RA-DS32, RA-DS33):
 * `approvals.decide` with `scope: 'agent'` approves a typed action under a risk row and sets the row to On for the agent,
 * signed as the key change it is by the person; the approval carries the scope. Refused: with a no, on anything but a
 * risk-row action, `task` on one, and by someone who may not decide it (nothing changes). Undo before it ran puts the
 * row back. The agent's next deploy runs without a card.
 */
import { api, buildPath, type GrantInput, keyRowTier, withKeyRowTier } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { performAction } from '../commands/agent-tools';
import { setAgentKeys } from '../commands/agents';
import { requestApproval } from '../commands/approvals';
import { approvals, events, grants } from '../db/schema/index';
import { loadGrants } from '../read/principals';
import { toApproval } from '../read/work';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { simulatedExecutor } from './engine';

const t = useTestServer({ seed: true, app: true });
const REPO = 'whombat/billing';
const deploy = {
  type: 'deploy' as const,
  params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null, repo: REPO },
};

const deployTier = async () => keyRowTier(await loadGrants(t.services.db, IDS.dusty), 'deploy');

async function setDeployRow(tier: 'cannot' | 'ask' | 'can') {
  const held = await loadGrants(t.services.db, IDS.dusty);
  const grants = withKeyRowTier(held, 'deploy', tier).map(({ keyId, tier, scope }) =>
    scope ? { keyId, tier, scope } : { keyId, tier },
  ) as GrantInput[];
  const res = await t.commit(IDS.mara, setAgentKeys, { grants });
  expect(res.status).toBe('ok');
}

/** Dusty asks Mara to deploy (a card in #billing-v2); `review` adds a condition a yes can't meet by itself. */
async function banjoAsks(review = false) {
  const res = await t.commit(IDS.dusty, requestApproval, {
    conversationId: IDS.billing,
    action: deploy,
    whatHappens: ['Staging gets the invoice PDFs'],
    explainer: 'Mara asked for it.',
    summary: 'Staging deploy',
    conditions: review ? [{ kind: 'review_approved', reviewerId: IDS.dusty }] : [],
    approverIds: [IDS.mara],
  });
  if (res.status !== 'ok') throw new Error(res.status);
  return res.result;
}

async function decide(who: string, number: number, body: Record<string, unknown>) {
  const { cookie } = await sessionFor(t.services, who);
  const res = await t.api.inject({
    method: 'POST',
    url: `/api/v1${buildPath(api.approvals.decide.path, { burrow: 'burrow-hq', number })}`,
    headers: { cookie },
    payload: body,
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & { error?: { code: string } },
  };
}

async function approvalRow(id: string) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('no approval');
  return toApproval(row);
}

beforeAll(async () => {
  t.services.approvals.setExecutor('deploy', simulatedExecutor);
  await setDeployRow('ask');
});

describe('Always allow (RA-06)', () => {
  it('refuses a scope where it means nothing, and anyone who may not decide, changing nothing', async () => {
    const asked = await banjoAsks();
    // A no has no scope; a deploy is allowed once or always, never “for the task”.
    expect(
      (await decide(IDS.mara, asked.number, { decision: 'decline', scope: 'agent' })).body.error?.code,
    ).toBe('validation_failed');
    expect(
      (await decide(IDS.mara, asked.number, { decision: 'approve', scope: 'task' })).body.error?.code,
    ).toBe('validation_failed');
    expect(await deployTier()).toBe('ask');
    expect((await approvalRow(asked.approvalId)).state).toBe('pending');
    // A key request isn't a risk row's card: no “Always allow” there (its own button gives the key). Dusty holds
    // “Use a web browser” as a new agent does: without it, so he may ask for it.
    await t.services.db
      .delete(grants)
      .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, 'browser.use')));
    const keyAsk = await t.commit(IDS.dusty, requestApproval, {
      conversationId: IDS.billing,
      action: { type: 'grant_key', params: { keyId: 'browser.use' } },
      whatHappens: ['Dusty opens the page in a browser'],
      explainer: 'To look.',
      summary: 'A key',
      conditions: [],
    });
    if (keyAsk.status !== 'ok') throw new Error(keyAsk.status);
    expect(
      (await decide(IDS.mara, keyAsk.result.number, { decision: 'approve', scope: 'agent' })).body.error
        ?.code,
    ).toBe('validation_failed');
  });

  it('approves and turns the row On, signed as the key change, and the next deploy needs no card', async () => {
    const asked = await banjoAsks();
    const res = await decide(IDS.mara, asked.number, { decision: 'approve', scope: 'agent' });
    expect(res.status).toBe(200);
    const approval = await approvalRow(asked.approvalId);
    expect(approval).toMatchObject({ state: 'approved', scope: 'agent' });
    expect(res.body.approval).toMatchObject({ scope: 'agent' });
    expect(await deployTier()).toBe('can');
    // The key change: Configure's Keys events, signed by Mara, naming the approval.
    const changes = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'keys.changed'), eq(events.aboutId, IDS.dusty)));
    const forThis = changes.filter((e) => e.payload.approvalId === asked.approvalId);
    expect(forThis.length).toBeGreaterThan(0);
    for (const e of forThis) expect(e).toMatchObject({ kind: 'Keys', actorId: IDS.mara });
    expect(forThis.map((e) => e.payload.keyId)).toContain('deploy');
    const [decided] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'approval.approved'), eq(events.approvalId, asked.approvalId)));
    expect(decided?.payload).toMatchObject({ scope: 'agent', row: 'deploy', rowBefore: 'ask' });

    // From now on Dusty deploys without asking.
    const before = (await t.services.db.select().from(approvals)).length;
    const on = await t.commit(IDS.dusty, performAction, {
      action: deploy,
      conversationId: IDS.billing,
      reason: 'Mara asked',
    });
    expect(on).toMatchObject({ status: 'ok' });
    expect((await t.services.db.select().from(approvals)).length).toBe(before);
  });

  it('undoing an “Always allow” that hasn’t run puts the row back where it was', async () => {
    await setDeployRow('ask');
    // Waiting for a review: approved in advance, not run yet.
    const asked = await banjoAsks(true);
    expect((await decide(IDS.mara, asked.number, { decision: 'approve', scope: 'agent' })).status).toBe(200);
    expect(await deployTier()).toBe('can');
    expect((await approvalRow(asked.approvalId)).executedAt).toBeNull();
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const undone = await t.api.inject({
      method: 'POST',
      url: `/api/v1${buildPath(api.approvals.undo.path, { burrow: 'burrow-hq', number: asked.number })}`,
      headers: { cookie },
    });
    expect(undone.statusCode).toBe(200);
    expect(await approvalRow(asked.approvalId)).toMatchObject({ state: 'pending', scope: null });
    expect(await deployTier()).toBe('ask');
    // Once: an Approve after it is just once.
    expect((await decide(IDS.mara, asked.number, { decision: 'approve' })).status).toBe(200);
    expect(await approvalRow(asked.approvalId)).toMatchObject({ state: 'approved', scope: 'once' });
    expect(await deployTier()).toBe('ask');
  });
});
