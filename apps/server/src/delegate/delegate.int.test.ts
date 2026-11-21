import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { api, buildPath, DelegationCard, newId } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startT3Code, type T3CodeStub } from '../connections/testing/t3code-stub';
import { hashToken } from '../council/run';
import { inProcessShots, setShotRunner } from '../council/shots-pool';
import {
  attachments,
  delegationShots,
  delegations,
  delegationTasks,
  dispatches,
  messages,
  notifications,
  pullRequests,
  t3Watches,
  vaultNetworks,
} from '../db/schema/index';
import { loadMessages } from '../read/messages';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { progressOf } from '../t3code/progress';
import { T3Watcher } from '../t3code/watch';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { delegationCompare } from './shots';
import { shotUploads } from './upload';

const t = useTestServer({ seed: true, listen: true });

const HOSTS: Record<string, string> = { 't3.delegate.test': '192.168.94.10' };
/** The thread of Mara's chat with Dusty the card is in. */
const ROOT = 'msg_dm-mara-1402';

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

let t3: T3CodeStub;
let mara = '';
let cookie = '';

const db = () => t.services.db;
const pass = () => new T3Watcher(t.services).pass();
/** Whether Whombat settles the thread in T3 Code once it has been quiet (settling it at once would stop its commands). */
const settles = async (threadId: string) =>
  progressOf((await db().select().from(t3Watches).where(eq(t3Watches.threadId, threadId)))[0]?.progress)
    .settle !== null;
const launches = () => t3.calls.filter((c) => c.name === 't3_thread_launch');

/** A turn of Dusty's for Mara in the thread, with its MCP client. */
async function turn(trigger?: 'delegation') {
  const d = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.dmDusty, {
    onBehalfOfAccountId: mara,
    threadRootId: ROOT,
    ...(trigger ? { trigger } : {}),
  });
  const mcp = await mcpClient(t.baseUrl, d.token);
  return {
    id: d.dispatchId,
    async call(name: string, args: Record<string, unknown>): Promise<Json> {
      const res = await mcp.client.callTool({ name, arguments: args });
      return (res.structuredContent ?? {}) as Json;
    },
    async tools(): Promise<string[]> {
      return (await mcp.client.listTools()).tools.map((x) => x.name);
    },
    /** The turn's context, as the runner gets it; it issues the turn a new token, so it comes last. */
    async context() {
      const [row] = await db().select().from(dispatches).where(eq(dispatches.id, d.dispatchId));
      return buildDispatchContext(t.services, row as NonNullable<typeof row>);
    },
    async end() {
      await mcp.close();
      await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, d.dispatchId));
    },
  };
}

/** The agent's replies under a card, oldest first. */
async function repliesUnder(cardId: string) {
  const [shown] = await db().select().from(messages).where(eq(messages.id, cardId));
  const rows = await db()
    .select()
    .from(messages)
    .where(eq(messages.threadRootId, shown?.threadRootId ?? cardId));
  return rows
    .filter((m) => m.authorId === IDS.dusty && m.ord > (shown?.ord ?? 0))
    .sort((x, y) => x.ord - y.ord);
}

async function card(delegationId: string) {
  const [d] = await db().select().from(delegations).where(eq(delegations.id, delegationId));
  const [m] = await db()
    .select()
    .from(messages)
    .where(eq(messages.id, d?.messageId ?? ''));
  return { message: m, card: DelegationCard.parse(m?.card) };
}

/** A delegation's own tasks in their order, without Whombat's check of everything together (`finalOf`). */
async function tasksOf(delegationId: string) {
  const rows = await db()
    .select()
    .from(delegationTasks)
    .where(eq(delegationTasks.delegationId, delegationId));
  return rows.filter((r) => r.kind === 'task').sort((a, b) => a.position - b.position);
}

/** The check of everything together Whombat adds to a list it merges (DLG-41). */
async function finalOf(delegationId: string) {
  const [row] = await db()
    .select()
    .from(delegationTasks)
    .where(and(eq(delegationTasks.delegationId, delegationId), eq(delegationTasks.kind, 'final')));
  return row ?? null;
}

async function wakes() {
  return db()
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.trigger, 'delegation')));
}

async function doneWithWakes() {
  for (const w of await wakes())
    if (w.state === 'queued')
      await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, w.id));
}

async function press(op: 'pick' | 'start' | 'stop' | 'stopTask' | 'setAi', payload: Record<string, unknown>) {
  const ep = api.delegations[op];
  return t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie },
    payload,
  });
}

beforeAll(async () => {
  // This suite exercises upgraded lists, handed over before one thread led them all and the combined candidate: they
  // still merge each source PR in turn. Fresh lists are covered in safety.int.test.ts and batch.int.test.ts.
  await t.services.db.execute(
    sql`alter table delegations alter column integration_mode set default 'legacy'`,
  );
  t3 = await startT3Code();
  // A worker started from TypeScript source needs the server's loader: the same jobs run in-process here.
  setShotRunner(t.services, inProcessShots());
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const address = HOSTS[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith('192.168.94.') ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await db()
    .insert(vaultNetworks)
    .values({
      id: 'vnw_delegate_test',
      cidr: '192.168.94.0/24',
      ports: [t3.port],
      note: 'T3 Code stand-in',
      addedAt: t.services.clock(),
    });
  ({ cookie } = await sessionFor(t.services, IDS.mara));
  mara = await accountOf(t.services, IDS.mara);
  await setConnectionKeys(t.services, IDS.dusty, { read: 'can', write: 'can' });
  const ep = api.connections.create;
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie },
    payload: {
      catalogId: 't3code',
      signIn: 'password',
      fields: { url: `http://t3.delegate.test:${t3.port}` },
      login: { password: t3.pairingCode() },
      access: 'manage',
    },
  });
  expect(res.statusCode).toBe(201);
});

afterAll(async () => {
  await t3?.close();
});

