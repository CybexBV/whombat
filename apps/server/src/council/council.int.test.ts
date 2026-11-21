/**
 * A council (docs/decisions/council.md), against a real Postgres and a stand-in T3 Code behind a home-network address:
 * `council_start` starts one lead thread in T3 Code with the council's brief and the live card in the thread it was
 * asked in; the watcher finds the reviewers the lead starts as its children, keeps each one's score on the card and
 * wakes nobody for them; the lead's end wakes the agent once, with the plan for the person's go-ahead or with the
 * result; `council_tell` sends the lead on; finishing posts the conclusion and tells the person once; Stop tells the
 * lead to stop; a reviewer that runs out of time counts as didn't answer. Postgres because each step is a commit.
 */
import { api, buildPath, CouncilCard, type CouncilStage } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STUB_PROVIDERS,
  startT3Code,
  type T3CodeStub,
  type T3StubThread,
} from '../connections/testing/t3code-stub';
import {
  councilMembers,
  councilSetups,
  councils,
  delegations,
  dispatches,
  messages,
  notifications,
  t3Watches,
  vaultNetworks,
} from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { progressOf } from '../t3code/progress';
import { T3Watcher } from '../t3code/watch';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { councilTiming } from './run';

const t = useTestServer({ seed: true, listen: true });

const HOSTS: Record<string, string> = { 't3.council.test': '192.168.93.10' };
/** The thread of Mara's chat with Dusty the council is asked in. */
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

/** A turn of Dusty's for Mara in the thread, with its MCP client. */
async function turn(trigger?: 'council') {
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
    async end() {
      await mcp.close();
      await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, d.dispatchId));
    },
  };
}

const launches = () => t3.calls.filter((c) => c.name === 't3_thread_launch');

async function councilRow(id: string) {
  const [row] = await db().select().from(councils).where(eq(councils.id, id));
  return row;
}

async function liveCard(id: string) {
  const row = await councilRow(id);
  const [m] = await db()
    .select()
    .from(messages)
    .where(eq(messages.id, row?.liveMessageId ?? ''));
  return { message: m, card: CouncilCard.parse(m?.card) };
}

/** The agent's replies under a card, oldest first. */
async function repliesUnder(cardId: string) {
  const [card] = await db().select().from(messages).where(eq(messages.id, cardId));
  const rows = await db()
    .select()
    .from(messages)
    .where(eq(messages.threadRootId, card?.threadRootId ?? cardId));
  return rows
    .filter((m) => m.authorId === IDS.dusty && m.ord > (card?.ord ?? 0))
    .sort((x, y) => x.ord - y.ord);
}

/** The person's inbox rows for these messages. */
async function toldAbout(ids: readonly string[]) {
  const rows = await db().select().from(notifications);
  return rows.filter((n) => n.messageId && ids.includes(n.messageId));
}

async function wakesOf() {
  return db()
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.trigger, 'council')));
}

async function threadsOf(councilId: string, stage: CouncilStage, round: number) {
  const rows = await db()
    .select()
    .from(councilMembers)
    .where(
      and(
        eq(councilMembers.councilId, councilId),
        eq(councilMembers.stage, stage),
        eq(councilMembers.round, round),
      ),
    );
  return rows.sort((a, b) => a.position - b.position);
}

async function press(op: 'goAhead' | 'stop', councilId: string) {
  const ep = api.councils[op];
  return t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie },
    payload: { councilId },
  });
}

beforeAll(async () => {
  t3 = await startT3Code();
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const address = HOSTS[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith('192.168.93.') ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await db()
    .insert(vaultNetworks)
    .values({
      id: 'vnw_council_test',
      cidr: '192.168.93.0/24',
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
      fields: { url: `http://t3.council.test:${t3.port}` },
      login: { password: t3.pairingCode() },
      access: 'manage',
    },
  });
  expect(res.statusCode).toBe(201);
  // A reviewer's answer is read as soon as it ended, unless a test says otherwise.
  councilTiming.answerSettleMs = 0;
});

afterAll(async () => {
  await t3?.close();
});

/** The council's lead thread row. */
async function leadOf(councilId: string) {
  const rows = await db().select().from(councilMembers).where(eq(councilMembers.councilId, councilId));
  const lead = rows.find((m) => m.role === 'builder');
  if (!lead?.threadId) throw new Error('no lead thread');
  return lead as typeof lead & { threadId: string };
}

/** The lead's run ends while its reviewers still work: T3 Code runs it again when they answer. */
function waitsForReviewers(threadId: string) {
  const thread = t3.threads.get(threadId) as T3StubThread;
  t3.finish(threadId, 'Waiting for the reviewers.');
  thread.delegating = true;
}

/** The lead starts one reviewer per model for a round; their thread ids, in the models' order. */
const SEATS = [
  ['GPT 6.1 Sol', 'gpt-6.1-sol'],
  ['Claude Opus 5.5', 'claude-opus-5-5'],
  ['Muse Wonder Full 1.0', 'muse-wonder-full-1.0'],
] as const;
function reviewers(leadThread: string, round: string): string[] {
  return SEATS.map(([name, model]) =>
    t3.delegate(leadThread, { title: `Council · ${name} · ${round}`, model, answer: null }),
  );
}

const sends = (threadId: string) =>
  t3.calls.filter((c) => c.name === 't3_thread_send' && c.args.threadId === threadId);

