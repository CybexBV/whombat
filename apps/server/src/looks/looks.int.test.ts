/**
 * The assistant looks first (docs/decisions/look-research.md LR-01…LR-09), end to end on a real database: the watcher
 * sees a look on two passes and starts research — the assistant's quiet line in the person's Chat and a `look` turn —
 * the turn says what it found with `look_report`, Home's Needs you, the thing's page and the turn's context carry it,
 * the person's press (`looks.fix`) wakes a `look_fix` turn for exactly that step, a fixed report goes to Done today, the
 * research ends when the look goes and its thread settles, a look that comes back gets its finding back, and a thing
 * keeps one thread. Postgres because every step is a signed commit and a queued turn.
 */
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import {
  catalogConnections,
  dispatches,
  doneTasks,
  lookResearches,
  messages,
  notifications,
  principals,
} from '../db/schema/index';
import { homeOverview } from '../home/overview';
import { buildDispatchContext } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { thingPage } from '../things/page';
import { liveResearches } from './research';
import { REMEMBER_MS, RETRY_AFTER_MS, watchBurrow } from './watch';

const t = useTestServer({ seed: true, listen: true });
let mine: PersonalSetup;
let attic = '';
let cookie = '';
let before: Set<string> | null = null;
const ready = { ready: async () => true };

/** One watcher pass, remembering what it saw for the next. */
async function pass() {
  const out = await watchBurrow(t.services, TEST_BURROW_ID, before, ready);
  before = out?.seen ?? null;
  return out?.started ?? null;
}

async function research(key: string) {
  const [row] = await t.services.db
    .select()
    .from(lookResearches)
    .where(and(eq(lookResearches.lookKey, key), isNull(lookResearches.goneAt)));
  return row;
}

/** A connection's own state, as its card reads it. */
function glance(id: string, status: 'offline' | 'ok') {
  return t.services.db
    .update(catalogConnections)
    .set({
      glance: status === 'ok' ? { status, facts: [] } : { status, reason: 'Not answering', facts: [] },
      glanceAt: t.services.clock(),
    })
    .where(eq(catalogConnections.id, id));
}

/** A thread's first message and every message in it. */
async function thread(rootId: string) {
  return t.services.db
    .select()
    .from(messages)
    .where(or(eq(messages.id, rootId), eq(messages.threadRootId, rootId)))
    .orderBy(asc(messages.createdAt));
}

async function dispatchRow(id: string) {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!row) throw new Error(id);
  return row;
}

/** The assistant's tools in a turn, as its MCP client: its tool list and one call. */
async function inTurn(dispatchId: string) {
  const token = await issueDispatchToken(t.services, dispatchId);
  return mcpClient(t.baseUrl, token.token);
}

async function viewer() {
  const [principal] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const burrow = await t.services.db.query.burrows.findFirst();
  if (!principal || !burrow) throw new Error('viewer');
  return { principal, burrow };
}

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  // Only this test's things need a look: the seed's connections are fine.
  await t.services.db.update(catalogConnections).set({ status: 'active', glance: null });
  attic = await insertConnection(t.services, {
    catalogId: 'homeassistant',
    burrowId: TEST_BURROW_ID,
    label: 'Attic HA',
    handle: 'attic-ha',
    fields: { url: 'http://127.0.0.1:9' },
    secret: 'llat-attic',
  });
  await t.services.db
    .update(catalogConnections)
    .set({
      glance: { status: 'offline', reason: 'Not answering', facts: [] },
      glanceAt: t.services.clock(),
    })
    .where(eq(catalogConnections.id, attic));
});