describe('a checklist handed to T3 Code', () => {
  let id = '';

  it('is offered as a card under the agent’s intro, and nothing starts', async () => {
    const a = await turn();
    expect(await a.tools()).toEqual(
      expect.arrayContaining(['delegate_offer', 'delegate_update', 'delegate_finish']),
    );
    const res = await a.call('delegate_offer', {
      title: 'Polish the Settings page',
      intro: 'Tick the ones you want.',
      project: 'Demo site',
      atOnce: 2,
      // The person reviews and merges these themselves.
      merge: false,
      tasks: [
        { title: 'Taller buttons', why: 'Easier to tap.', brief: 'Make every button 44px tall.' },
        { title: 'Plainer names', brief: 'Rename the sections.' },
        { title: 'Search box', brief: 'Add a search box.', picked: false },
        { title: 'Dark mode pictures', brief: 'Shots in dark mode.', after: 1 },
      ],
    });
    await a.end();
    expect(res).toMatchObject({ status: 'offered' });
    expect(res.message).toContain('3. Search box (not ticked)');
    id = res.delegationId;
    expect(launches()).toHaveLength(0);
    const { message, card: c } = await card(id);
    expect(message?.text).toBe('Tick the ones you want.');
    expect(message?.threadRootId).toBe(ROOT);
    expect(c).toMatchObject({
      stage: 'offer',
      live: true,
      atOnce: 2,
      pullRequests: true,
      project: 'Demo site',
    });
    expect(c.tasks.map((x) => [x.n, x.picked, x.after])).toEqual([
      [1, true, null],
      [2, true, null],
      [3, false, null],
      [4, true, 1],
    ]);
  });

  it('changes with the person’s ticks and with what they say in the thread', async () => {
    const tasks = await tasksOf(id);
    const ticked = await press('pick', { delegationId: id, taskId: tasks[2]?.id, picked: true });
    expect(ticked.statusCode).toBe(200);
    expect((await card(id)).card.tasks[2]?.picked).toBe(true);

    // Mara writes in the thread: her turn carries the card, and the agent changes it there.
    const look = await turn();
    const ctx = await look.context();
    await look.end();
    expect(ctx.delegation).toMatchObject({ delegationId: id, event: 'reply', stage: 'offer' });
    expect(ctx.delegation?.tasks.map((x) => x.title)).toContain('Search box');
    const a = await turn();
    const res = await a.call('delegate_update', {
      delegationId: id,
      remove: [3],
      add: [{ title: 'Undo on reset', brief: 'Let the person undo a reset.' }],
      change: [{ n: 2, title: 'Plainer section names' }],
    });
    await a.end();
    expect(res).toMatchObject({ status: 'ok' });
    expect(res.message).toContain('4. Undo on reset');
    const c = (await card(id)).card;
    expect(c.tasks.map((x) => x.title)).toEqual([
      'Taller buttons',
      'Plainer section names',
      'Dark mode pictures',
      'Undo on reset',
    ]);
    // What a task comes after follows it to its new number.
    expect(c.tasks[2]?.after).toBe(1);
  });

  it('hands the ticked tasks over, as many at once as it may, each on a branch of its own', async () => {
    const res = await press('start', { delegationId: id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stage: 'working' });
    const started = launches();
    expect(started).toHaveLength(2);
    for (const call of started) {
      expect(String(call.args.title)).toMatch(/^Dusty - /);
      expect((call.args.workspaceStrategy as Json).branch).toMatch(/^delegate\//);
      expect(call.args.message).toContain('pull request');
    }
    // The task after the first waits to start too: it is done in the first's thread, in its brief (DLG-42).
    const withFirst = started.find((call) =>
      String(call.args.message).includes('Make every button 44px tall.'),
    );
    expect(String(withFirst?.args.message)).toContain('Shots in dark mode.');
    const c = (await card(id)).card;
    expect(c.tasks.map((x) => x.state)).toEqual(['working', 'working', 'working', 'queued']);
    const rows = await tasksOf(id);
    expect(rows[2]?.threadId).toBe(rows[0]?.threadId);
    expect(rows[2]?.branch).toBe(rows[0]?.branch);
    // No pull requests merged by Whombat here: no check of everything together.
    expect(await finalOf(id)).toBeNull();
    // Watched for the card, not shown as hand-overs; a second press is refused.
    const watches = await db()
      .select()
      .from(t3Watches)
      .where(eq(t3Watches.delegationTaskId, c.tasks[0]?.id ?? ''));
    expect(watches).toHaveLength(1);
    expect((await press('start', { delegationId: id })).statusCode).toBe(409);
  });

  it('reads a task’s end, its pull request and its line for the person, ends the one done with it, starts the next, and wakes nobody', async () => {
    const [first] = await tasksOf(id);
    t3.linkPullRequest(first?.threadId as string, 'https://github.com/acme/site/pull/41');
    t3.finish(
      first?.threadId as string,
      'The buttons are 44px now. Opened a pull request.\nItem 1: The buttons are taller now.\nItem 3: The dark mode pictures are in.\nNote: The buttons are taller now.\nChecks: passing',
    );
    await pass();
    const tasks = await tasksOf(id);
    expect(tasks[0]).toMatchObject({
      state: 'done',
      pr: 'https://github.com/acme/site/pull/41',
      checks: 'passing',
      note: 'The buttons are taller now.',
    });
    expect(await settles(first?.threadId as string)).toBe(true);
    // The task done in its thread ended with it, in its pull request, with its own line.
    expect(tasks[2]).toMatchObject({
      state: 'done',
      pr: 'https://github.com/acme/site/pull/41',
      note: 'The dark mode pictures are in.',
    });
    // Its place goes to the next one, on a branch of its own.
    const next = launches().at(-1);
    expect((next?.args.workspaceStrategy as Json | undefined)?.branch).toBe(tasks[3]?.branch);
    expect(tasks[3]?.state).toBe('working');
    // A task that went well wakes nobody: its row says it.
    expect(await wakes()).toHaveLength(0);
    expect((await card(id)).card.tasks[0]).toMatchObject({
      note: 'The buttons are taller now.',
      checks: 'passing',
    });

    // Mara asks about it in the thread: the agent changes the card in her turn.
    const a = await turn();
    expect(
      await a.call('delegate_update', {
        delegationId: id,
        note: 'The buttons are done; two more at work.',
        change: [{ n: 1, note: 'Taller now; pull request ready.' }],
      }),
    ).toMatchObject({ status: 'ok' });
    await a.end();
    const { message: shown, card: c } = await card(id);
    // Its words are a reply of their own under the card, which tells nobody; the card doesn't take them.
    expect(c.note ?? '').not.toContain('two more');
    const said = await repliesUnder(shown?.id ?? '');
    expect(said.at(-1)?.text).toContain('two more');
    await t.services.background.settle();
    const quiet = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.messageId, said.at(-1)?.id ?? ''));
    expect(quiet).toEqual([]);
    expect(c.tasks[0]).toMatchObject({
      note: 'Taller now; pull request ready.',
      pr: expect.stringContaining('/41'),
    });
  });

  it('shows a task’s question on its row, and stops one task on the person’s Stop', async () => {
    const tasks = await tasksOf(id);
    const second = tasks[1];
    t3.ask(second?.threadId as string, 'req-1', 'Keep the old names as hints?', ['Yes', 'No']);
    await pass();
    expect((await card(id)).card.tasks[1]?.pending).toBe('question');
    const asked = await db()
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.trigger, 't3_thread')));
    expect(asked).toHaveLength(1);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, asked[0]?.id as string));

    const res = await press('stopTask', { delegationId: id, taskId: second?.id });
    expect(res.statusCode).toBe(200);
    expect(
      t3.calls.some((c) => c.name === 't3_thread_interrupt' && c.args.threadId === second?.threadId),
    ).toBe(true);
    expect((await tasksOf(id)).map((x) => x.state)).toEqual(['done', 'stopped', 'done', 'working']);
  });

  it('says when all are over, and ends with the agent’s summary', async () => {
    for (const task of await tasksOf(id))
      if (task.state === 'working') t3.finish(task.threadId as string, `Done: ${task.title}.`);
    await pass();
    const all = (await wakes()).find((w) => w.state === 'queued');
    const ctx = await buildDispatchContext(t.services, all as NonNullable<typeof all>);
    expect(ctx.delegation?.event).toBe('all');
    await doneWithWakes();
    const a = await turn('delegation');
    const early = await a.call('delegate_finish', { delegationId: id, summary: 'Three of four are done.' });
    await a.end();
    expect(early).toMatchObject({ status: 'finished' });
    const { message, card: c } = await card(id);
    expect(c).toMatchObject({ live: false, stage: 'done', outcome: 'incomplete' });
    // The thread went on under the card, so its news moved it to the end on a message of its own; the intro stays where
    // it was said, without the card, and the earlier words stay between them.
    expect(message?.text).toBe('');
    const thread = (
      await db()
        .select()
        .from(messages)
        .where(eq(messages.threadRootId, message?.threadRootId ?? ''))
    ).sort((x, y) => x.ord - y.ord);
    const intro = thread.find((m) => m.text === 'Tick the ones you want.');
    expect(intro?.card).toBeNull();
    expect(intro?.movedCard).toEqual({ kind: 'delegation', id });
    expect(thread.filter((m) => (m.card as { kind?: string } | null)?.kind === 'delegation')).toHaveLength(1);
    const between = thread.filter((m) => intro && message && m.ord > intro.ord && m.ord < message.ord);
    expect(between.some((m) => m.text.includes('two more'))).toBe(true);
    // The summary is the last reply, under the card, and it tells the person.
    expect(c.note ?? '').not.toContain('Three of four');
    const said = await repliesUnder(message?.id ?? '');
    expect(said.at(-1)?.text).toBe('Three of four are done.');
    await t.services.background.settle();
    const told = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.messageId, said.at(-1)?.id ?? ''));
    expect(told.length).toBeGreaterThan(0);
  });

  it('opens again when the person asks for a task to be tried again', async () => {
    const look = await turn();
    expect((await look.context()).delegation).toMatchObject({
      delegationId: id,
      event: 'reply',
      stage: 'done',
    });
    await look.end();
    const a = await turn();
    const before = launches().length;
    const res = await a.call('delegate_update', { delegationId: id, retry: [2] });
    await a.end();
    expect(res).toMatchObject({ status: 'ok' });
    expect(launches()).toHaveLength(before + 1);
    const branch = (launches().at(-1)?.args.workspaceStrategy as Json | undefined)?.branch as string;
    expect(branch).toMatch(/-2$/);
    const c = (await card(id)).card;
    expect(c).toMatchObject({ live: true, stage: 'working', outcome: null });
    expect(c.tasks[1]?.state).toBe('working');
    // Stop it all: every task at work stops.
    expect((await press('stop', { delegationId: id })).statusCode).toBe(200);
    expect((await card(id)).card).toMatchObject({ live: false, stage: 'stopped' });
  });
});

