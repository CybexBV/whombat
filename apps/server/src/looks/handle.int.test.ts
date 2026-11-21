/**
 * The assistant handles what needs a look (docs/decisions/handle-it.md), end to end on a real database: *Ask
 * {assistant} to handle these* (`looks.handle`) starts a research of every line of the thing at once — the person's ask
 * in the thing's thread and a `look` turn that knows all the lines — the turn ends with one plan (`look_report` with
 * steps) that Whombat posts as one card and pushes once, the person's reply can change it, *Go ahead* (`looks.fix`)
 * wakes a `look_fix` turn for exactly those steps, and the card says what was done. Postgres because every step is a
 * signed commit and a queued turn.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import {
  catalogConnections,
  dispatches,
  doneTasks,
  lookResearches,
  messages,
  notifications,
} from '../db/schema/index';
import { loadMessageRow, loadMessages } from '../read/messages';
import { buildDispatchContext } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { researchesSince } from './research';

const t = useTestServer({ seed: true, listen: true });
let mine: PersonalSetup;
let loft = '';
let cookie = '';

const key = () => `connection:${loft}`;

async function research() {
  const [row] = await t.services.db
    .select()
    .from(lookResearches)
    .where(and(eq(lookResearches.lookKey, key()), isNull(lookResearches.goneAt)));
  if (!row) throw new Error('no research');
  return row;
}

async function dispatchRow(id: string) {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!row) throw new Error(id);
  return row;
}

async function inTurn(dispatchId: string) {
  const token = await issueDispatchToken(t.services, dispatchId);
  return mcpClient(t.baseUrl, token.token);
}

function post(path: string, payload: object) {
  return t.api.inject({
    method: 'POST',
    url: `/api/v1/burrows/burrow-hq/looks/${path}`,
    headers: { cookie },
    payload,
  });
}

/** The plan card as a client reads it. */
async function card(messageId: string) {
  const row = await loadMessageRow(t.services.db, messageId);
  if (!row) throw new Error(messageId);
  const [m] = await loadMessages(t.services.db, [row], IDS.mara);
  return m?.card?.kind === 'look_plan' ? m.card.plan : undefined;
}

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  await t.services.db.update(catalogConnections).set({ status: 'active', glance: null });
  loft = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: TEST_BURROW_ID,
    label: 'Loft HA',
    handle: 'loft-ha',
    fields: { url: 'http://127.0.0.1:9' },
    secret: 'llat-loft',
  });
  // Two lines that ask, and a heads-up the research leaves out.
  await t.services.db
    .update(catalogConnections)
    .set({
      glance: {
        status: 'warn',
        facts: [],
        lines: [
          {
            check: 'homeassistant.integration',
            tone: 'warn',
            nature: 'problem',
            title: 'Zigbee isn’t loading',
          },
          { check: 'homeassistant.backup', tone: 'warn', nature: 'you', title: 'No backup in 9 days' },
          { check: 'homeassistant.updates', tone: 'info', nature: 'fyi', title: '2 updates waiting' },
        ],
      },
      glanceAt: t.services.clock(),
    })
    .where(eq(catalogConnections.id, loft));
});