describe('a council that improves a project', () => {
  let councilId = '';
  let lead = '';

  it('starts one lead thread with the council’s brief, on the chat’s own AI', async () => {
    const a = await turn();
    expect(await a.tools()).toEqual(
      expect.arrayContaining(['council_start', 'council_note', 'council_tell', 'council_finish']),
    );
    const before = launches().length;
    const res = await a.call('council_start', {
      kind: 'improve',
      title: 'Improve the Settings page',
      question: 'Make the Settings page easier to use.',
      intro: 'I asked the council to look at it.',
      project: 'Demo site',
    });
    await a.end();
    expect(res).toMatchObject({ status: 'started' });
    expect(res.members.map((m: Json) => m.name)).toEqual(SEATS.map(([name]) => name));
    councilId = res.councilId;
    // One thread leads it, on the AI Dusty runs on (Claude), in a worktree of its own on a branch of the council's.
    const started = launches().slice(before);
    expect(started).toHaveLength(1);
    const call = started[0] as (typeof started)[number];
    expect(call.args).toMatchObject({
      title: 'Dusty - Council · Improve the Settings page',
      runtimeMode: 'full-access',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
      workspaceStrategy: { type: 'worktree', baseRef: 'origin/HEAD' },
    });
    expect((call.args.workspaceStrategy as Json).branch).toMatch(/^council\/improve-the-settings-page-/);
    // The brief carries what was asked as written, every seat as delegate_task takes it, and what Whombat reads.
    const brief = String(call.args.message);
    expect(brief).toContain('Make the Settings page easier to use.');
    for (const [name, model] of SEATS) {
      expect(brief).toContain(name);
      expect(brief).toContain(`"model":"${model}"`);
    }
    expect(brief).toContain('"providerInstanceId":"claudeAgent"');
    expect(brief).toContain('Council · <the seat’s name> · <look|plan|check> <round number>');
    expect(brief).toContain('Score: <0 to 10>/10');
    // Nobody said to build without asking: the lead stops with the plan.
    expect(brief).toContain('Then stop');
    // The live card in the thread it was asked in: every seat at the table from the start, never the lead; nothing is
    // under it yet.
    const { message, card } = await liveCard(councilId);
    expect(message).toMatchObject({
      threadRootId: ROOT,
      authorId: IDS.dusty,
      text: 'I asked the council to look at it.',
    });
    expect(card.note).toBeNull();
    expect(card).toMatchObject({ live: true, stage: 'research', what: 'improve', target: 9 });
    expect(card.members.map((m) => [m.role, m.name, m.state, m.waiting])).toEqual(
      SEATS.map(([name]) => ['member', name, 'working', true]),
    );
    lead = (await leadOf(councilId)).threadId;
    expect(await councilRow(councilId)).toMatchObject({ builderThreadId: lead });
    // Watched for the council, not shown as a hand-over.
    const watches = await db().select().from(t3Watches).where(eq(t3Watches.councilId, councilId));
    expect(watches.map((w) => w.threadId)).toEqual([lead]);
  });

  it('shows the reviewers the lead starts, and each score as it comes, waking nobody', async () => {
    const [sol, opus, muse] = reviewers(lead, 'look 1');
    waitsForReviewers(lead);
    await pass();
    let { card } = await liveCard(councilId);
    expect(card).toMatchObject({ stage: 'research', round: 1 });
    expect(card.members.map((m) => [m.mark, m.role, m.state])).toEqual([
      ['openai', 'member', 'working'],
      ['claude', 'member', 'working'],
      [null, 'member', 'working'],
    ]);
    expect(card.members.some((m) => m.waiting)).toBe(false);
    t3.finish(sol as string, 'The buttons are cramped and the labels unclear.\nScore: 6/10');
    await pass();
    ({ card } = await liveCard(councilId));
    expect(card.members[0]).toMatchObject({ state: 'done', score: 6 });
    expect(card.members[0]?.answer).toContain('cramped');
    t3.finish(opus as string, 'Group the settings.\nScore: 7/10');
    t3.finish(muse as string, 'Fewer options per page.\nScore: 6.5/10');
    await pass();
    expect((await liveCard(councilId)).card.members.map((m) => m.score)).toEqual([6, 7, 6.5]);
    // The lead brings the answers together: the agent isn't woken for them, and none of its threads is settled.
    expect(await wakesOf()).toEqual([]);
    expect(t3.threads.get(sol as string)?.settled).toBe(false);
    // A reviewer's answer is read with the connection's sign-in, never sent on to another.
    expect(sends(lead)).toEqual([]);
  });

  it('follows the plan rounds, and wakes the agent once with the plan for the person’s go-ahead', async () => {
    const plan = reviewers(lead, 'plan 1');
    await pass();
    let { card } = await liveCard(councilId);
    expect(card).toMatchObject({ stage: 'agree', round: 1 });
    expect(card.history.map((r) => [r.stage, r.round])).toEqual([['research', 1]]);
    expect(card.history[0]?.members.map((m) => m.score)).toEqual([6, 7, 6.5]);
    for (const id of plan) t3.finish(id, 'It would reach the goal.\nVerdict: agree');
    await pass();
    expect(await wakesOf()).toEqual([]);
    // The lead ends with the agreed plan: it waits for the go-ahead, and the agent is woken to ask.
    (t3.threads.get(lead) as T3StubThread).delegating = false;
    t3.finish(lead, 'The plan:\n1. Taller buttons (all three)\n2. Group the settings (Claude)');
    await pass();
    ({ card } = await liveCard(councilId));
    expect(card).toMatchObject({ stage: 'approve', live: true });
    expect(card.plan).toContain('Taller buttons');
    expect(card.note).toContain('go ahead');
    const wakes = await wakesOf();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ state: 'queued', threadRootId: ROOT, onBehalfOfAccountId: mara });
    const context = await buildDispatchContext(t.services, wakes[0] as NonNullable<(typeof wakes)[0]>);
    expect(context.council).toMatchObject({ councilId, event: 'plan', stage: 'approve' });
    const told = context.council?.members.filter((m) => m.told) ?? [];
    expect(told.map((m) => m.role)).toEqual(['builder']);
    expect(told[0]?.answer).toContain('Taller buttons');
    // It stays in T3 Code's list: the council goes on in it.
    expect(t3.threads.get(lead)?.settled).toBe(false);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(eq(dispatches.id, wakes[0]?.id as string));
  });

  it('keeps the go-ahead the person’s: a change to the plan builds nothing, and the wake can’t say go', async () => {
    // In the wake that brought the plan nobody has said go yet.
    const woken = await turn('council');
    expect(
      await woken.call('council_tell', { councilId, message: 'Go ahead.', goAhead: true }),
    ).toMatchObject({ status: 'refused' });
    await woken.end();
    expect(await councilRow(councilId)).toMatchObject({ stage: 'approve', okAt: null });
    // The person wants the plan changed: the lead is told so, and that it is no go-ahead.
    const a = await turn();
    expect(
      await a.call('council_tell', { councilId, message: 'Drop the grouping, keep the buttons.' }),
    ).toMatchObject({ status: 'told' });
    await a.end();
    const sent = String(sends(lead).at(-1)?.args.message);
    expect(sent).toContain('not the go-ahead');
    expect(sent).toContain('Drop the grouping');
    expect(await councilRow(councilId)).toMatchObject({ stage: 'agree', okAt: null });
    expect((await liveCard(councilId)).card.note).toContain('changing the plan');
    // It comes back with the changed plan, and waits again.
    t3.finish(lead, 'The plan:\n1. Taller buttons (all three)');
    await pass();
    const { card } = await liveCard(councilId);
    expect(card).toMatchObject({ stage: 'approve' });
    expect(card.plan).not.toContain('Group the settings');
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });

  it('tells the turn the person writes in that the council waits, and sends the lead on with their go-ahead', async () => {
    // Read from a turn of its own: building a turn's context gives it a new token.
    const seen = await turn();
    const [row] = await db().select().from(dispatches).where(eq(dispatches.id, seen.id));
    const context = await buildDispatchContext(t.services, row as NonNullable<typeof row>);
    expect(context.council).toMatchObject({ councilId, event: 'waiting' });
    await seen.end();
    const a = await turn();
    // A plan a council's lead builds itself never goes on a Tasks card.
    expect(
      await a.call('delegate_offer', {
        title: 'Improve the Settings page',
        intro: 'Here is the plan.',
        council: councilId,
        tasks: [{ title: 'Taller buttons', brief: 'Make the buttons 44 px tall.' }],
      }),
    ).toMatchObject({ status: 'refused' });
    const res = await a.call('council_tell', {
      councilId,
      message: 'Go ahead, and keep the buttons blue.',
      goAhead: true,
    });
    await a.end();
    expect(res).toMatchObject({ status: 'told' });
    const sent = sends(lead).at(-1);
    expect(sent?.args.mode).toBe('auto');
    expect(String(sent?.args.message)).toContain('go ahead');
    expect(String(sent?.args.message)).toContain('keep the buttons blue');
    const council = await councilRow(councilId);
    expect(council).toMatchObject({ stage: 'build' });
    expect(council?.okAt).not.toBeNull();
    expect(await leadOf(councilId)).toMatchObject({ state: 'working', answer: null });
    const { card } = await liveCard(councilId);
    expect(card).toMatchObject({ stage: 'build' });
    expect(card.note).toContain('building');
    const [watch] = await db().select().from(t3Watches).where(eq(t3Watches.threadId, lead));
    expect(watch).toMatchObject({ state: 'watching', wakes: true });
  });

  it('follows the checks, wakes the agent with the result, and finishes with every round’s scores', async () => {
    // A helper the lead starts for the build is no reviewer.
    t3.delegate(lead, { title: 'Make the buttons taller', model: 'gpt-6.1-sol', answer: null });
    const check = reviewers(lead, 'check 1');
    waitsForReviewers(lead);
    await pass();
    expect((await liveCard(councilId)).card).toMatchObject({ stage: 'check', round: 1 });
    expect((await liveCard(councilId)).card.members).toHaveLength(3);
    for (const id of check) t3.finish(id, 'It does what the plan said.\nScore: 9/10\nVerdict: agree');
    (t3.threads.get(lead) as T3StubThread).delegating = false;
    t3.finish(lead, 'Built and checked: every reviewer gives it 9. https://github.com/acme/site/pull/7');
    await pass();
    const wakes = (await wakesOf()).filter((w) => w.state === 'queued');
    expect(wakes).toHaveLength(1);
    const context = await buildDispatchContext(t.services, wakes[0] as NonNullable<(typeof wakes)[0]>);
    expect(context.council).toMatchObject({ councilId, event: 'finished' });
    // Every reviewer's score is there, and only the lead's answer is told: it brings theirs together.
    expect(context.council?.members.map((m) => [m.role, m.score, m.told])).toEqual([
      ['member', 9, false],
      ['member', 9, false],
      ['member', 9, false],
      ['builder', null, true],
    ]);
    const a = await turn('council');
    // Reading it gives every round's answers, each named by its round.
    const read = await a.call('council_read', { councilId });
    expect(read.council.members.filter((m: Json) => m.answer).length).toBe(10);
    expect(read.council.members.map((m: Json) => m.round).filter(Boolean)).toEqual(
      expect.arrayContaining(['look 1', 'plan 1', 'check 1']),
    );
    const done = await a.call('council_finish', {
      councilId,
      summary: 'They looked, agreed on two changes, and give the result 9.',
      next: ['Put it on dev'],
    });
    await a.end();
    expect(done).toMatchObject({ status: 'finished' });
    const { card, message } = await liveCard(councilId);
    expect(card).toMatchObject({ live: false, stage: 'done', outcome: 'done' });
    expect(card.history.map((r) => [r.stage, r.round])).toEqual([
      ['research', 1],
      ['agree', 1],
      ['check', 1],
    ]);
    expect(card.history.at(-1)?.members.map((m) => m.score)).toEqual([9, 9, 9]);
    const said = await repliesUnder(message?.id ?? '');
    expect(said.at(-1)?.text).toBe('They looked, agreed on two changes, and give the result 9.');
    await t.services.background.settle();
    expect((await toldAbout(said.map((m) => m.id))).length).toBeGreaterThan(0);
    // Its work is complete: the lead thread is tidied away in T3 Code once it has been quiet, never told to stop.
    expect(t3.threads.get(lead)?.settled).toBe(false);
    expect(await settles(lead)).toBe(true);
    expect(sends(lead).some((c) => c.args.mode === 'restart')).toBe(false);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });
});