describe('a checklist the person doesn’t want', () => {
  it('ends on Not now, and a second card can then be offered in the thread', async () => {
    const a = await turn();
    const res = await a.call('delegate_offer', {
      title: 'Tidy the Inbox',
      intro: 'Want me to hand these over?',
      project: 'Demo site',
      tasks: [{ title: 'One line per item', brief: 'Make each item one line.' }],
    });
    expect(res).toMatchObject({ status: 'offered' });
    // One card at a time in a thread.
    expect(
      await a.call('delegate_offer', {
        title: 'Again',
        intro: 'Again.',
        tasks: [{ title: 'Again', brief: 'Again.' }],
      }),
    ).toMatchObject({ status: 'refused', reason: 'busy' });
    await a.end();
    const before = launches().length;
    expect((await press('stop', { delegationId: res.delegationId })).statusCode).toBe(200);
    expect(launches()).toHaveLength(before);
    expect((await card(res.delegationId)).card).toMatchObject({
      live: false,
      stage: 'stopped',
      handedAt: null,
    });
  });
});

describe('a Tasks card the person talked about', () => {
  /** Mara writes in the card's thread, as from the app. */
  async function say(text: string) {
    const ep = api.messages.send;
    const res = await t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', conversationId: IDS.dmDusty })}`,
      headers: { cookie },
      payload: { text, threadRootId: ROOT },
    });
    expect(res.statusCode).toBe(201);
  }
  /** The thread from this card's intro on (earlier suites wrote in the same thread). */
  let from = 0;
  const thread = async () =>
    (await db().select().from(messages).where(eq(messages.threadRootId, ROOT)))
      .filter((m) => m.ord >= from)
      .sort((x, y) => x.ord - y.ord);
  const titles = (card: unknown) => DelegationCard.parse(card).tasks.map((x) => x.title);

  it('keeps the card as it was where the person wrote after it, and nothing where only the agent did', async () => {
    await doneWithWakes();
    let id = '';
    try {
      await talkedAbout((made) => {
        id = made;
      });
    } finally {
      // The thread takes one live card, and Mara's message queued a turn of the agent's that would hold the watcher
      // back: the suites after this one start clean.
      if (id) await press('stop', { delegationId: id });
      await db()
        .update(dispatches)
        .set({ state: 'done' })
        .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
    }
  });

  async function talkedAbout(made: (id: string) => void) {
    const a = await turn();
    const res = await a.call('delegate_offer', {
      title: 'Calm the Inbox',
      intro: 'Here are two tasks for the Inbox.',
      project: 'Demo site',
      tasks: [
        { title: 'One line per item', brief: 'Make each item one line.' },
        { title: 'Taller rows', brief: 'Make the rows 44 px.' },
      ],
    });
    await a.end();
    const id = res.delegationId as string;
    made(id);
    from = (await card(id)).message?.ord ?? 0;

    // Mara talks about the list, then the agent adds what she asked: the card moves, its intro keeps the list she saw.
    await say('Add a search box too.');
    await doneWithWakes();
    const b = await turn();
    expect(
      await b.call('delegate_update', {
        delegationId: id,
        add: [{ title: 'A search box', brief: 'Add a search box.' }],
        note: 'I added a search box.',
      }),
    ).toMatchObject({ status: 'ok' });
    await b.end();
    let rows = await thread();
    const intro = rows.find((m) => m.text === 'Here are two tasks for the Inbox.');
    expect(intro?.card).toBeNull();
    expect(intro?.movedCard).toEqual({ kind: 'delegation', id });
    expect(titles(intro?.earlierCard)).toEqual(['One line per item', 'Taller rows']);
    const firstMove = (await card(id)).message;
    expect(titles((await card(id)).card)).toContain('A search box');
    // The card says what changed until Hand over.
    expect((await card(id)).card.changed?.said).toEqual(['Added “A search box”']);
    // The app reads it as the card as it was, folded under the intro.
    const [loaded] = await loadMessages(db(), intro ? [intro] : [], null);
    expect(loaded?.earlierCard).toMatchObject({ kind: 'delegation', delegationId: id });

    // Only the agent's own words came after the moved card (in a turn of their own): its next news leaves nothing behind.
    const c = await turn();
    expect(
      await c.call('delegate_update', { delegationId: id, note: 'Anything else for the Inbox?' }),
    ).toMatchObject({
      status: 'ok',
    });
    await c.end();
    const d = await turn();
    expect(await d.call('delegate_update', { delegationId: id, remove: [3] })).toMatchObject({
      status: 'ok',
    });
    await d.end();
    rows = await thread();
    expect((await card(id)).card.changed?.said).toEqual(['Took off “A search box”']);
    expect(rows.some((m) => m.id === firstMove?.id)).toBe(false);
    expect(rows.filter((m) => m.earlierCard)).toHaveLength(1);
    // One live card, at the thread's end.
    expect(rows.filter((m) => (m.card as { kind?: string } | null)?.kind === 'delegation')).toHaveLength(1);
    expect((rows.at(-1)?.card as { kind?: string } | null)?.kind).toBe('delegation');
  }
});

