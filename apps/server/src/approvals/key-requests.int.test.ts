/**
 * Agents asking for a key (docs/decisions/key-requests.md): `request_approval` with a `grant_key` action posts
 * one approval card; only the people who may change the agent's keys decide it; approving gives the key at
 * `can` (clamped to its cap) with the same signed `Keys` event Configure writes, and wakes the agent, whose
 * next turn holds the key (for “Browse the web”: network).
 */
import { decide, KEY_CATALOG, type KeyId, keyRowTier, WHOMBAT_TOOL_NAMES } from '@whombat/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { performAction } from '../commands/agent-tools';
import { decideApproval, requestApproval } from '../commands/approvals';
import { approvals, dispatches, events, grants, messages } from '../db/schema/index';
import { loadGrants } from '../read/principals';
import { toApproval } from '../read/work';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { agentTokenFor } from '../test/tokens';

const t = useTestServer({ seed: true, listen: true });
const clients: TestMcp[] = [];

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

// The test world's Dusty holds a new agent's keys, “Browse the web” among them, and “Use a web browser”, which brings it
// in: each case takes both away and asks for it afresh.
beforeEach(async () => {
  await t.services.db
    .delete(grants)
    .where(and(eq(grants.agentId, IDS.dusty), inArray(grants.keyId, ['web.browse', 'browser.use'])));
});

const askFor = (agentId: string, keyId: KeyId, conversationId: string = IDS.billing) =>
  t.commit(agentId, requestApproval, {
    conversationId,
    action: { type: 'grant_key', params: { keyId } },
    whatHappens: ['Look up the VAT rules on the tax office’s site'],
    explainer: '',
    summary: 'I need to read the tax office’s page on VAT rounding.',
  });

async function asked(agentId: string, keyId: KeyId, conversationId?: string) {
  const res = await askFor(agentId, keyId, conversationId);
  if (res.status !== 'ok') throw new Error(`request_approval: ${res.status}`);
  return res.result;
}

async function load(id: string) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('no approval');
  return toApproval(row);
}

/** The signed Keys events an approved key request wrote. */
async function keysEventsFor(approvalId: string) {
  const rows = await t.services.db.select().from(events).where(eq(events.kind, 'Keys'));
  return rows.filter((e) => (e.payload as { approvalId?: string }).approvalId === approvalId);
}

const tierOf = async (agentId: string, keyId: KeyId) =>
  (await loadGrants(t.services.db, agentId)).find((g) => g.keyId === keyId)?.tier ?? null;

describe('an agent asks for a key', () => {
  it('posts an approval card for “Browse the web”, decided by the person (over MCP too)', async () => {
    const { token } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const banjo = await mcpClient(t.baseUrl, token);
    clients.push(banjo);
    expect(WHOMBAT_TOOL_NAMES).toContain('request_approval');
    const res = await banjo.call('request_approval', {
      conversationId: IDS.billing,
      action: { type: 'grant_key', params: { keyId: 'web.browse' } },
      whatHappens: ['Read the tax office’s page on VAT rounding'],
      explainer: '',
      summary: '',
    });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ status: 'ok' });
    const approval = await load(res.body.approvalId as string);
    expect(approval).toMatchObject({
      requesterId: IDS.dusty,
      keyId: 'web.browse',
      action: { type: 'grant_key', params: { keyId: 'web.browse' } },
      title: 'Give Dusty “Browse the web”',
      question: 'Give Dusty “Browse the web”?',
      target: 'keys · Dusty',
      state: 'pending',
      conversationId: IDS.billing,
    });
    expect(approval.whatHappens[0]).toBe('Give Dusty “Browse the web”, to use without asking');
    // Only the person decides it.
    expect(approval.conditions).toEqual([
      expect.objectContaining({ kind: 'person_approves', approverIds: [IDS.mara] }),
    ]);
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, approval.messageId ?? ''));
    expect(card).toMatchObject({
      authorId: IDS.dusty,
      text: 'I need “Browse the web” to go on. Only a person can give me a key.',
    });
    const [ask] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, approval.eventId ?? ''));
    expect(ask).toMatchObject({
      actorId: IDS.dusty,
      kind: 'Asks',
      text: 'Asked to get the key “Browse the web”',
      keyUsed: { id: 'web.browse', label: 'Browse the web' },
      keyNote: 'asks a person for it',
    });
    // Asking again while it waits answers with the same request.
    const again = await asked(IDS.dusty, 'web.browse');
    expect(again.approvalId).toBe(approval.id);
  });

  it('refuses keys for people only, keys it holds, and a direct grant', async () => {
    // Changing agents' keys is people's; merging into main and, since agent-computer.md AC-41, pushing to main are
    // keys agents may ask for (runs-approvals.md MDS-04; below).
    await expect(askFor(IDS.dusty, 'agents.manage')).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('“Change the agent and its keys” is for people.'),
    });
    await expect(askFor(IDS.dusty, 'pr.open')).rejects.toMatchObject({
      message: 'Dusty already holds “Open pull requests”.',
    });
    await expect(askFor(IDS.dusty, 'deploy.staging')).rejects.toMatchObject({
      message: expect.stringContaining(
        'Dusty already holds “Deploy to staging” and asks a person each time.',
      ),
    });
    await expect(
      t.commit(IDS.dusty, performAction, {
        action: { type: 'grant_key', params: { keyId: 'web.browse' } },
        conversationId: IDS.billing,
        reason: 'I need the web',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(await tierOf(IDS.dusty, 'web.browse')).toBeNull();
  });
});