describe('a review, stopping and running out of time', () => {
  async function start(kind: 'review' | 'research', title: string, project = true) {
    const a = await turn();
    const res = await a.call('council_start', {
      kind,
      title,
      question: 'Look at it.',
      intro: 'I asked the council to look at it.',
      ...(project ? { project: 'Demo site' } : {}),
    });
    await a.end();
    expect(res).toMatchObject({ status: 'started' });
    return { councilId: res.councilId as string, lead: (await leadOf(res.councilId)).threadId };
  }

  it('reviews the person’s checkout as it is, and refuses a second council in the thread', async () => {
    const { councilId } = await start('review', 'Review the Inbox');
    const call = launches().at(-1);
    // Their own checkout, uncommitted changes included: no worktree.
    expect(call?.args.projectId).toBe('mcp:project-1');
    expect(call?.args.workspaceStrategy).toBeUndefined();
    expect(String(call?.args.message)).toContain('Change nothing yourself');
    const a = await turn();
    const second = await a.call('council_start', {
      kind: 'review',
      title: 'Another',
      question: 'Look.',
      intro: 'I asked the council to look at it.',
      project: 'Demo site',
    });
    await a.end();
    expect(second).toMatchObject({ status: 'refused', reason: 'busy' });
    expect((await press('stop', councilId)).statusCode).toBe(200);
  });

  it('tells the lead to stop on the person’s Stop, its reviewers with it', async () => {
    const { councilId, lead } = await start('research', 'Which NAS to buy', false);
    expect(launches().at(-1)?.args.scratch).toBe(true);
    const [first] = reviewers(lead, 'look 1');
    waitsForReviewers(lead);
    await pass();
    const stopped = await press('stop', councilId);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ stage: 'stopped' });
    // The lead is told, and cancels its own reviewers: Whombat interrupts none of them.
    const told = sends(lead).at(-1);
    expect(told?.args.mode).toBe('restart');
    expect(String(told?.args.message)).toContain('task_cancel');
    expect(t3.calls.some((c) => c.name === 't3_thread_interrupt' && c.args.threadId === first)).toBe(false);
    expect((await liveCard(councilId)).card).toMatchObject({ live: false, outcome: 'stopped' });
    // The person pressed it: nothing to tell them.
    await t.services.background.settle();
    const card = await liveCard(councilId);
    expect(await repliesUnder(card.message?.id ?? '')).toEqual([]);
  });

  it('tells the lead to stop when only its reviewers still work', async () => {
    const { councilId, lead } = await start('review', 'Review with a failed lead');
    reviewers(lead, 'look 1');
    waitsForReviewers(lead);
    await pass();
    // The lead's row is over (its thread failed) while its reviewers go on.
    await db().update(councilMembers).set({ state: 'failed' }).where(eq(councilMembers.threadId, lead));
    const before = sends(lead).length;
    expect((await press('stop', councilId)).statusCode).toBe(200);
    const told = sends(lead).slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]?.args.mode).toBe('restart');
    const left = await db().select().from(councilMembers).where(eq(councilMembers.councilId, councilId));
    expect(left.some((m) => m.stopPending)).toBe(false);
  });

  it('shows a seat that took no part once the lead is done', async () => {
    const { councilId, lead } = await start('review', 'Review with a seat missing');
    const [sol, opus] = reviewers(lead, 'look 1');
    // T3 Code refused Muse's seat: the lead went on with two.
    const muse = [...t3.threads.values()].at(-1) as T3StubThread;
    t3.threads.delete(muse.id);
    t3.finish(sol as string, 'Fine.\nScore: 8/10');
    t3.finish(opus as string, 'Fine.\nScore: 7/10');
    t3.finish(lead, 'Two of three reviewed it: 8 and 7. Muse could not run.');
    await pass();
    const rows = (await threadsOf(councilId, 'research', 1)).filter((m) => m.role === 'member');
    expect(rows.map((m) => [m.label, m.state])).toEqual([
      ['GPT 6.1 Sol', 'done'],
      ['Claude Opus 5.5', 'done'],
      ['Muse Wonder Full 1.0', 'failed'],
    ]);
    expect((await press('stop', councilId)).statusCode).toBe(200);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });

  it('places a reviewer by its model when its title says nothing, and counts a wordless end as no answer', async () => {
    const { councilId, lead } = await start('review', 'Review the titles');
    const muse = t3.delegate(lead, { title: 'Design review', model: 'muse-wonder-full-1.0', answer: null });
    const opus = t3.delegate(lead, { title: 'Design review', model: 'claude-opus-5-5', answer: null });
    waitsForReviewers(lead);
    await pass();
    const rows = (await threadsOf(councilId, 'research', 1)).filter((m) => m.role === 'member');
    expect(rows.map((m) => [m.label, m.position, m.threadId])).toEqual([
      ['Claude Opus 5.5', 1, opus],
      ['Muse Wonder Full 1.0', 2, muse],
    ]);
    t3.finish(muse, null);
    t3.finish(opus, 'Calm and clear.\nScore: 8/10');
    await pass();
    const after = (await threadsOf(councilId, 'research', 1)).filter((m) => m.role === 'member');
    expect(after.map((m) => [m.state, m.score])).toEqual([
      ['done', 8],
      ['failed', null],
    ]);
    expect((await press('stop', councilId)).statusCode).toBe(200);
  });

  it('counts a reviewer that ran out of time as didn’t answer, and tells the lead to go on without it', async () => {
    const { councilId, lead } = await start('review', 'Review the slow one');
    const [slow] = reviewers(lead, 'look 1');
    waitsForReviewers(lead);
    await pass();
    await db()
      .update(councilMembers)
      .set({ deadline: new Date(t.services.clock().getTime() - 1000) })
      .where(eq(councilMembers.threadId, slow as string));
    await pass();
    const [row] = await db()
      .select()
      .from(councilMembers)
      .where(eq(councilMembers.threadId, slow as string));
    expect(row).toMatchObject({ state: 'no_answer' });
    const told = sends(lead).at(-1);
    expect(String(told?.args.message)).toContain('GPT 6.1 Sol ran out of time');
    // Told once: another pass says nothing more.
    const count = sends(lead).length;
    await pass();
    expect(sends(lead)).toHaveLength(count);
    expect(await wakesOf().then((w) => w.filter((d) => d.state === 'queued'))).toEqual([]);
    expect((await press('stop', councilId)).statusCode).toBe(200);
  });

  it('tells the lead once when it starts more rounds than the council allows', async () => {
    const { councilId, lead } = await start('review', 'Review twice');
    reviewers(lead, 'look 1').forEach((id) => {
      t3.finish(id, 'Fine.\nScore: 8/10');
    });
    reviewers(lead, 'look 2');
    waitsForReviewers(lead);
    await pass();
    await pass();
    const limits = sends(lead).filter((c) => String(c.args.message).includes('last round'));
    expect(limits).toHaveLength(1);
    expect((await press('stop', councilId)).statusCode).toBe(200);
  });

  it('wakes the agent when the lead ran out of time, and stops it', async () => {
    const { councilId, lead } = await start('review', 'Review the stuck lead');
    await db()
      .update(councilMembers)
      .set({ deadline: new Date(t.services.clock().getTime() - 1000) })
      .where(eq(councilMembers.threadId, lead));
    await pass();
    expect(await leadOf(councilId)).toMatchObject({ state: 'no_answer' });
    expect(sends(lead).at(-1)?.args.mode).toBe('restart');
    const [wake] = (await wakesOf()).filter((w) => w.state === 'queued');
    const context = await buildDispatchContext(t.services, wake as NonNullable<typeof wake>);
    expect(context.council).toMatchObject({ councilId, event: 'finished' });
    expect(context.council?.members.find((m) => m.role === 'builder')?.state).toBe('no_answer');
    expect((await press('stop', councilId)).statusCode).toBe(200);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });

  it('reads an answer only once the lead had time to hear of it, and at once when the lead is done', async () => {
    const { councilId, lead } = await start('review', 'Review with a delay');
    const [sol] = reviewers(lead, 'look 1').slice(0, 1);
    waitsForReviewers(lead);
    t3.finish(sol as string, 'Fine.\nScore: 8/10');
    councilTiming.answerSettleMs = 60_000;
    try {
      await pass();
      const [row] = await db()
        .select()
        .from(councilMembers)
        .where(eq(councilMembers.threadId, sol as string));
      expect(row).toMatchObject({ state: 'working', answer: null });
      // The lead itself is done: nothing is left to wait for.
      (t3.threads.get(lead) as T3StubThread).delegating = false;
      t3.finish(lead, 'One reviewer gives it 8.');
      await pass();
      const [read] = await db()
        .select()
        .from(councilMembers)
        .where(eq(councilMembers.threadId, sol as string));
      expect(read).toMatchObject({ state: 'done', score: 8 });
    } finally {
      councilTiming.answerSettleMs = 0;
    }
    expect((await press('stop', councilId)).statusCode).toBe(200);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });

  it('tells the lead again when T3 Code didn’t take the message', async () => {
    const { councilId, lead } = await start('review', 'Review with an outage');
    const [slow] = reviewers(lead, 'look 1');
    waitsForReviewers(lead);
    await pass();
    await db()
      .update(councilMembers)
      .set({ deadline: new Date(t.services.clock().getTime() - 1000) })
      .where(eq(councilMembers.threadId, slow as string));
    t3.knobs.failSends = 1;
    await pass();
    const late = () => sends(lead).filter((c) => String(c.args.message).includes('ran out of time'));
    const [waiting] = await db()
      .select()
      .from(councilMembers)
      .where(eq(councilMembers.threadId, slow as string));
    expect(waiting).toMatchObject({ state: 'no_answer', stopPending: true });
    // Its turn to be tried again has come.
    await db()
      .update(councilMembers)
      .set({ stopNextAt: null })
      .where(eq(councilMembers.threadId, slow as string));
    await pass();
    expect(late()).toHaveLength(2);
    const [told] = await db()
      .select()
      .from(councilMembers)
      .where(eq(councilMembers.threadId, slow as string));
    expect(told).toMatchObject({ stopPending: false });
    expect((await press('stop', councilId)).statusCode).toBe(200);
  });

  it('wakes the agent with the lead’s words, not a plan, when it ended before any plan was judged', async () => {
    const a = await turn();
    const res = await a.call('council_start', {
      kind: 'improve',
      title: 'No seat ran',
      question: 'Make it better.',
      intro: 'I asked the council to look at it.',
      project: 'Demo site',
    });
    await a.end();
    const lead = (await leadOf(res.councilId)).threadId;
    t3.finish(lead, 'T3 Code refused every seat, so no review could run.');
    await pass();
    expect(await councilRow(res.councilId)).toMatchObject({ stage: 'research', plan: null });
    const [wake] = (await wakesOf()).filter((w) => w.state === 'queued');
    const context = await buildDispatchContext(t.services, wake as NonNullable<typeof wake>);
    expect(context.council).toMatchObject({ councilId: res.councilId, event: 'finished' });
    expect((await press('stop', res.councilId)).statusCode).toBe(200);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });

  it('finds its reviewers behind a page of newer threads', async () => {
    const { councilId, lead } = await start('review', 'Review on a busy computer');
    const mine = reviewers(lead, 'look 1');
    waitsForReviewers(lead);
    // A hundred threads made after them fill the first page.
    const later = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 100; i++) t3.addThread(`mcp:busy-${i}`, `Busy ${i}`, 'gpt-5.5').createdAt = later;
    await pass();
    const rows = (await threadsOf(councilId, 'research', 1)).filter((m) => m.role === 'member');
    expect(rows.map((m) => m.threadId)).toEqual(mine);
    for (let i = 0; i < 100; i++) t3.threads.delete(`mcp:busy-${i}`);
    expect((await press('stop', councilId)).statusCode).toBe(200);
  });

  it('doesn’t take a lead that waits for its pull request’s checks as done', async () => {
    const a = await turn();
    const res = await a.call('council_start', {
      kind: 'improve',
      title: 'Waits for its checks',
      question: 'Make it better.',
      intro: 'I asked the council to look at it.',
      project: 'Demo site',
      goAllTheWay: true,
    });
    await a.end();
    const lead = (await leadOf(res.councilId)).threadId;
    for (const id of reviewers(lead, 'plan 1')) t3.finish(id, 'Good.\nVerdict: agree');
    // Its run ends while T3 Code watches the pull request for it: it runs again when the checks move.
    t3.watchPullRequest(lead, 'https://github.com/acme/site/pull/9');
    t3.finish(lead, 'Opened the pull request; waiting for its checks.');
    await pass();
    expect(await leadOf(res.councilId)).toMatchObject({ state: 'working' });
    expect((await wakesOf()).filter((w) => w.state === 'queued')).toEqual([]);
    t3.pullRequestsDone(lead);
    t3.finish(lead, 'Merged. Every reviewer agreed.');
    await pass();
    expect(await leadOf(res.councilId)).toMatchObject({ state: 'done' });
    expect((await wakesOf()).filter((w) => w.state === 'queued')).toHaveLength(1);
    expect((await press('stop', res.councilId)).statusCode).toBe(200);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });

  it('starts from the person’s checkout when it has no remote default branch', async () => {
    t3.knobs.missingBases = ['origin/HEAD'];
    const a = await turn();
    const res = await a.call('council_start', {
      kind: 'improve',
      title: 'No remote',
      question: 'Make it better.',
      intro: 'I asked the council to look at it.',
      project: 'Demo site',
      goAllTheWay: true,
    });
    await a.end();
    t3.knobs.missingBases = [];
    expect(res).toMatchObject({ status: 'started' });
    const call = launches().at(-1);
    expect(call?.args.workspaceStrategy).toMatchObject({ type: 'worktree', baseRef: 'HEAD' });
    // The person said to go all the way: the lead builds once the plan is agreed.
    expect(String(call?.args.message)).not.toContain('Then stop');
    expect((await press('stop', res.councilId)).statusCode).toBe(200);
  });

  it('ends a council from before the lead thread: nothing moves it on any more', async () => {
    const [any] = await db().select().from(councils).limit(1);
    const id = 'cnl_before_lead';
    await db()
      .insert(councils)
      .values({
        ...(any as NonNullable<typeof any>),
        id,
        title: 'From before',
        state: 'active',
        stage: 'research',
        outcome: null,
        endedAt: null,
        builderThreadId: null,
        liveMessageId: null,
        history: [],
        createdAt: new Date(t.services.clock().getTime() - 3_600_000),
        updatedAt: new Date(t.services.clock().getTime() - 3_600_000),
      });
    await pass();
    expect(await councilRow(id)).toMatchObject({ state: 'stopped', outcome: 'stopped' });
  });
});