describe('the AI chosen on the checklist', () => {
  it('runs a task with the AI chosen for it, and the rest with the one chosen for every task', async () => {
    await doneWithWakes();
    const a = await turn();
    const res = await a.call('delegate_offer', {
      title: 'Speed up the Inbox',
      intro: 'Shall I hand these over?',
      project: 'Demo site',
      tasks: [
        { title: 'Cache the list', brief: 'Cache the Inbox list.' },
        { title: 'Lazy pictures', brief: 'Load pictures lazily.' },
      ],
    });
    await a.end();
    const id = res.delegationId as string;
    const [first, second] = (await card(id)).card.tasks;
    // Nothing chosen yet: the card can choose (an older box's card has no `ai` at all).
    expect((await card(id)).card.ai).toBeNull();

    const models = api.delegations.models;
    const listed = await t.api.inject({
      method: models.method,
      url: `${models.base}${buildPath(models.path, { burrow: 'burrow-hq' })}`,
      headers: { cookie },
    });
    expect(listed.json().options[0].models[0]).toMatchObject({ id: 'gpt-6.1-sol', fast: true });

    const opus = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'xhigh', fast: null };
    expect((await press('setAi', { delegationId: id, taskId: first?.id, ai: opus })).statusCode).toBe(200);
    const sol = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: false };
    expect((await press('setAi', { delegationId: id, ai: sol })).statusCode).toBe(200);
    // A model T3 Code doesn't run is refused.
    const gone = { provider: 'codex', model: 'gpt-5', effort: null, fast: null };
    expect((await press('setAi', { delegationId: id, ai: gone })).statusCode).toBe(400);

    const shown = (await card(id)).card;
    expect(shown.ai).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high', fast: false });
    expect(shown.tasks[0]?.ai).toMatchObject({ label: 'Claude Opus 5.5', effort: 'xhigh' });
    expect(shown.tasks[1]?.ai).toBeNull();

    const before = launches().length;
    expect((await press('start', { delegationId: id })).statusCode).toBe(200);
    const started = launches().slice(before);
    const byTitle = (title: string) => started.find((c) => String(c.args.message).includes(title))?.args;
    expect(byTitle('Cache the Inbox list')?.modelSelection).toEqual({
      instanceId: 'claudeAgent',
      model: 'claude-opus-5-5',
      options: [{ id: 'effort', value: 'xhigh' }],
    });
    expect(byTitle('Load pictures lazily')?.modelSelection).toEqual({
      instanceId: 'codex',
      model: 'gpt-6.1-sol',
      options: [
        { id: 'reasoningEffort', value: 'high' },
        { id: 'serviceTier', value: 'default' },
      ],
    });
    // Handed over: the choice is closed.
    expect((await press('setAi', { delegationId: id, taskId: second?.id, ai: null })).statusCode).toBe(409);
    expect((await press('stop', { delegationId: id })).statusCode).toBe(200);
  });
});