describe('the assistant looks into a look by itself (look-research.md LR-01…LR-09)', () => {
  const key = () => `connection:${attic}`;

  it('waits a pass, then opens a quiet thread in the person’s Chat and queues a look turn there', async () => {
    expect(await pass()).toBeNull();
    expect(await research(key())).toBeUndefined();
    const id = await pass();
    expect(id).toMatch(/^lkr_/);
    const row = await research(key());
    expect(row).toMatchObject({ state: 'looking', conversationId: mine.dmId, kind: 'connection', rank: 0 });
    const [opening] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row?.threadRootId ?? ''));
    expect(opening).toMatchObject({ authorId: mine.agentId, threadRootId: null, subjectId: attic });
    expect(opening?.text).toContain('Attic HA');
    const turn = await dispatchRow(row?.dispatchId ?? '');
    expect(turn).toMatchObject({ trigger: 'look', state: 'queued', threadRootId: opening?.id });
    // Nothing pushed or in the inbox for it (LR-04).
    expect(
      await t.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.messageId, opening?.id ?? '')),
    ).toEqual([]);
    // Once per problem: the next pass starts nothing more for it.
    expect(await pass()).toBeNull();
    // The turn knows what it looks into and where.
    const context = await buildDispatchContext(t.services, turn);
    expect(context.look).toMatchObject({
      key: key(),
      kind: 'connection',
      state: 'down',
      connection: 'attic-ha',
      access: 'manage',
      reason: 'Not answering',
    });
    expect(context.look?.step).toBeUndefined();
  });

  it('serves look_report only in the look’s turn and keeps what it found; the screens carry it', async () => {
    const row = await research(key());
    const other = await agentTokenFor(t.services, TEST_BURROW_ID, mine.agentId, mine.dmId);
    const plain = await mcpClient(t.baseUrl, other.token);
    expect((await plain.client.listTools()).tools.map((x) => x.name)).not.toContain('look_report');
    const refused = await plain.client.callTool({
      name: 'look_report',
      arguments: { title: 'x', summary: 'y', fixed: false },
    });
    expect(refused.isError).toBe(true);
    await plain.close();

    const mcp = await inTurn(row?.dispatchId ?? '');
    expect((await mcp.client.listTools()).tools.map((x) => x.name)).toContain('look_report');
    // Its replies in the look's thread stay quiet too.
    const reply = await mcp.client.callTool({
      name: 'reply_in_thread',
      arguments: { messageId: row?.threadRootId, text: 'Still checking the add-on.' },
    });
    expect(reply.isError).toBeFalsy();
    const fixedAndStep = await mcp.client.callTool({
      name: 'look_report',
      arguments: {
        title: 'Zigbee stopped',
        summary: 'Zigbee stopped after the update.',
        fixed: true,
        fix: { label: 'Restart Zigbee', step: 'Reload ZHA.' },
      },
    });
    expect(fixedAndStep.isError).toBe(true);
    const res = await mcp.client.callTool({
      name: 'look_report',
      arguments: {
        title: 'Zigbee stopped after the update',
        summary:
          'The Zigbee add-on stopped after last night’s update,\nso the lights don’t answer. A restart should fix it.',
        fixed: false,
        fix: { label: 'Restart Zigbee', step: 'Restart the Zigbee add-on and check the lights answer.' },
      },
    });
    expect(res.isError).toBeFalsy();
    await mcp.close();
    await t.services.background.settle();
    const replies = await t.services.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.threadRootId, row?.threadRootId ?? ''), eq(messages.authorId, mine.agentId)));
    expect(replies.length).toBeGreaterThan(0);
    for (const m of replies)
      expect(
        await t.services.db.select().from(notifications).where(eq(notifications.messageId, m.id)),
      ).toEqual([]);

    const found = (await liveResearches(t.services.db, TEST_BURROW_ID)).get(key());
    expect(found).toMatchObject({
      state: 'found',
      title: 'Zigbee stopped after the update',
      fix: 'Restart Zigbee',
      conversationId: mine.dmId,
      threadRootId: row?.threadRootId,
    });
    // One line, as a screen draws it.
    expect(found?.summary).not.toContain('\n');
    const v = await viewer();
    const page = await thingPage(
      t.services,
      { accountId: v.principal.accountId ?? '', burrowId: TEST_BURROW_ID, principal: v.principal },
      key(),
      'Europe/Amsterdam',
    );
    expect(page.research).toMatchObject({ state: 'found', fix: 'Restart Zigbee' });
  });

  it('looks into the next look once the first is found, and Needs you carries it', async () => {
    const id = await insertConnection(t.services, {
      catalogId: 'homeassistant',
      burrowId: TEST_BURROW_ID,
      label: 'Barn HA',
      handle: 'barn-ha',
      fields: { url: 'http://127.0.0.1:9' },
      secret: 'llat-barn',
      status: 'needs_reauth',
    });
    const seeded = { id };
    expect(await pass()).toBeNull();
    expect(await pass()).toMatch(/^lkr_/);
    const home = await homeOverview(t.services, await viewer());
    const item = home.needsYou.find((i) => i.subject?.id === seeded?.id);
    expect(item?.research).toMatchObject({ key: `connection:${seeded?.id}`, state: 'looking' });
    // Asks never carry research.
    for (const i of home.needsYou.filter((x) => x.kind === 'approval' || x.kind === 'question'))
      expect(i.research).toBeUndefined();
  });

  it('takes the step on the person’s press: their words in the thread and a look_fix turn for it', async () => {
    const fix = (k: string) =>
      t.api.inject({
        method: 'POST',
        url: '/api/v1/burrows/burrow-hq/looks/fix',
        headers: { cookie },
        payload: { key: k },
      });
    expect((await fix('connection:con_nothing0001')).statusCode).toBe(404);
    const res = await fix(key());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().research).toMatchObject({ key: key(), state: 'fixing' });
    expect(res.json().research.fix).toBeUndefined();
    // Pressed once: no step is offered while it takes it.
    expect((await fix(key())).statusCode).toBe(404);

    const row = await research(key());
    const turn = await dispatchRow(row?.dispatchId ?? '');
    expect(turn).toMatchObject({ trigger: 'look_fix', state: 'queued', threadRootId: row?.threadRootId });
    const [said] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, turn.messageId ?? ''));
    expect(said).toMatchObject({ authorId: IDS.mara, threadRootId: row?.threadRootId });
    expect(said?.text).toContain('restart Zigbee');
    const context = await buildDispatchContext(t.services, turn);
    expect(context.look?.step).toEqual({
      label: 'Restart Zigbee',
      step: 'Restart the Zigbee add-on and check the lights answer.',
    });
    expect(context.look?.found?.title).toBe('Zigbee stopped after the update');

    const mcp = await inTurn(turn.id);
    const done = await mcp.client.callTool({
      name: 'look_report',
      arguments: { title: 'Zigbee works again', summary: 'I restarted the Zigbee add-on.', fixed: true },
    });
    expect(done.isError).toBeFalsy();
    await mcp.close();
    expect(await research(key())).toMatchObject({
      state: 'fixed',
      title: 'Zigbee works again',
      fixLabel: null,
    });
    // Fixed is Done today, in its words (LR-06).
    const [task] = await t.services.db
      .select()
      .from(doneTasks)
      .where(eq(doneTasks.threadRootId, row?.threadRootId ?? ''));
    expect(task?.summary).toBe('Zigbee works again');
  });

  it('ends the research when the look goes; a turn that ended unreported fails', async () => {
    // The second research's turn ended without a report.
    const [second] = await t.services.db
      .select()
      .from(lookResearches)
      .where(and(eq(lookResearches.state, 'looking'), isNull(lookResearches.goneAt)))
      .orderBy(asc(lookResearches.startedAt));
    await t.services.db
      .update(dispatches)
      .set({ state: 'failed' })
      .where(eq(dispatches.id, second?.dispatchId ?? ''));
    await t.services.db
      .update(catalogConnections)
      .set({ glance: { status: 'ok', facts: [] } })
      .where(eq(catalogConnections.id, attic));
    await pass();
    expect(await research(key())).toBeUndefined();
    const [gone] = await t.services.db.select().from(lookResearches).where(eq(lookResearches.lookKey, key()));
    expect(gone?.goneAt).not.toBeNull();
    expect((await research(second?.lookKey ?? ''))?.state).toBe('failed');
    expect((await liveResearches(t.services.db, TEST_BURROW_ID)).has(key())).toBe(false);
  });

  it('looks into a failed one once more in its thread a while later, and only once', async () => {
    const failed = await research(
      (
        await t.services.db
          .select()
          .from(lookResearches)
          .where(and(eq(lookResearches.state, 'failed'), isNull(lookResearches.goneAt)))
      )[0]?.lookKey ?? '',
    );
    if (!failed) throw new Error('no failed research');
    const back = () =>
      t.services.db
        .update(lookResearches)
        .set({ stateAt: new Date(t.services.clock().getTime() - RETRY_AFTER_MS) })
        .where(eq(lookResearches.id, failed.id));
    await back();
    await pass();
    const again = await research(failed.lookKey);
    expect(again?.state).toBe('looking');
    expect(again?.dispatchId).not.toBe(failed.dispatchId);
    const turn = await dispatchRow(again?.dispatchId ?? '');
    expect([turn.trigger, turn.threadRootId, turn.messageId]).toEqual([
      'look',
      failed.threadRootId,
      failed.threadRootId,
    ]);
    // That one ends unreported too: failed, and not tried a third time.
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, turn.id));
    await pass();
    expect((await research(failed.lookKey))?.state).toBe('failed');
    await back();
    await pass();
    expect((await research(failed.lookKey))?.state).toBe('failed');
  });

  it('settles a look’s thread once it goes, gives its finding back when it comes back, and keeps one thread', async () => {
    // The person wrote in Attic HA's thread (the step's go-ahead): it stays open.
    const [attics] = await t.services.db
      .select()
      .from(lookResearches)
      .where(eq(lookResearches.lookKey, key()));
    expect((await thread(attics?.threadRootId ?? ''))[0]?.settledAt).toBeNull();

    const shed = await insertConnection(t.services, {
      catalogId: 'homeassistant',
      burrowId: TEST_BURROW_ID,
      label: 'Shed HA',
      handle: 'shed-ha',
      fields: { url: 'http://127.0.0.1:9' },
      secret: 'llat-shed',
    });
    const shedKey = `connection:${shed}`;
    await glance(shed, 'offline');
    await pass();
    expect(await pass()).toMatch(/^lkr_/);
    const first = await research(shedKey);
    const root = first?.threadRootId ?? '';
    const mcp = await inTurn(first?.dispatchId ?? '');
    const res = await mcp.client.callTool({
      name: 'look_report',
      arguments: { title: 'Shed HA lost power', summary: 'The shed’s power is off.', fixed: false },
    });
    expect(res.isError).toBeFalsy();
    await mcp.close();
    await t.services.db
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, first?.dispatchId ?? ''));

    // Gone, and nobody wrote in its thread: the thread settles.
    await glance(shed, 'ok');
    await pass();
    expect(await research(shedKey)).toBeUndefined();
    expect((await thread(root))[0]).toMatchObject({ settledHow: 'resolved' });

    // Back as it was: the same finding at once, nothing posted, no turn.
    const said = (await thread(root)).length;
    await glance(shed, 'offline');
    expect(await pass()).toBeNull();
    expect(await research(shedKey)).toMatchObject({
      id: first?.id,
      state: 'found',
      title: 'Shed HA lost power',
    });
    expect((await thread(root)).length).toBe(said);
    const turns = await t.services.db.select().from(dispatches).where(eq(dispatches.threadRootId, root));
    expect(turns.length).toBe(1);

    // A finding that is too old is looked into again, as a reply in the thing's thread, which opens again.
    await t.services.db
      .update(lookResearches)
      .set({ stateAt: new Date(t.services.clock().getTime() - REMEMBER_MS) })
      .where(eq(lookResearches.id, first?.id ?? ''));
    await glance(shed, 'ok');
    await pass();
    await glance(shed, 'offline');
    expect(await pass()).toBeNull();
    const again = await pass();
    expect(again).toMatch(/^lkr_/);
    expect(again).not.toBe(first?.id);
    const second = await research(shedKey);
    expect(second?.threadRootId).toBe(root);
    const [head, ...replies] = await thread(root);
    expect(head?.settledAt).toBeNull();
    const opening = replies.at(-1);
    expect(opening).toMatchObject({ authorId: mine.agentId, threadRootId: root });
    expect(opening?.text).toContain('Shed HA');
    const turn = await dispatchRow(second?.dispatchId ?? '');
    expect(turn).toMatchObject({ trigger: 'look', threadRootId: root, messageId: opening?.id });
  });
});
