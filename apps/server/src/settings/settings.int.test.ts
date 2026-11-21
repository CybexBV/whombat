/**
 * The assistant's settings tools end to end (docs/decisions/assistant-settings.md) on a managed runtime: find and read
 * through the session dispatcher as the person, a change at Ask me first that a card asks and the person's yes runs
 * once, as them; Go ahead at once, a change that always asks, one that stays the person's, and Just watch. Postgres
 * because a change is a keyed command, a signed event and an approval through the commit pipeline.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { accounts, approvals, burrows, events, grants, messages } from '../db/schema/index';
import { sessionDispatcherOf } from '../managed/dispatcher-ref';
import type { DispatchRow } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { waitFor } from '../test/runner';
import { accountOf } from '../test/tokens';
import { settingsChangeTool, settingsFindTool, settingsOpenTool, settingsReadTool } from './tools';

const m = useManagedRuntime({ seed: true });
let mine: PersonalSetup;
let accountId: string;

beforeAll(async () => {
  mine = await addPersonalAgent(m.t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  accountId = (await accountOf(m.t.services, IDS.mara)) as string;
});

/** A turn of Mara's assistant in her Chat. */
const ctx = () => ({
  services: m.t.services,
  agentId: mine.agentId,
  burrowId: TEST_BURROW_ID,
  dispatch: {
    id: 'dsp_settings',
    burrowId: TEST_BURROW_ID,
    agentId: mine.agentId,
    onBehalfOfAccountId: accountId,
    conversationId: mine.dmId,
    threadRootId: null,
  } as DispatchRow,
  onBehalfOf: {},
});

async function setTier(tier: 'can' | 'ask' | 'cannot') {
  await m.t.services.db
    .update(grants)
    .set({ tier })
    .where(and(eq(grants.agentId, mine.agentId), eq(grants.keyId, 'settings.change')));
}

async function title(): Promise<string | null> {
  const [row] = await m.t.services.db.select().from(accounts).where(eq(accounts.id, accountId));
  return row?.title ?? null;
}