describe('pull requests Whombat merges one at a time', () => {
  let id = '';
  const PR = 'https://github.com/acme/site/pull';
  const sends = (threadId: string) =>
    t3.calls.filter((c) => c.name === 't3_thread_send' && c.args.threadId === threadId);
  const queuedWakes = async () => (await wakes()).filter((w) => w.state === 'queued');

  it('hands them over with merging on, each brought up to date first, and a check of everything together last', async () => {
    await doneWithWakes();
    const a = await turn();
    const before = launches().length;
    const res = await a.call('delegate_offer', {
      title: 'Tidy the Files space',
      intro: 'Handing these over.',
      project: 'Demo site',
      atOnce: 2,
      start: true,
      tasks: [
        { title: 'Bigger icons', brief: 'Make the file icons bigger.' },
        { title: 'Sort by name', brief: 'Sort files by name.' },
        { title: 'Icon colours', brief: 'Colour the icons by type.', after: 1 },
      ],
    });
    await a.end();
    expect(res).toMatchObject({ status: 'started' });
    id = res.delegationId;
    const started = launches().slice(before);
    // The third comes after the first, so it is done in the first's thread.
    expect(started).toHaveLength(2);
    for (const call of started) expect(String(call.args.message)).toMatch(/fetch origin/i);
    expect((await card(id)).card).toMatchObject({ merge: true, stage: 'working' });
    // Whombat's check of everything together waits last on the card.
    expect(await finalOf(id)).toMatchObject({ state: 'queued', title: 'Check everything together' });
    expect((await card(id)).card.tasks.at(-1)?.title).toBe('Check everything together');
  });

  it('merges the first done one in its own thread, and the next waits its turn without waking the agent', async () => {
    const [one, two] = await tasksOf(id);
    t3.linkPullRequest(one?.threadId as string, `${PR}/51`);
    t3.finish(
      one?.threadId as string,
      'Bigger icons, coloured by type. Opened a pull request.\nItem 1: The icons are bigger.\nItem 3: They are coloured by type.',
    );
    await pass();
    // Done together, they merge together.
    expect((await tasksOf(id))[0]).toMatchObject({ state: 'working', mergeState: 'merging', pr: `${PR}/51` });
    expect((await tasksOf(id))[2]).toMatchObject({ state: 'working', mergeState: 'merging', pr: `${PR}/51` });
    const told = sends(one?.threadId as string);
    expect(told).toHaveLength(1);
    expect(String(told[0]?.args.message)).toContain(`${PR}/51`);
    expect(String(told[0]?.args.message)).toContain('Merged: yes');
    // Its checks passed: it merges without being checked again (DLG-40).
    expect(String(told[0]?.args.message)).toMatch(/wait for new checks/);
    expect(t3.threads.get(one?.threadId as string)?.settled).toBe(false);

    t3.linkPullRequest(two?.threadId as string, `${PR}/52`);
    t3.finish(two?.threadId as string, 'Sorted by name. Opened a pull request.');
    await pass();
    const tasks = await tasksOf(id);
    expect(tasks.map((x) => [x.state, x.mergeState])).toEqual([
      ['working', 'merging'],
      ['done', 'waiting'],
      ['working', 'merging'],
    ]);
    expect(sends(two?.threadId as string)).toHaveLength(0);
    expect(await queuedWakes()).toHaveLength(0);
    expect((await card(id)).card.tasks.map((x) => x.merge)).toEqual(['merging', 'waiting', 'merging', null]);
  });

  it('isn’t over while T3 Code watches the pull request’s checks, then merges it and moves on', async () => {
    const [one, two] = await tasksOf(id);
    const thread = one?.threadId as string;
    t3.watchPullRequest(thread, `${PR}/51`);
    t3.finish(thread, 'Updated from main; waiting for the checks.');
    await pass();
    expect((await tasksOf(id))[0]).toMatchObject({ state: 'working', mergeState: 'merging' });

    const before = launches().length;
    expect(t3.pullRequestMoved(thread)).toBe(true);
    t3.mergePullRequest(thread, `${PR}/51`);
    t3.finish(thread, 'The checks passed and it is merged.\n\nMerged: yes');
    await pass();
    const tasks = await tasksOf(id);
    expect(tasks[0]).toMatchObject({ state: 'done', mergeState: 'merged' });
    expect(tasks[2]).toMatchObject({ state: 'done', mergeState: 'merged' });
    expect(await settles(thread)).toBe(true);
    // The next waiting one merges; the check of everything together waits for it.
    expect(launches().slice(before)).toHaveLength(0);
    expect(tasks[1]).toMatchObject({ state: 'working', mergeState: 'merging' });
    expect(sends(two?.threadId as string)).toHaveLength(1);
    // A merge that went through wakes nobody: the next ones go on by themselves.
    expect(await queuedWakes()).toHaveLength(0);
  });

  it('leaves a pull request open when it needs a person, checks everything together, and says so once all are over', async () => {
    const [, two] = await tasksOf(id);
    const before = launches().length;
    t3.finish(two?.threadId as string, 'It needs a review first.\n\nMerged: no, a review is required.');
    await pass();
    expect((await tasksOf(id))[1]).toMatchObject({ state: 'done', mergeState: 'not_merged' });
    await doneWithWakes();

    // The others are over and one was merged: the check of everything together starts, told what was merged.
    const check = launches().slice(before);
    expect(check).toHaveLength(1);
    expect(String(check[0]?.args.title)).toContain('Check everything together');
    expect(String(check[0]?.args.message)).toContain('Icon colours');
    expect(String(check[0]?.args.message)).not.toContain('Sort by name');
    const final = await finalOf(id);
    expect(final).toMatchObject({ state: 'working' });
    t3.finish(
      final?.threadId as string,
      'Ran the checks on main: all pass.\nNote: Everything works together.\nChecks: passing',
    );
    await pass();
    expect(await finalOf(id)).toMatchObject({
      state: 'failed',
      checks: 'failing',
      mergeState: 'not_merged',
    });
    expect((await finalOf(id))?.note).toContain('incomplete');
    expect((await card(id)).card.tasks.map((x) => x.merge)).toEqual([
      'merged',
      'not_merged',
      'merged',
      'not_merged',
    ]);
    const all = (await queuedWakes()).at(-1);
    const ctx = await buildDispatchContext(t.services, all as NonNullable<typeof all>);
    expect(ctx.delegation).toMatchObject({ event: 'all', merge: true });
    // Every merge's answer, now that all are over.
    const merged = ctx.delegation?.tasks.find((x) => x.n === 1);
    expect(merged).toMatchObject({ merge: 'merged', told: true });
    expect(merged?.mergeAnswer).toContain('Merged: yes');
    await doneWithWakes();
  });

  it('merges one again when the agent is asked to, opening the card again', async () => {
    const a = await turn('delegation');
    expect(
      await a.call('delegate_finish', { delegationId: id, summary: 'Two are merged; one needs a review.' }),
    ).toMatchObject({ status: 'finished' });
    await a.end();
    expect((await card(id)).card).toMatchObject({ live: false, outcome: 'incomplete' });

    const [, two] = await tasksOf(id);
    const b = await turn();
    const res = await b.call('delegate_update', { delegationId: id, change: [{ n: 2, merge: true }] });
    await b.end();
    expect(res).toMatchObject({ status: 'ok' });
    expect((await tasksOf(id))[1]).toMatchObject({ state: 'working', mergeState: 'merging' });
    expect(sends(two?.threadId as string)).toHaveLength(2);
    expect((await card(id)).card).toMatchObject({ live: true, stage: 'working' });
    // Stopped while it merges: its pull request stays open, not merged.
    expect((await press('stop', { delegationId: id })).statusCode).toBe(200);
    expect((await tasksOf(id))[1]).toMatchObject({ state: 'done', mergeState: 'not_merged' });
  });
});

const queued = async () => (await wakes()).filter((w) => w.state === 'queued');
const PRS = 'https://github.com/acme/site/pull';