describe('deciding a key request', () => {
  it('the person’s approval gives the key and wakes the agent', async () => {
    const request = await asked(IDS.dusty, 'web.browse');
    const res = await t.commit(IDS.mara, decideApproval, { number: request.number, decision: 'approve' });
    expect(res.status).toBe('ok');
    const done = await load(request.approvalId);
    expect(done.execution.state).toBe('succeeded');
    expect(done.executedAt).not.toBeNull();
    expect(await tierOf(IDS.dusty, 'web.browse')).toBe('can');
    // Every other grant is as it was.
    const grants = await loadGrants(t.services.db, IDS.dusty);
    expect(grants.map((g) => [g.keyId, g.tier])).toEqual(
      expect.arrayContaining([
        ['branch.feature.readwrite', 'can'],
        ['branch.shared.push', 'ask'],
        ['merge.main', 'cannot'],
      ]),
    );

    // The same signed Keys event Configure writes, by the person who approved.
    const keys = await keysEventsFor(request.approvalId);
    expect(keys).toEqual([
      expect.objectContaining({
        actorId: IDS.mara,
        type: 'keys.granted',
        text: 'Gave Dusty a new key: Browse the web',
        where: 'Agent · Dusty',
      }),
    ]);
    const [executed] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'approval.executed'), eq(events.approvalId, request.approvalId)));
    expect(executed).toMatchObject({ actorId: IDS.dusty, text: 'Got “Browse the web”' });

    // Dusty is told under the card, which wakes it; its next turn holds the key, so it has network.
    const [reply] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.threadRootId, request.messageId))
      .orderBy(asc(messages.createdAt));
    expect(reply).toMatchObject({
      authorId: IDS.mara,
      text: '@Dusty, I gave you “Browse the web”. Go ahead.',
    });
    const [woken] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.messageId, reply?.id ?? '')));
    if (!woken) throw new Error('Dusty was not woken');
    const context = await buildDispatchContext(t.services, woken);
    expect(context.agent.keys.can.map((k) => k.id)).toContain('web.browse');
    const persona = context.agent.keys.can.map((k) => ({
      agentId: IDS.dusty,
      keyId: k.id,
      tier: 'can' as const,
    }));
    expect(decide({ id: IDS.dusty, kind: 'agent' }, persona, 'web.browse').outcome).toBe('allow');
  });

  it('a declined request gives nothing and tells the agent plainly', async () => {
    const request = await asked(IDS.dusty, 'web.browse');
    await t.commit(IDS.mara, decideApproval, { number: request.number, decision: 'decline' });
    expect(await tierOf(IDS.dusty, 'web.browse')).toBeNull();
    const [reply] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.threadRootId, request.messageId));
    expect(reply).toMatchObject({ authorId: IDS.mara, text: '@Dusty, I didn’t give you “Browse the web”.' });
  });

  it('gives Merge into main at ask, the whole Merge row with it (MD-04)', async () => {
    expect(await tierOf(IDS.dusty, 'merge.main')).toBe('cannot');
    const request = await asked(IDS.dusty, 'merge.main');
    const card = await load(request.approvalId);
    expect(card.whatHappens[0]).toBe('Give Dusty “Merge into main”, still asking a person each time');
    await t.commit(IDS.mara, decideApproval, { number: request.number, decision: 'approve' });
    expect(await tierOf(IDS.dusty, 'merge.main')).toBe('ask');
    expect(await tierOf(IDS.dusty, 'merge')).toBe('ask');
    expect(keyRowTier(await loadGrants(t.services.db, IDS.dusty), 'merge')).toBe('ask');
    // Asking again: held at ask, a person switches it to On in Settings → Agent.
    await expect(askFor(IDS.dusty, 'merge.main')).rejects.toMatchObject({
      message: expect.stringContaining('Dusty already holds “Merge into main” and asks a person each time.'),
    });
  });

  it('gives Push to main at ask, never On (contracts CT-222)', async () => {
    expect(await tierOf(IDS.dusty, 'branch.main.push')).toBeNull();
    const request = await asked(IDS.dusty, 'branch.main.push');
    await t.commit(IDS.mara, decideApproval, { number: request.number, decision: 'approve' });
    expect(await tierOf(IDS.dusty, 'branch.main.push')).toBe('ask');
    expect(keyRowTier(await loadGrants(t.services.db, IDS.dusty), 'branch.main.push')).toBe('ask');
    await expect(askFor(IDS.dusty, 'branch.main.push')).rejects.toMatchObject({
      message: expect.stringContaining('Dusty already holds “Push to main” and asks a person each time.'),
    });
  });

  it('gives a key that always asks at ask, replacing a cannot grant', async () => {
    expect(await tierOf(IDS.dusty, 'deploy')).toBe('cannot');
    const request = await asked(IDS.dusty, 'deploy');
    await t.commit(IDS.mara, decideApproval, { number: request.number, decision: 'approve' });
    expect(await tierOf(IDS.dusty, 'deploy')).toBe('ask');
    const [changed] = await keysEventsFor(request.approvalId);
    expect(changed).toMatchObject({
      actorId: IDS.mara,
      text: `Gave Dusty a new key that asks first: ${KEY_CATALOG.deploy.label}`,
    });
  });
});