describe('Ask {assistant} to handle these (handle-it.md)', () => {
  it('refuses a thing where nothing needs a look', async () => {
    const res = await post('handle', { key: 'connection:con_nothing0001' });
    expect(res.statusCode).toBe(404);
  });

  it('starts at once on every line: the person’s ask in a thread and a look turn that knows them', async () => {
    const res = await post('handle', { key: key() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().research).toMatchObject({ key: key(), state: 'looking' });
    const row = await research();
    expect(row.askedById).toBe(IDS.mara);
    expect(row.lines.map((l) => l.check)).toEqual(['homeassistant.integration', 'homeassistant.backup']);
    const [ask] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row.threadRootId ?? ''));
    expect(ask).toMatchObject({ authorId: IDS.mara, threadRootId: null, subjectId: loft });
    expect(ask?.text).toContain('Loft HA');
    const turn = await dispatchRow(row.dispatchId ?? '');
    expect(turn).toMatchObject({ trigger: 'look', state: 'queued', threadRootId: ask?.id });
    const context = await buildDispatchContext(t.services, turn);
    expect(context.look).toMatchObject({ key: key(), asked: true, connection: 'loft-ha' });
    expect(context.look?.lines?.map((l) => l.title)).toEqual(['Zigbee isn’t loading', 'No backup in 9 days']);
    // The person's ask isn't the watcher's: the day's researches don't count it.
    const today = await researchesSince(t.services.db, TEST_BURROW_ID, new Date(0));
    expect(today.get(key())).toBeUndefined();
    // Asked again while it looks: the same research, no second turn.
    const again = await post('handle', { key: key() });
    expect(again.json().research.state).toBe('looking');
    expect((await research()).id).toBe(row.id);
    const got = await t.api.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/looks/research?key=${encodeURIComponent(key())}`,
      headers: { cookie },
    });
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json().research).toMatchObject({ key: key(), state: 'looking' });
  });

  it('ends in one plan: one card in the thread, pushed once, no step button', async () => {
    const row = await research();
    const mcp = await inTurn(row.dispatchId ?? '');
    const res = await mcp.client.callTool({
      name: 'look_report',
      arguments: {
        title: 'Zigbee stopped and nothing is backed up',
        summary: 'Zigbee stopped after an update and the last backup is nine days old.',
        fixed: false,
        steps: [
          { text: 'Restart Zigbee', step: 'Reload the ZHA integration and check the lights answer.' },
          {
            text: 'Back up Home Assistant every night at 02:00, keeping a week',
            step: 'Create a nightly backup.',
          },
        ],
      },
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    await mcp.close();
    // Its turn ended, as the runner would end it.
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, row.dispatchId ?? ''));
    await t.services.background.settle();
    const found = await research();
    expect(found.state).toBe('found');
    expect(found.plan).toHaveLength(2);
    expect(found.fixLabel).toBeNull();
    expect(found.planMessageId).toBeTruthy();
    const plan = await card(found.planMessageId ?? '');
    expect(plan).toMatchObject({ name: 'Loft HA', state: 'waiting' });
    expect(plan?.steps[1]).toContain('02:00');
    expect(plan?.research?.plan).toHaveLength(2);
    expect(plan?.research?.fix).toBeUndefined();
    // The finding reaches the person once, opening the card.
    const pushed = await t.services.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.principalId, IDS.mara), eq(notifications.messageId, found.planMessageId ?? '')),
      );
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.kind).toBe('needs_you');
    expect(pushed[0]?.text).toContain('2 steps');
  });

  it('lets the person’s reply in the thread change the plan, on the same card', async () => {
    const row = await research();
    const sent = await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      text: 'Make the backup weekly instead.',
      threadRootId: row.threadRootId ?? undefined,
    });
    if (sent.status !== 'ok') throw new Error(sent.status);
    const [reply] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.messageId, (sent.result as { id: string }).id));
    if (!reply) throw new Error('no reply turn');
    expect(reply.trigger).toBe('dm');
    const context = await buildDispatchContext(t.services, reply);
    expect(context.look?.waiting).toBe(true);
    expect(context.look?.plan).toHaveLength(2);
    const mcp = await inTurn(reply.id);
    expect((await mcp.client.listTools()).tools.map((x) => x.name)).toContain('look_report');
    const res = await mcp.client.callTool({
      name: 'look_report',
      arguments: {
        title: 'Zigbee stopped and nothing is backed up',
        summary: 'Zigbee stopped after an update and the last backup is nine days old.',
        fixed: false,
        steps: [
          { text: 'Restart Zigbee', step: 'Reload the ZHA integration.' },
          { text: 'Back up Home Assistant every Sunday at 02:00', step: 'Create a weekly backup.' },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    await mcp.close();
    await t.services.background.settle();
    const changed = await research();
    expect(changed.planMessageId).toBe(row.planMessageId);
    expect((await card(row.planMessageId ?? ''))?.steps[1]).toContain('Sunday');
    const cards = await t.services.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          or(eq(messages.id, row.threadRootId ?? ''), eq(messages.threadRootId, row.threadRootId ?? '')),
          eq(messages.authorId, mine.agentId),
        ),
      );
    expect(cards.filter((c) => c.id === row.planMessageId)).toHaveLength(1);
    // Pushed once per research.
    expect(
      await t.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.messageId, row.planMessageId ?? '')),
    ).toHaveLength(1);
  });

  it('takes exactly the plan on Go ahead, and the card says what was done', async () => {
    const res = await post('fix', { key: key() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().research).toMatchObject({ state: 'fixing' });
    expect(res.json().research.plan).toHaveLength(2);
    const row = await research();
    expect((await card(row.planMessageId ?? ''))?.state).toBe('doing');
    const turn = await dispatchRow(row.dispatchId ?? '');
    expect(turn.trigger).toBe('look_fix');
    const [said] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, turn.messageId ?? ''));
    expect(said).toMatchObject({ authorId: IDS.mara, threadRootId: row.threadRootId, text: 'Go ahead.' });
    const context = await buildDispatchContext(t.services, turn);
    expect(context.look?.plan?.map((p) => p.step)).toEqual([
      'Reload the ZHA integration.',
      'Create a weekly backup.',
    ]);
    // Asking again while it works: the same research.
    expect((await post('handle', { key: key() })).json().research.state).toBe('fixing');

    const mcp = await inTurn(turn.id);
    const done = await mcp.client.callTool({
      name: 'look_report',
      arguments: {
        title: 'Zigbee works and backups run',
        summary: 'I restarted Zigbee and set up the backup.',
        fixed: true,
      },
    });
    expect(done.isError).toBeFalsy();
    await mcp.close();
    const fixed = await research();
    expect(fixed.state).toBe('fixed');
    expect(await card(row.planMessageId ?? '')).toMatchObject({
      state: 'done',
      title: 'Zigbee works and backups run',
    });
    const [task] = await t.services.db
      .select()
      .from(doneTasks)
      .where(eq(doneTasks.threadRootId, row.threadRootId ?? ''));
    expect(task?.summary).toBe('Zigbee works and backups run');
  });

  it('looks again when asked once it fixed what was there, and the old card is no longer needed', async () => {
    const old = await research();
    const res = await post('handle', { key: key() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().research.state).toBe('looking');
    const fresh = await research();
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.threadRootId).toBe(old.threadRootId);
    const [gone] = await t.services.db.select().from(lookResearches).where(eq(lookResearches.id, old.id));
    expect(gone?.goneAt).not.toBeNull();
    // A done plan stays done.
    expect((await card(old.planMessageId ?? ''))?.state).toBe('done');
  });
});