describe('checks passing before a merge’s turn', () => {
  let id = '';

  it('waits for its pull request’s checks without holding a place, and wakes nobody', async () => {
    await doneWithWakes();
    const a = await turn();
    const before = launches().length;
    const res = await a.call('delegate_offer', {
      title: 'Exam screens',
      intro: 'Handing these over.',
      project: 'Demo site',
      atOnce: 1,
      start: true,
      tasks: [
        { title: 'Waiting screen', brief: 'Add a waiting screen.' },
        { title: 'Help button', brief: 'Add a help button.' },
      ],
    });
    await a.end();
    expect(res).toMatchObject({ status: 'started' });
    id = res.delegationId;
    expect(launches().slice(before)).toHaveLength(1);
    const [one] = await tasksOf(id);
    const thread = one?.threadId as string;
    // It opened its pull request and watches its checks; its run ended without saying how they went.
    t3.watchPullRequest(thread, `${PRS}/61`);
    t3.finish(thread, 'Opened the pull request; watching its checks.');
    await pass();
    const tasks = await tasksOf(id);
    expect(tasks[0]).toMatchObject({ state: 'working', checks: 'running', pr: `${PRS}/61` });
    // Its place went to the next one; nobody was woken and its thread isn't settled.
    expect(tasks[1]?.state).toBe('working');
    expect(launches().slice(before)).toHaveLength(2);
    expect(await queued()).toHaveLength(0);
    expect(t3.threads.get(thread)?.settled).toBe(false);
    expect((await card(id)).card.tasks[0]).toMatchObject({ state: 'working', checks: 'running' });
    // The same ended run isn't read again.
    const calls = t3.calls.length;
    await pass();
    expect(
      t3.calls
        .slice(calls)
        .filter((c) => c.name === 'list_thread_pull_requests' && c.args.threadId === thread),
    ).toHaveLength(0);
  });

  it('holds a place again while T3 Code runs it after a check, and waits its merge once they pass', async () => {
    const [one] = await tasksOf(id);
    const thread = one?.threadId as string;
    expect(t3.pullRequestMoved(thread)).toBe(true);
    await pass();
    expect((await tasksOf(id))[0]).toMatchObject({ state: 'working', checks: null });
    t3.finish(thread, 'Fixed the lint error.\nNote: There is a waiting screen now.\nChecks: passing');
    await pass();
    expect((await tasksOf(id))[0]).toMatchObject({
      state: 'working',
      mergeState: 'merging',
      checks: 'passing',
      note: 'There is a waiting screen now.',
    });
    // Its checks passed: its merge's turn merges it now, without checking it again (DLG-40).
    const merge = t3.calls.filter((c) => c.name === 't3_thread_send' && c.args.threadId === thread).at(-1);
    expect(String(merge?.args.message)).toMatch(/merges without conflicts, merge it now/);
    expect(await queued()).toHaveLength(0);
  });

  it('keeps waiting while a fix’s checks run, though the run ended saying they fail', async () => {
    const [, two] = await tasksOf(id);
    const thread = two?.threadId as string;
    t3.watchPullRequest(thread, `${PRS}/62`);
    t3.finish(
      thread,
      'Pushed a fix for the kiosk test.\nNote: There is a help button.\nChecks: failing, the fix runs',
    );
    await pass();
    expect((await tasksOf(id))[1]).toMatchObject({ state: 'working', checks: 'running', mergeState: null });
    expect(await queued()).toHaveLength(0);
    expect(t3.threads.get(thread)?.settled).toBe(false);
    // T3 Code runs it again as the fix's checks end; this time it gives up and stops watching.
    expect(t3.pullRequestMoved(thread)).toBe(true);
    await pass();
    expect((await tasksOf(id))[1]).toMatchObject({ state: 'working', checks: null });
    t3.pullRequestsDone(thread);
  });

  it('wakes the agent only for a task whose checks still fail, and once all are over', async () => {
    const [one, two] = await tasksOf(id);
    t3.linkPullRequest(two?.threadId as string, `${PRS}/62`);
    t3.finish(
      two?.threadId as string,
      'The kiosk test times out.\nNote: The help button is there, but a test still fails.\nChecks: failing, the kiosk test times out',
    );
    await pass();
    expect((await tasksOf(id))[1]).toMatchObject({ state: 'done', checks: 'failing', mergeState: null });
    const [wake] = await queued();
    const ctx = await buildDispatchContext(t.services, wake as NonNullable<typeof wake>);
    expect(ctx.delegation?.event).toBe('task');
    expect(ctx.delegation?.tasks.find((x) => x.n === 2)).toMatchObject({ checks: 'failing', told: true });
    expect((await card(id)).card.tasks[1]).toMatchObject({ checks: 'failing' });
    await doneWithWakes();

    t3.mergePullRequest(one?.threadId as string, `${PRS}/61`);
    t3.finish(one?.threadId as string, 'Merged it.\nMerged: yes');
    await pass();
    // One was merged: the check of everything together runs before the end. It fixed what broke in a pull request of
    // its own and merged it; that wakes nobody.
    expect(await queued()).toHaveLength(0);
    const final = await finalOf(id);
    expect(final).toMatchObject({ state: 'working' });
    t3.linkPullRequest(final?.threadId as string, `${PRS}/63`);
    t3.finish(
      final?.threadId as string,
      'A test broke with both screens in.\nNote: Fixed one test that broke.\nChecks: passing\nMerged: yes',
    );
    await pass();
    expect(await finalOf(id)).toMatchObject({
      state: 'failed',
      checks: 'failing',
      mergeState: 'not_merged',
      pr: `${PRS}/63`,
    });
    const [all] = await queued();
    expect((await buildDispatchContext(t.services, all as NonNullable<typeof all>)).delegation?.event).toBe(
      'all',
    );
    await doneWithWakes();
    const a = await turn('delegation');
    expect(
      await a.call('delegate_finish', {
        delegationId: id,
        summary: 'The waiting screen is merged; the help button needs a look.',
        next: ['Put it on dev'],
      }),
    ).toMatchObject({ status: 'finished' });
    await a.end();
    expect((await card(id)).message?.suggestions).toEqual(['Put it on dev']);
  });
});