describe('a council that went quiet', () => {
  it('ends by itself after a week without anything moving on', async () => {
    const [left] = await db().select().from(councils).where(eq(councils.state, 'active'));
    const a = await turn();
    const started = left
      ? null
      : await a.call('council_start', {
          kind: 'review',
          title: 'Quiet',
          question: 'Look.',
          intro: 'I asked the council to look at it.',
          project: 'Demo site',
        });
    await a.end();
    const id = left?.id ?? started?.councilId;
    t3.finish((await leadOf(id)).threadId, 'They give it 8.');
    await pass();
    await db()
      .update(councils)
      .set({ updatedAt: new Date(t.services.clock().getTime() - 8 * 86_400_000) })
      .where(eq(councils.id, id));
    await pass();
    expect((await councilRow(id))?.state).toBe('stopped');
  });
});

describe('the person’s council (CNL-50…CNL-54)', () => {
  async function call(op: 'setup' | 'saveSetup' | 'resetSetup', payload?: Json) {
    const ep = api.councils[op];
    return t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
      headers: { cookie },
      ...(payload ? { payload } : {}),
    });
  }
  const MINE = {
    seats: [
      { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'high' },
      { provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
    ],
    builder: 1,
    rounds: 2,
    target: 8.5,
  };

  async function stopAll() {
    for (const c of await db().select().from(councils).where(eq(councils.state, 'active')))
      expect((await press('stop', c.id)).statusCode).toBe(200);
  }

  it('shows Whombat’s own seats and what T3 Code can run while none is set', async () => {
    const res = await call('setup');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ setup: null, t3: 'ready' });
    expect(res.json().automatic.map((s: Json) => s.provider)).toEqual(['codex', 'claudeAgent', 'muse']);
    expect(res.json().options.find((p: Json) => p.id === 'codex').models[0]).toMatchObject({
      id: 'gpt-6.1-sol',
      efforts: ['low', 'high', 'xhigh'],
    });
  });

  it('keeps one council with its names, changes it in place, and refuses one that breaks the rules', async () => {
    const saved = await call('saveSetup', MINE);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().setup).toMatchObject({ builder: 1, rounds: 2, target: 8.5 });
    // The names T3 Code gave, kept so the council reads in words while it can't be asked.
    expect(saved.json().setup.seats[0]).toMatchObject({
      providerName: 'Claude',
      modelLabel: 'Claude Opus 5.5',
    });
    const again = await call('saveSetup', { ...MINE, target: 9 });
    expect(again.json().setup).toMatchObject({ target: 9 });
    expect(await db().select().from(councilSetups)).toHaveLength(1);
    const oneCompany = await call('saveSetup', {
      ...MINE,
      seats: [
        { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: null },
        { provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: null },
      ],
    });
    expect(oneCompany.statusCode).toBe(400);
    expect(oneCompany.json().error.message).toContain('two different');
    await call('saveSetup', MINE);
    // Who sits is T3 Code's council whatever was saved: Settings shows those seats with the person's rounds and score.
    const view = (await call('setup')).json();
    expect(view.setup).toMatchObject({ rounds: 2, target: 8.5, builder: 0 });
    expect(view.setup.seats).toEqual(view.automatic);
  });

  it('sits T3 Code’s council with the person’s rounds and score, the lead on the chat’s own AI, unless members are named for it', async () => {
    await stopAll();
    const before = launches().length;
    const a = await turn();
    const res = await a.call('council_start', {
      kind: 'improve',
      title: 'Their council',
      question: 'Make it better.',
      intro: 'I asked the council to look at it.',
      project: 'Demo site',
    });
    await a.end();
    expect(res).toMatchObject({ status: 'started' });
    // The seats saved in Settings don't sit: T3 Code's council does, as its last one sat.
    expect(res.members.map((m: Json) => m.name)).toEqual(SEATS.map(([name]) => name));
    // One lead thread, on the AI the chat runs on, not on a seat.
    const led = launches().slice(before);
    expect(led).toHaveLength(1);
    expect(led[0]?.args.modelSelection).toMatchObject({
      instanceId: 'claudeAgent',
      model: 'claude-opus-5-5',
    });
    expect(String(led[0]?.args.message)).toContain('at most 2 rounds');
    expect(String(led[0]?.args.message)).toContain('skill’s members');
    expect(await councilRow(res.councilId)).toMatchObject({
      builderSeat: 0,
      roundsMax: 2,
      target: 8.5,
      setupName: 'T3 Code',
    });
    await stopAll();

    const b = await turn();
    const named = await b.call('council_start', {
      kind: 'review',
      title: 'Named this time',
      question: 'Look.',
      intro: 'I asked the council to look at it.',
      members: [{ provider: 'Codex' }, { provider: 'Muse' }],
    });
    await b.end();
    expect(named.members.map((m: Json) => m.name)).toEqual(['GPT 6.1 Sol', 'Muse Wonder Full 1.0']);
    await stopAll();
  });

  it('goes back to Whombat’s own seats when the person resets it', async () => {
    expect((await call('resetSetup', {})).json()).toEqual({ setup: null });
    expect((await call('setup')).json().setup).toBeNull();
    expect(await db().select().from(councilSetups)).toHaveLength(0);
  });
});