describe('the assistant’s settings tools', () => {
  it('starts at Ask me first', async () => {
    const [g] = await m.t.services.db
      .select()
      .from(grants)
      .where(and(eq(grants.agentId, mine.agentId), eq(grants.keyId, 'settings.change')));
    expect(g?.tier).toBe('ask');
  });

  it('finds where Wi-Fi only is, and that it always asks', async () => {
    const out = await settingsFindTool(ctx(), { query: 'wifi only' });
    expect(out.status).toBe('ok');
    const hit = out.status === 'ok' ? out.settings.find((s) => s.op === 'host.cable.set') : null;
    expect(hit).toMatchObject({ access: 'ask', page: 'appliance.overview' });
    expect(hit?.where).toContain('This Whombat');
    expect(hit?.input).toBeTruthy();
  });

  it('lists the pages for an empty query', async () => {
    const out = await settingsFindTool(ctx(), { query: '' });
    expect(out.status === 'ok' && out.pages?.map((p) => p.page)).toContain('appliance.backups');
  });

  it('reads a setting as the person, the Whombat filled in', async () => {
    const out = await settingsReadTool(ctx(), { op: 'burrows.get', input: {} });
    expect(out).toMatchObject({ status: 'ok', op: 'burrows.get', truncated: false });
  });

  it('asks on a card at Ask me first, and the yes runs it once as the person', async () => {
    const out = await settingsChangeTool(ctx(), {
      op: 'me.updateProfile',
      input: { body: { title: 'Head gardener' } },
    });
    expect(out.status).toBe('pending_approval');
    // Nothing changed before the yes.
    expect(await title()).not.toBe('Head gardener');
    const [approval] = await m.t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, out.status === 'pending_approval' ? out.approvalId : ''));
    expect(approval?.state).toBe('pending');
    expect(approval?.title).toBe('Change your name and title');
    const res = await m.t.services.pipeline.commit(
      decideApproval,
      { number: approval?.number as number, decision: 'approve' },
      { burrowId: TEST_BURROW_ID, actorId: IDS.mara },
    );
    expect(res.status).toBe('ok');
    await waitFor(async () => ((await title()) === 'Head gardener' ? true : null), 15_000, 'the change');
  });

  it('goes ahead at once at Go ahead, signing that it did', async () => {
    await setTier('can');
    const out = await settingsChangeTool(ctx(), {
      op: 'me.updateProfile',
      input: { body: { title: 'Gardener' } },
    });
    expect(out).toMatchObject({ status: 'done', op: 'me.updateProfile' });
    expect(await title()).toBe('Gardener');
    const signed = await m.t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'setting.changed'), eq(events.actorId, mine.agentId)));
    expect(signed.length).toBeGreaterThanOrEqual(2);
  });

  it('still asks first for a change that always asks', async () => {
    const out = await settingsChangeTool(ctx(), { op: 'host.cable.set', input: { use: 'wifi' } });
    expect(out.status).toBe('pending_approval');
  });

  it('refuses an input the op doesn’t take before asking anyone', async () => {
    const out = await settingsChangeTool(ctx(), { op: 'host.cable.set', input: { use: 'carrier pigeon' } });
    expect(out).toMatchObject({ status: 'failed', reason: 'invalid' });
  });

  it('leaves the person’s own settings to them, and opens the page', async () => {
    const out = await settingsChangeTool(ctx(), { op: 'agent.setKeys', input: {} });
    expect(out).toMatchObject({ status: 'failed', reason: 'never' });
    const read = await settingsReadTool(ctx(), { op: 'me.updateProfile', input: {} });
    expect(read).toMatchObject({ status: 'failed', reason: 'wrong_tool' });
    const opened = await settingsOpenTool(ctx(), { page: 'agent.may', text: 'Switch it here.' });
    expect(opened.status).toBe('ok');
    const [card] = await m.t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, opened.status === 'ok' ? opened.messageId : ''));
    expect(JSON.stringify(card?.card)).toContain('settings?tab=agent&part=may');
  });

  it('leaves a connection’s address and access to the person, even at Go ahead', async () => {
    const id = 'con_settings_guard';
    const moved = await settingsChangeTool(ctx(), {
      op: 'connections.update',
      input: { params: { connectionId: id }, body: { fields: { url: 'https://example.com' } } },
    });
    expect(moved).toMatchObject({ status: 'failed', reason: 'never' });
    const lifted = await settingsChangeTool(ctx(), {
      op: 'connections.update',
      input: { params: { connectionId: id }, body: { label: 'Plex', access: 'manage' } },
    });
    expect(lifted).toMatchObject({ status: 'failed', reason: 'never' });
    // Not even a run the tools didn't decide: the dispatcher checks the input too.
    const [account] = await m.t.services.db.select().from(accounts).where(eq(accounts.id, accountId));
    const [burrow] = await m.t.services.db.select().from(burrows).where(eq(burrows.id, TEST_BURROW_ID));
    const answer = await sessionDispatcherOf(m.t.services)?.runForAssistant(
      account as NonNullable<typeof account>,
      mine.agentId,
      'connections.update',
      { params: { burrow: burrow?.slug, connectionId: id }, body: { access: 'manage' } },
    );
    expect(answer).toMatchObject({ type: 'error', code: 'forbidden' });
  });

  it('asks before switching a check off, even at Go ahead', async () => {
    const out = await settingsChangeTool(ctx(), {
      op: 'hosts.updateCheck',
      input: { params: { checkId: 'chk_settings_guard' }, body: { enabled: false } },
    });
    expect(out.status).toBe('pending_approval');
  });

  it('is refused at Just watch, with where to go', async () => {
    await setTier('cannot');
    const out = await settingsChangeTool(ctx(), { op: 'me.updateProfile', input: { body: { title: 'x' } } });
    expect(out).toMatchObject({ status: 'blocked' });
    expect(out.status === 'blocked' && out.where).toContain('Profile');
  });
});