describe('a pull request merged another way', () => {
  it('shows as merged and reopens the final check once Whombat’s copy of the repository says so', async () => {
    await doneWithWakes();
    const a = await turn();
    const res = await a.call('delegate_offer', {
      title: 'Unsaved edits',
      intro: 'Handing it over.',
      project: 'Demo site',
      start: true,
      tasks: [{ title: 'Warn before losing edits', brief: 'Warn before closing a file with unsaved edits.' }],
    });
    await a.end();
    const id = res.delegationId as string;
    const [one] = await tasksOf(id);
    const thread = one?.threadId as string;
    t3.linkPullRequest(thread, `${PRS}/71`);
    t3.finish(thread, 'Added the warning.\nNote: Unsaved edits are safe.\nChecks: passing');
    await pass();
    expect((await tasksOf(id))[0]).toMatchObject({ state: 'working', mergeState: 'merging' });
    // Its merge's turn tells the thread to watch the pull request itself while its checks run.
    const merge = t3.calls.filter((c) => c.name === 't3_thread_send' && c.args.threadId === thread).at(-1);
    expect(String(merge?.args.message)).toMatch(/watch the pull request in T3 Code/);
    // The thread gave up while fresh checks ran; the agent merged it itself and ended the list.
    t3.finish(thread, 'Fresh checks still run.\n\nMerged: no, its checks still run.');
    await pass();
    expect((await tasksOf(id))[0]).toMatchObject({ state: 'done', mergeState: 'not_merged' });
    await doneWithWakes();
    const b = await turn('delegation');
    await b.call('delegate_finish', { delegationId: id, summary: 'I merged it myself.' });
    await b.end();
    expect((await card(id)).card).toMatchObject({ outcome: 'incomplete' });

    await db()
      .insert(pullRequests)
      .values({
        id: newId('pullRequest'),
        burrowId: t.burrowId,
        repoId: 'rep_billing',
        number: 71,
        branch: one?.branch as string,
        title: 'Warn before losing edits',
        state: 'merged',
        headSha: 'abc1234',
        conversationId: IDS.dmDusty,
        openedAt: t.services.clock(),
        mergedAt: t.services.clock(),
        url: `${PRS}/71`,
      });
    await pass();
    expect((await tasksOf(id))[0]).toMatchObject({ state: 'done', mergeState: 'merged' });
    const after = (await card(id)).card;
    expect(after).toMatchObject({ stage: 'working', outcome: null });
    expect(after.tasks[0]).toMatchObject({ merge: 'merged' });
    const final = await finalOf(id);
    expect(final).toMatchObject({ state: 'working' });
    t3.finish(final?.threadId as string, 'Checks passed, without revision evidence.\nChecks: passing');
    await pass();
    expect(await finalOf(id)).toMatchObject({ state: 'failed', checks: 'failing' });
    await doneWithWakes();
    const finish = await turn('delegation');
    expect(
      await finish.call('delegate_finish', {
        delegationId: id,
        summary: 'The merge still needs a verified final check.',
      }),
    ).toMatchObject({ status: 'finished' });
    await finish.end();
    expect((await card(id)).card).toMatchObject({ outcome: 'incomplete' });
  });
});

describe('more work for an ended task', () => {
  it('waits for a place, and goes to its own thread when one frees up', async () => {
    const a = await turn();
    const res = await a.call('delegate_offer', {
      title: 'Small fixes',
      intro: 'Handing these over.',
      project: 'Demo site',
      atOnce: 1,
      pullRequests: false,
      start: true,
      tasks: [
        { title: 'Fix the dock', brief: 'Fix the dock buttons.' },
        { title: 'Fix the end screen', brief: 'Lock the end screen.' },
      ],
    });
    await a.end();
    expect(res).toMatchObject({ status: 'started' });
    const id = res.delegationId;
    const [one, two] = await tasksOf(id);
    expect(one?.threadId).toBeTruthy();
    t3.finish(one?.threadId as string, 'Fixed.\nNote: The dock buttons work.');
    await pass();
    expect((await tasksOf(id)).map((x) => x.state)).toEqual(['done', 'working']);
    // As an end leaves a watch kept only for a pull request T3 Code still watches: it wakes nobody.
    const watchOf = async () =>
      (
        await db()
          .select()
          .from(t3Watches)
          .where(eq(t3Watches.threadId, one?.threadId as string))
      )[0];
    await db()
      .update(t3Watches)
      .set({ wakes: false })
      .where(eq(t3Watches.threadId, one?.threadId as string));

    const b = await turn();
    const sent = await b.call('delegate_update', {
      delegationId: id,
      send: [{ n: 1, message: 'Also fix the website button.' }],
    });
    await b.end();
    // The one place is taken: it waits, and nothing is sent yet.
    expect(sent.message).toContain('when a place frees up');
    expect((await tasksOf(id))[0]).toMatchObject({
      state: 'queued',
      sendPending: 'Also fix the website button.',
    });
    const to = (thread: string) =>
      t3.calls.filter((c) => c.name === 't3_thread_send' && c.args.threadId === thread);
    expect(to(one?.threadId as string)).toHaveLength(0);

    const second = (await tasksOf(id))[1];
    expect(second?.id).toBe(two?.id);
    t3.finish(second?.threadId as string, 'Locked.\nNote: The end screen stays locked.');
    await pass();
    // Its turn came: the work goes to its own thread, no new one.
    expect((await tasksOf(id))[0]).toMatchObject({ state: 'working', sendPending: null });
    expect(String(to(one?.threadId as string)[0]?.args.message)).toContain('Also fix the website button.');
    // Working again, its questions wake the agent again.
    expect(await watchOf()).toMatchObject({ state: 'watching', wakes: true });
    expect((await press('stop', { delegationId: id })).statusCode).toBe(200);
    await doneWithWakes();
  });
});

describe('where tasks start and what they keep to', () => {
  it('does tasks that change the same thing in one thread, from the default branch, with the card’s rules', async () => {
    t3.knobs.missingBases = ['origin/HEAD'];
    const a = await turn();
    const before = launches().length;
    const res = await a.call('delegate_offer', {
      title: 'Tidy the Inbox',
      intro: 'Handing these over.',
      project: 'Demo site',
      atOnce: 2,
      merge: false,
      start: true,
      rules: 'Strings go in the en and nl tables.',
      tasks: [
        { title: 'One line per item', brief: 'One line each.', areas: ['web/inbox'] },
        { title: 'Quieter rows', brief: 'Quieter rows.', areas: ['web/inbox/row.tsx'] },
        { title: 'Bigger file icons', brief: 'Bigger icons.', areas: ['web/files'] },
        { title: 'Sort by name', brief: 'Sort files.', areas: ['web/sort'] },
      ],
    });
    await a.end();
    t3.knobs.missingBases = [];
    expect(res).toMatchObject({ status: 'started' });
    expect(res.message).toContain('Task 2 is done with task 1');
    const id = res.delegationId;
    expect((await card(id)).card.tasks.map((x) => x.after)).toEqual([null, 1, null, null]);
    // The checkout has no remote default branch: T3 Code refused that base, and they start from the checkout.
    const tried = launches().slice(before);
    expect(tried.map((c) => (c.args.workspaceStrategy as Json).baseRef).sort()).toEqual([
      'HEAD',
      'HEAD',
      'origin/HEAD',
      'origin/HEAD',
    ]);
    for (const call of tried)
      expect(String(call.args.message)).toContain('Strings go in the en and nl tables.');
    const tasks = await tasksOf(id);
    expect(tasks.map((x) => x.state)).toEqual(['working', 'working', 'working', 'queued']);
    expect(tasks[1]?.threadId).toBe(tasks[0]?.threadId);

    // Its pull request says where they go: later tasks start from that, fetched fresh.
    t3.linkPullRequest(tasks[0]?.threadId as string, `${PRS}/71`);
    t3.finish(tasks[0]?.threadId as string, 'Done.\nChecks: passing');
    await pass();
    const [d] = await db().select().from(delegations).where(eq(delegations.id, id));
    expect(d?.baseBranch).toBe('main');
    t3.finish(tasks[2]?.threadId as string, 'Done.\nChecks: none');
    await pass();
    const last = launches().at(-1);
    expect(last?.args.workspaceStrategy).toMatchObject({ baseRef: 'main', startFromOrigin: true });
    expect((await press('stop', { delegationId: id })).statusCode).toBe(200);
    await doneWithWakes();
  });
});