describe('T3 Code’s own council', () => {
  async function start(title: string) {
    const a = await turn();
    const res = await a.call('council_start', {
      kind: 'review',
      title,
      question: 'Look at it.',
      intro: 'I asked the council to look at it.',
      project: 'Demo site',
    });
    await a.end();
    expect(res).toMatchObject({ status: 'started' });
    return { res, councilId: res.councilId as string, lead: (await leadOf(res.councilId)).threadId };
  }
  const codex = STUB_PROVIDERS[0] as { models: { id: string; options: unknown[] }[] };
  const astra = { id: 'gpt-6-astra', options: [{ id: 'reasoningEffort', values: ['high', 'xhigh'] }] };
  afterAll(() => {
    codex.models = codex.models.filter((m) => m.id !== astra.id);
  });

  it('follows the members its skill sits, and starts the next council on them', async () => {
    // A council where the lead sat Sol, Opus and Muse.
    const first = await start('Look with Sol');
    reviewers(first.lead, 'look 1');
    waitsForReviewers(first.lead);
    await pass();
    expect((await press('stop', first.councilId)).statusCode).toBe(200);

    // The skill now sits Astra: the next council starts on the seats the last one sat, then follows the lead.
    codex.models.push(astra);
    const next = await start('Look with Astra');
    expect(next.res.members.map((m: Json) => m.name)).toEqual(SEATS.map(([name]) => name));
    const brief = String(launches().at(-1)?.args.message);
    expect(brief).toContain('skill’s members');
    expect(brief).toContain('"model":"gpt-6.1-sol"');
    t3.delegate(next.lead, { title: 'Council · GPT 6 Astra · look 1', model: 'gpt-6-astra', answer: null });
    t3.delegate(next.lead, {
      title: 'Council · Claude Opus 5.5 · look 1',
      model: 'claude-opus-5-5',
      answer: null,
    });
    waitsForReviewers(next.lead);
    await pass();
    const { card } = await liveCard(next.councilId);
    expect(card.members.map((m) => [m.name, !!m.waiting])).toEqual([
      ['GPT 6 Astra', false],
      ['Claude Opus 5.5', false],
      ['Muse Wonder Full 1.0', true],
    ]);
    expect((await councilRow(next.councilId))?.seats.map((s) => s.model)).toEqual([
      'gpt-6-astra',
      'claude-opus-5-5',
      'muse-wonder-full-1.0',
    ]);
    expect((await press('stop', next.councilId)).statusCode).toBe(200);

    // Muse hadn't started when it was stopped: it keeps its seat.
    const third = await start('Look again');
    expect(third.res.members.map((m: Json) => m.name)).toEqual([
      'GPT 6 Astra',
      'Claude Opus 5.5',
      'Muse Wonder Full 1.0',
    ]);
    expect(String(launches().at(-1)?.args.message)).toContain('"model":"gpt-6-astra"');
    expect((await press('stop', third.councilId)).statusCode).toBe(200);
  });
});