describe('a task’s pictures', () => {
  /** A page-like picture: a light page with one button, `tall` making the button taller. */
  function page(tall: boolean): Buffer {
    const png = new PNG({ width: 400, height: 300 });
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 400; x++) {
        const o = (y * 400 + x) * 4;
        const button = x >= 40 && x < 160 && y >= 40 && y < (tall ? 100 : 70);
        png.data[o] = button ? 40 : 245;
        png.data[o + 1] = button ? 90 : 245;
        png.data[o + 2] = button ? 200 : 245;
        png.data[o + 3] = 255;
      }
    return PNG.sync.write(png);
  }

  /** One POST to the link, as the task's curl sends it. */
  async function post(path: string, body: Buffer, type: string, origin?: string) {
    const handle = shotUploads(t.services);
    const req = Object.assign(Readable.from([body]), {
      method: 'POST',
      url: path,
      headers: { 'content-type': type, 'content-length': String(body.length), ...(origin ? { origin } : {}) },
    }) as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const done = new Promise<void>((resolve) => {
      const res = {
        headersSent: false,
        writeHead(st: number) {
          status = st;
          res.headersSent = true;
          return res;
        },
        end(chunk?: string) {
          text = chunk ?? '';
          resolve();
        },
      };
      expect(handle(req, res as unknown as ServerResponse, path.split('?')[0] as string)).toBe(true);
    });
    await done;
    return { status, json: JSON.parse(text || '{}') as Json };
  }

  it('numbers what changed, keeps the notes, and shows the picture on the task’s row', async () => {
    const a = await turn();
    const before = launches().length;
    const res = await a.call('delegate_offer', {
      title: 'Taller buttons',
      intro: 'Handing it over.',
      project: 'Demo site',
      start: true,
      tasks: [{ title: 'Taller buttons', brief: 'Make the buttons taller.' }],
    });
    await a.end();
    const id = res.delegationId;
    // Its brief says how to take them (the link itself needs the box's own addresses, which a test has none of).
    expect(res).toMatchObject({ status: 'started' });
    expect(String(launches().slice(before)[0]?.args.message)).toContain('.whombat/shots');
    // A link, as its brief would get one.
    const token = 'task-test-token-abcdefghijklmnopq';
    await db()
      .update(delegationTasks)
      .set({ uploadHash: hashToken(token), uploadUntil: new Date(t.services.clock().getTime() + 3_600_000) })
      .where(and(eq(delegationTasks.delegationId, id), eq(delegationTasks.kind, 'task')));
    const shot = (when: string) =>
      `/shots/${token}/shot?view=${encodeURIComponent('Settings · light')}&when=${when}`;

    expect((await post(shot('before'), page(false), 'image/png', 'http://evil.test')).status).toBe(403);
    expect(
      (
        await post(
          `/shots/not-a-real-token-${'x'.repeat(20)}/shot?view=a&when=before`,
          page(false),
          'image/png',
        )
      ).status,
    ).toBe(404);
    expect((await post(shot('before'), Buffer.from('not a picture'), 'image/png')).status).toBe(415);
    expect(await post(shot('before'), page(false), 'image/png')).toMatchObject({
      status: 200,
      json: { areas: [] },
    });
    const after = await post(shot('after'), page(true), 'image/png');
    expect(after.status).toBe(200);
    expect(after.json.areas).toEqual([expect.objectContaining({ n: 1, where: expect.any(String) })]);

    // A picture drawn from shots that were sent again meanwhile is dropped.
    const [task] = await tasksOf(id);
    const [screen] = await db()
      .select()
      .from(delegationShots)
      .where(eq(delegationShots.taskId, task?.id ?? ''));
    const stale = await t.services.pipeline.commit(
      delegationCompare,
      {
        taskId: task?.id as string,
        view: 'Settings · light',
        compareId: screen?.compareId as string,
        beforeId: screen?.afterId as string,
        afterId: screen?.beforeId as string,
        width: 10,
        height: 10,
        areas: [],
      },
      { burrowId: t.burrowId, actorId: IDS.dusty },
    );
    expect(stale).toMatchObject({ status: 'ok', result: { stale: true } });
    // Its attachment was the current picture's: give it back for the rest of the test.
    await db()
      .update(attachments)
      .set({ state: 'ready' })
      .where(eq(attachments.id, screen?.compareId as string));

    const notes = await post(
      `/shots/${token}/notes`,
      Buffer.from(
        JSON.stringify({
          view: 'Settings · light',
          notes: { 1: 'The button is taller, so it is easier to tap.' },
        }),
      ),
      'application/json',
    );
    expect(notes).toMatchObject({ status: 200, json: { kept: 1 } });
    const { message, card: c } = await card(id);
    expect(c.tasks[0]?.shots).toEqual([
      expect.objectContaining({
        view: 'Settings · light',
        areas: 1,
        notes: [{ n: 1, text: 'The button is taller, so it is easier to tap.' }],
      }),
    ]);
    // The drawn picture is the card's message's at once.
    const [drawn] = await db()
      .select()
      .from(attachments)
      .where(eq(attachments.id, c.tasks[0]?.shots?.[0]?.attachmentId as string));
    expect(drawn?.messageId).toBe(message?.id);
    // A read of the message carries it, so the card draws it, not an empty box.
    const filesOf = async () => {
      const { message: m } = await card(id);
      const [loaded] = await loadMessages(db(), m ? [m] : [], null);
      return loaded?.attachments.map((a) => a.id) ?? [];
    };
    expect(await filesOf()).toContain(drawn?.id);
    // The screen sent again: its new picture takes the old one's place.
    expect((await post(shot('after'), page(true), 'image/png')).status).toBe(200);
    const redrawn = (await card(id)).card.tasks[0]?.shots?.[0]?.attachmentId;
    expect(redrawn).not.toBe(drawn?.id);
    const files = await filesOf();
    expect(files).toContain(redrawn);
    expect(files).not.toContain(drawn?.id);
    // The list ends: the shots it came from go, and the link ends.
    expect((await press('stop', { delegationId: id })).statusCode).toBe(200);
    const raw = await db()
      .select()
      .from(attachments)
      .where(and(eq(attachments.conversationId, IDS.dmDusty), eq(attachments.state, 'deleted')));
    expect(raw.length).toBeGreaterThanOrEqual(2);
    expect((await post(shot('after'), page(true), 'image/png')).status).toBe(404);
  });
});