describe('a list offered in the thread while a council looks at it', () => {
  it('holds Hand over until the council answers, then brings the list back to the end', async () => {
    // A thread of its own, so the councils of the suites before don't count.
    const send = api.messages.send;
    const sent = await t.api.inject({
      method: send.method,
      url: `${send.base}${buildPath(send.path, { burrow: 'burrow-hq', conversationId: IDS.dmDusty })}`,
      headers: { cookie },
      payload: { text: 'Can the council check the Inbox list before I hand it over?' },
    });
    expect(sent.statusCode).toBe(201);
    const root = sent.json().message.id as string;
    const inThread = async () => {
      const d = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.dmDusty, {
        onBehalfOfAccountId: mara,
        threadRootId: root,
      });
      const mcp = await mcpClient(t.baseUrl, d.token);
      return {
        async call(name: string, args: Record<string, unknown>): Promise<Json> {
          return ((await mcp.client.callTool({ name, arguments: args })).structuredContent ?? {}) as Json;
        },
        async end() {
          await mcp.close();
          await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, d.dispatchId));
        },
      };
    };
    const tasksCard = async (id: string) => {
      const [d] = await db().select().from(delegations).where(eq(delegations.id, id));
      const [m] = await db()
        .select()
        .from(messages)
        .where(eq(messages.id, d?.messageId ?? ''));
      return m?.card as { checking?: boolean; stage: string } | undefined;
    };
    const hand = (path: 'start' | 'stop', delegationId: string) => {
      const ep = api.delegations[path];
      return t.api.inject({
        method: ep.method,
        url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
        headers: { cookie },
        payload: { delegationId },
      });
    };

    const a = await inThread();
    const offered = await a.call('delegate_offer', {
      title: 'Calm the Inbox',
      intro: 'Here are two tasks.',
      project: 'Demo site',
      tasks: [
        { title: 'One line per item', brief: 'Make each item one line.' },
        { title: 'Taller rows', brief: 'Make the rows 44 px.' },
      ],
    });
    expect(offered).toMatchObject({ status: 'offered' });
    expect((await tasksCard(offered.delegationId))?.checking).toBeFalsy();
    const started = await a.call('council_start', {
      kind: 'review',
      title: 'Review the Inbox tasks',
      question: 'Are these the right tasks?',
      intro: 'I asked the council whether these are the right tasks.',
      project: 'Demo site',
    });
    await a.end();
    expect(started).toMatchObject({ status: 'started' });
    // The list says the council is looking at it, and Hand over waits.
    expect(await tasksCard(offered.delegationId)).toMatchObject({ checking: true, stage: 'offer' });
    expect((await hand('start', offered.delegationId)).statusCode).toBe(409);
    // The agent can't hand it over either, not even by offering it again “all the way”.
    const b = await inThread();
    expect(
      await b.call('delegate_update', { delegationId: offered.delegationId, start: true }),
    ).toMatchObject({
      status: 'ok',
    });
    expect((await tasksCard(offered.delegationId))?.stage).toBe('offer');
    expect((await hand('stop', offered.delegationId)).statusCode).toBe(200);
    const again = await b.call('delegate_offer', {
      title: 'Calm the Inbox',
      intro: 'Handing these over.',
      project: 'Demo site',
      start: true,
      tasks: [{ title: 'One line per item', brief: 'Make each item one line.' }],
    });
    await b.end();
    expect(again).toMatchObject({ status: 'offered' });
    expect((await tasksCard(again.delegationId))?.checking).toBe(true);
    offered.delegationId = again.delegationId;
    // The council answers that the list is right: the list can be handed over again, and it comes after the
    // conclusion, at the thread's end, where the person acts.
    const c = await inThread();
    expect(
      await c.call('council_finish', {
        councilId: started.councilId,
        summary: 'The list is right as it is.',
      }),
    ).toMatchObject({ status: 'finished' });
    await c.end();
    expect((await tasksCard(offered.delegationId))?.checking).toBeFalsy();
    const thread = (await db().select().from(messages).where(eq(messages.threadRootId, root))).sort(
      (x, y) => x.ord - y.ord,
    );
    const [d] = await db().select().from(delegations).where(eq(delegations.id, offered.delegationId));
    expect(thread.at(-1)?.id).toBe(d?.messageId);
    expect(thread.at(-2)?.text).toBe('The list is right as it is.');
    expect((await hand('stop', offered.delegationId)).statusCode).toBe(200);
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });
});

describe('the tasks a review found', () => {
  it('come on the review’s conclusion itself: one message, told once', async () => {
    const send = api.messages.send;
    const sent = await t.api.inject({
      method: send.method,
      url: `${send.base}${buildPath(send.path, { burrow: 'burrow-hq', conversationId: IDS.dmDusty })}`,
      headers: { cookie },
      payload: { text: 'Can the council review the Inbox?' },
    });
    expect(sent.statusCode).toBe(201);
    const root = sent.json().message.id as string;
    const inThread = async () => {
      const d = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.dmDusty, {
        onBehalfOfAccountId: mara,
        threadRootId: root,
      });
      const mcp = await mcpClient(t.baseUrl, d.token);
      return {
        async call(name: string, args: Record<string, unknown>): Promise<Json> {
          return ((await mcp.client.callTool({ name, arguments: args })).structuredContent ?? {}) as Json;
        },
        async end() {
          await mcp.close();
          await db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, d.dispatchId));
        },
      };
    };
    const a = await inThread();
    const started = await a.call('council_start', {
      kind: 'review',
      title: 'Review the Inbox',
      question: 'How busy is the Inbox?',
      intro: 'I asked the council to review the Inbox.',
      project: 'Demo site',
    });
    await a.end();
    expect(started).toMatchObject({ status: 'started' });
    const b = await inThread();
    expect(
      await b.call('council_finish', {
        councilId: started.councilId,
        summary: 'They give it 6 to 7: it is busy.',
      }),
    ).toMatchObject({ status: 'finished' });
    const offered = await b.call('delegate_offer', {
      title: 'Calm the Inbox',
      intro: 'Here is what they found as one task. Tick it and hand it over.',
      project: 'Demo site',
      tasks: [{ title: 'One line per item', brief: 'Make each item one line.' }],
    });
    await b.end();
    expect(offered).toMatchObject({ status: 'offered' });
    const thread = (await db().select().from(messages).where(eq(messages.threadRootId, root))).sort(
      (x, y) => x.ord - y.ord,
    );
    const [d] = await db().select().from(delegations).where(eq(delegations.id, offered.delegationId));
    const last = thread.at(-1);
    // The conclusion holds the list: its words, then the intro, then the card; no message of its own.
    expect(last?.id).toBe(d?.messageId);
    expect(last?.text.startsWith('They give it 6 to 7: it is busy.')).toBe(true);
    expect(last?.text).toContain('Tick it and hand it over.');
    expect((last?.card as { kind?: string } | null)?.kind).toBe('delegation');
    expect(thread.filter((m) => m.text.includes('Tick it and hand it over.'))).toHaveLength(1);
    // Told once: the conclusion's notice, nothing more for the list.
    await t.services.background.settle();
    const told = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.messageId, last?.id ?? ''));
    expect(told.length).toBeGreaterThan(0);
    const ep = api.delegations.stop;
    await t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
      headers: { cookie },
      payload: { delegationId: offered.delegationId },
    });
    await db()
      .update(dispatches)
      .set({ state: 'done' })
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  });
});
