/**
 * T3 Code threads wake the agent (docs/decisions/t3code.md), against a real Postgres and a stand-in T3 Code
 * behind a home-network address: the agent's own `connection_call`s keep the watch (a launch, an answer, a stop, a wait
 * that saw the end), the watcher's passes wake it with one `t3_thread` turn in the thread it handed the work over in, for
 * the same person, with what the thread asks or answered in its context — once per thing, never while a turn of it is at
 * work there, not before delegated work settled. Postgres because the watch, the wake and the turn are commits.
 */
import { api, buildPath, JOB_REPORT_MARK, T3_HANDOFFS_MAX } from '@whombat/core';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startT3Code, type T3CodeStub } from '../connections/testing/t3code-stub';
import { dispatches, messages, notifications, t3Watches, vaultNetworks } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { PERSON_WORDS_MARK } from './person-words';
import { progressOf } from './progress';
import { NO_REPORT_WORDS } from './result';
import { T3_WATCH_PER_PASS, T3Watcher } from './watch';

const t = useTestServer({ seed: true, listen: true });

const HOSTS: Record<string, string> = { 't3.home.test': '192.168.92.10' };
/** The thread of Mara's chat with Dusty the work is handed over in. */
const ROOT = 'msg_dm-mara-1402';

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

let t3: T3CodeStub;
let mara = '';
let connectionId = '';

const db = () => t.services.db;
const pass = () => new T3Watcher(t.services).pass();
/** A pass once finished threads have been quiet long enough to be settled in T3 Code. */
const quietPass = () => new T3Watcher(t.services, { quietMs: 0 }).pass();

/** A turn of Dusty's for Mara in that thread (or another kind of turn there), at work until `end`. */
async function turn(kind: { trigger?: 'automation'; messageId?: string } = {}) {
  const d = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.dmDusty, {
    onBehalfOfAccountId: mara,
    threadRootId: ROOT,
    ...kind,
  });
  const mcp = await mcpClient(t.baseUrl, d.token);
  return {
    id: d.dispatchId,
    async call(tool: string, args: Record<string, unknown>): Promise<Json> {
      const res = await mcp.client.callTool({
        name: 'connection_call',
        arguments: { connection: 't3', tool, arguments: args },
      });
      return (res.structuredContent ?? {}) as Json;
    },
    async end(state: 'done' | 'cancelled' = 'done') {
      await mcp.close();
      await db().update(dispatches).set({ state }).where(eq(dispatches.id, d.dispatchId));
    },
  };
}

const done = (id: string) => db().update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, id));

const wakes = () =>
  db()
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.trigger, 't3_thread')));

async function watchOf(threadId: string) {
  const [row] = await db().select().from(t3Watches).where(eq(t3Watches.threadId, threadId));
  return row;
}

/** Mara's read of her chat's hand-overs: the job of `threadId`. */
async function handoffsOf(threadId: string): Promise<Json | undefined> {
  const { cookie } = await sessionFor(t.services, IDS.mara);
  const ep = api.conversations.handoffs;
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', conversationId: IDS.dmDusty })}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json().handoffs as Json[]).find((h) => h.id === threadId);
}

/** The job's result messages in the chat, oldest first. */
const resultsOf = (threadId: string) =>
  db()
    .select()
    .from(messages)
    .where(sql`${messages.jobResult}->>'handoffId' = ${threadId}`)
    .orderBy(messages.ord);

/** What the latest wake told of the thread: one not yet done, as a row marked done may come back last. */
async function toldOf(threadId: string): Promise<Json | undefined> {
  const all = await wakes();
  const wake = all.filter((w) => w.state !== 'done').at(-1) ?? all.at(-1);
  if (!wake) return undefined;
  return (await buildDispatchContext(t.services, wake)).t3Threads?.find((x) => x.threadId === threadId);
}

/** Dusty settles the thread in a turn of its own, as it does once the job is finished; the call's answer. */
async function settleAs(threadId: string): Promise<Json> {
  const a = await turn();
  const res = await a.call('t3_thread_organize', { threadId, action: 'settle' });
  await a.end();
  return res;
}

async function launch(title: string): Promise<string> {
  const a = await turn();
  const res = await a.call('t3_thread_launch', { projectId: 'mcp:project-1', title, message: 'Do it.' });
  expect(res).toMatchObject({ status: 'ok', isError: false });
  await a.end();
  return JSON.parse(res.content).threadId as string;
}

beforeAll(async () => {
  t3 = await startT3Code();
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const address = HOSTS[host];
      if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith('192.168.92.') ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await db()
    .insert(vaultNetworks)
    .values({
      id: 'vnw_t3wake_test',
      cidr: '192.168.92.0/24',
      ports: [t3.port],
      note: 'T3 Code stand-in',
      addedAt: t.services.clock(),
    });
  const { cookie } = await sessionFor(t.services, IDS.mara);
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
      fields: { url: `http://t3.home.test:${t3.port}` },
      login: { password: t3.pairingCode() },
      access: 'manage',
    },
  });
  expect(res.statusCode).toBe(201);
  connectionId = res.json().connection.id;
});

afterAll(async () => {
  await t3?.close();
});

describe('a thread the agent handed work to wakes it', () => {
  let threadId = '';
  let first = '';

  it('watches a thread it starts, from the thread it was asked in, for that person', async () => {
    const a = await turn();
    const res = await a.call('t3_thread_launch', {
      projectId: 'mcp:project-1',
      title: 'Fix the login bug',
      message: 'Fix the login bug.',
    });
    expect(res).toMatchObject({ status: 'ok', isError: false });
    threadId = JSON.parse(res.content).threadId;
    // T3 Code's list shows who handed it over.
    expect(t3.threads.get(threadId)?.title).toBe('Dusty - Fix the login bug');
    // The thread leads the job: it is told when subagents are worth it, after the agent's own words.
    const sent = String(t3.calls.find((c) => c.name === 't3_thread_launch')?.args.message);
    expect(sent.startsWith('Fix the login bug.')).toBe(true);
    expect(sent).toContain('You may start subagents.');
    expect(sent).toContain('At most 3 at a time');
    expect(await watchOf(threadId)).toMatchObject({
      connectionId,
      conversationId: IDS.dmDusty,
      threadRootId: ROOT,
      agentId: IDS.dusty,
      personId: IDS.mara,
      state: 'watching',
      title: 'Dusty - Fix the login bug',
    });

    // It asks while the turn that started it is still at work: that turn may read it itself, so nobody is woken,
    // but the job already shows the question for Mara to answer.
    t3.ask(threadId, 'request-7', 'Which colour should the buttons be?', ['Blue', 'Green']);
    await pass();
    expect(await wakes()).toEqual([]);
    expect(await handoffsOf(threadId)).toMatchObject({
      state: 'asked',
      question: { requestId: 'request-7', text: 'Which colour should the buttons be?' },
    });
    await a.end();
  });

  it('wakes it there once with the question to answer', async () => {
    await pass();
    const [wake, more] = await wakes();
    expect(more).toBeUndefined();
    expect(wake).toMatchObject({
      state: 'queued',
      conversationId: IDS.dmDusty,
      threadRootId: ROOT,
      onBehalfOfAccountId: mara,
    });
    first = wake?.id as string;
    const context = await buildDispatchContext(t.services, wake as NonNullable<typeof wake>);
    expect(context.t3Threads).toEqual([
      expect.objectContaining({
        connection: 't3',
        threadId,
        title: 'Dusty - Fix the login bug',
        event: 'asks',
        requestId: 'request-7',
        questions: [expect.objectContaining({ id: 'q1', question: 'Which colour should the buttons be?' })],
      }),
    ]);
    expect(context.t3Threads?.[0]?.questions[0]?.options.map((o) => o.label)).toEqual(['Blue', 'Green']);
    // The same question again wakes nobody.
    await pass();
    expect(await wakes()).toHaveLength(1);
  });

  it('after its answer, wakes it once more when the work is over, delegated work included', async () => {
    await done(first);
    const b = await turn();
    const answered = await b.call('t3_pending_request', {
      action: 'respond',
      threadId,
      requestId: 'request-7',
      answers: { q1: 'Green' },
    });
    expect(answered).toMatchObject({ status: 'ok', isError: false });
    await b.end();
    await pass();
    expect(await wakes()).toHaveLength(1);

    const thread = t3.threads.get(threadId);
    if (!thread) throw new Error('no thread');
    thread.delegating = true;
    t3.finish(threadId, 'Done: the buttons are green. Pull request #12 is open.');
    await pass();
    expect(await wakes()).toHaveLength(1);
    expect(thread.settled).toBe(false);

    thread.delegating = false;
    await pass();
    const second = (await wakes()).find((w) => w.id !== first);
    expect(second).toMatchObject({ state: 'queued', threadRootId: ROOT, onBehalfOfAccountId: mara });
    const context = await buildDispatchContext(t.services, second as NonNullable<typeof second>);
    expect(context.t3Threads).toEqual([
      expect.objectContaining({ threadId, event: 'finished', status: 'completed' }),
    ]);
    expect(context.t3Threads?.[0]?.answer).toContain('Pull request #12');
    expect((await watchOf(threadId))?.state).toBe('idle');
    // Told, and left in T3 Code's list: only the agent knows whether the job is finished.
    await quietPass();
    expect(thread.settled).toBe(false);
    expect(await settleAs(threadId)).toMatchObject({ status: 'ok', isError: false });
    expect(thread.settled).toBe(true);
    await done(second?.id as string);
    await pass();
    expect(await wakes()).toHaveLength(2);
  });
});

describe('a thread that waits for its pull request', () => {
  it('stays watched and unsettled until T3 Code stops watching it, and wakes the agent for each run', async () => {
    const PR = 'https://github.com/acme/site/pull/322';
    const before = (await wakes()).length;
    const threadId = await launch('Fix the revoked key');
    const thread = t3.threads.get(threadId);
    if (!thread) throw new Error('no thread');
    // Its run ends saying it waits for the checks; T3 Code watches the pull request for it.
    t3.watchPullRequest(threadId, PR);
    t3.finish(threadId, 'Watching #322; checks are pending.');
    await pass();
    const first = (await wakes()).at(-1);
    expect(await wakes()).toHaveLength(before + 1);
    const context = await buildDispatchContext(t.services, first as NonNullable<typeof first>);
    expect(context.t3Threads?.[0]).toMatchObject({ threadId, event: 'finished', watching: [PR] });
    expect((await watchOf(threadId))?.state).toBe('watching');
    // Settling would end T3 Code's watch of the pull request, so the agent's settle waits.
    expect(thread.settled).toBe(false);
    expect(await settleAs(threadId)).toMatchObject({ status: 'blocked' });
    expect(thread.settled).toBe(false);
    expect(thread.watching).toEqual([PR]);
    await done(first?.id as string);
    await pass();
    expect(await wakes()).toHaveLength(before + 1);
    expect(thread.settled).toBe(false);

    // The checks passed: T3 Code runs the thread again, and its end wakes the agent once more.
    expect(t3.pullRequestMoved(threadId)).toBe(true);
    await pass();
    expect(await wakes()).toHaveLength(before + 1);
    t3.finish(threadId, 'Green.');
    await pass();
    const all = await wakes();
    expect(all).toHaveLength(before + 2);
    const second = all.at(-1) as NonNullable<(typeof all)[number]>;
    expect((await buildDispatchContext(t.services, second)).t3Threads?.[0]?.answer).toBe('Green.');
    await done(second.id);

    // Merged: T3 Code stops watching it, so the work is over and the agent may settle the thread.
    t3.pullRequestsDone(threadId);
    await pass();
    expect(await wakes()).toHaveLength(before + 2);
    expect((await watchOf(threadId))?.state).toBe('idle');
    await quietPass();
    expect(thread.settled).toBe(false);
    expect(await settleAs(threadId)).toMatchObject({ status: 'ok', isError: false });
    expect(thread.settled).toBe(true);
  });
});

describe('what the agent knows already isn’t told again', () => {
  it('a thread it waited for to the end in its turn', async () => {
    const before = (await wakes()).length;
    const a = await turn();
    const res = await a.call('t3_thread_launch', { projectId: 'mcp:project-1', title: 'Quick look' });
    const threadId = JSON.parse(res.content).threadId as string;
    t3.finish(threadId, 'It uses Postgres 17.');
    const waited = await a.call('t3_thread_wait', { threadId, timeoutMs: 25_000 });
    expect(JSON.parse(waited.content)).toMatchObject({ timedOut: false, status: 'completed' });
    await pass();
    await a.end();
    await pass();
    expect(await wakes()).toHaveLength(before);
    expect((await watchOf(threadId))?.state).toBe('idle');
    // The agent settles it when the job is finished; Whombat doesn't guess.
    await quietPass();
    expect(t3.threads.get(threadId)?.settled).toBe(false);
  });

  it('a failed thread is told but stays in T3 Code’s list', async () => {
    const before = (await wakes()).length;
    const threadId = await launch('Try the upgrade');
    t3.finish(threadId, 'The tests failed.', 'failed');
    await pass();
    const all = await wakes();
    expect(all).toHaveLength(before + 1);
    expect(t3.threads.get(threadId)?.settled).toBe(false);
    await done((all.at(-1) as NonNullable<(typeof all)[number]>).id);
  });

  it('a permission request is told with its page; a thread it stopped isn’t', async () => {
    const before = (await wakes()).length;
    const threadId = await launch('Make a file');
    t3.askPermission(threadId, 'Write hello.txt');
    await pass();
    const all = await wakes();
    expect(all).toHaveLength(before + 1);
    const wake = all.at(-1) as NonNullable<(typeof all)[number]>;
    const context = await buildDispatchContext(t.services, wake);
    const told = context.t3Threads?.[0];
    expect(told).toMatchObject({ event: 'approval', approval: 'Write hello.txt' });
    expect(told?.url).toContain('77d8990d-3960-4937-9ab5-1f65c3954ede');
    expect(told?.url).toContain(encodeURIComponent(threadId));
    await done(wake.id);

    const b = await turn();
    expect(await b.call('t3_thread_interrupt', { threadId, reason: 'Mara asked.' })).toMatchObject({
      status: 'ok',
    });
    await b.end();
    expect((await watchOf(threadId))?.state).toBe('idle');
    t3.finish(threadId, null, 'interrupted');
    await pass();
    expect(await wakes()).toHaveLength(before + 1);
  });

  it('reads the thread read longest ago first, so a busy box gives every thread its turn', async () => {
    const threadId = await launch('Waited longest');
    const now = t.services.clock().getTime();
    const long = new Date(now - 3_600_000);
    await db()
      .update(t3Watches)
      .set({ armedAt: new Date(now - 86_400_000), checkedAt: long })
      .where(eq(t3Watches.threadId, threadId));
    const old = await watchOf(threadId);
    // A pass's worth of newer watches, all read more recently than it.
    await db()
      .insert(t3Watches)
      .values(
        Array.from({ length: T3_WATCH_PER_PASS }, (_, i) => ({
          ...(old as NonNullable<typeof old>),
          threadId: `newer-${i}`,
          armedAt: new Date(now - 60_000),
          checkedAt: new Date(now - 30_000),
        })),
      );
    await pass();
    expect((await watchOf(threadId))?.checkedAt?.getTime()).toBeGreaterThan(long.getTime());
    await db().delete(t3Watches).where(like(t3Watches.threadId, 'newer-%'));
  });

  it('a thread T3 Code no longer has goes quiet', async () => {
    const threadId = await launch('Gone soon');
    t3.threads.delete(threadId);
    await pass();
    expect((await watchOf(threadId))?.state).toBe('idle');
  });
});

describe('the agent settles a thread once its job is finished', () => {
  it('not while it is at work or waits for work it delegated', async () => {
    const threadId = await launch('Clean the cache');
    const thread = t3.threads.get(threadId);
    if (!thread) throw new Error('no thread');
    expect(await settleAs(threadId)).toMatchObject({ status: 'blocked' });
    thread.delegating = true;
    t3.finish(threadId, 'Cleaned; the tests still run.');
    expect(await settleAs(threadId)).toMatchObject({ status: 'blocked' });
    expect(thread.settled).toBe(false);
    thread.delegating = false;
    expect(await settleAs(threadId)).toMatchObject({ status: 'ok', isError: false });
    expect(thread.settled).toBe(true);
    await pass();
    for (const w of await wakes()) await done(w.id);
  });
});

describe('a thread that goes on after its run ended', () => {
  it('holds back an end while the thread waits for work, and tells the end of the run that comes after once', async () => {
    for (const w of await wakes()) await done(w.id);
    const before = (await wakes()).length;
    const threadId = await launch('Tidy the helpers');
    const thread = t3.threads.get(threadId);
    if (!thread) throw new Error('no thread');
    // Its run ends while a command it waits for still runs (T3 Code's wait hasn't settled): that end isn't the job's
    // end. Nobody is told, nothing is posted, and the job shows as finishing.
    thread.delegating = true;
    t3.finish(threadId, 'Still waiting on the tests.');
    await pass();
    expect(await wakes()).toHaveLength(before);
    expect(await resultsOf(threadId)).toEqual([]);
    expect(await watchOf(threadId)).toMatchObject({ state: 'watching', wakes: true });
    expect(await handoffsOf(threadId)).toMatchObject({ state: 'finishing' });

    // The command ended: T3 Code runs the thread again, and this run's answer is the result.
    thread.delegating = false;
    t3.runAgain(threadId);
    await pass();
    expect(await wakes()).toHaveLength(before);
    t3.finish(threadId, 'Merged: three helpers became one.');
    await pass();
    const all = await wakes();
    expect(all).toHaveLength(before + 1);
    const told = await toldOf(threadId);
    expect(told).toMatchObject({ threadId, event: 'finished', reported: true });
    expect(told?.answer).toContain('three helpers became one');
    const results = await resultsOf(threadId);
    expect(results.map((m) => m.text)).toEqual(['Merged: three helpers became one.']);
    for (const w of all) await done(w.id);
    // Told once: the same end again wakes nobody.
    await pass();
    expect(await wakes()).toHaveLength(before + 1);
  });

  it('keeps a thread that left a command running unsettled, and tells the run that command’s end starts', async () => {
    const before = (await wakes()).length;
    const threadId = await launch('Build the app');
    const thread = t3.threads.get(threadId);
    if (!thread) throw new Error('no thread');
    // Its run ends while a build it didn't wait for still runs: T3 Code calls the thread finished, so it is told.
    t3.finish(threadId, 'Waiting for the Android build.');
    await pass();
    expect(await wakes()).toHaveLength(before + 1);
    expect((await resultsOf(threadId)).map((m) => m.text)).toEqual(['Waiting for the Android build.']);
    expect((await watchOf(threadId))?.state).toBe('idle');
    // Settling would stop the build: the thread isn't settled before it has been quiet.
    await pass();
    expect(thread.settled).toBe(false);
    for (const w of await wakes()) await done(w.id);

    // The build ended and T3 Code ran the thread again: the watch is on again, and that run's end is told.
    t3.runAgain(threadId);
    await quietPass();
    expect(thread.settled).toBe(false);
    expect((await watchOf(threadId))?.state).toBe('watching');
    t3.finish(threadId, 'The build passed.');
    await pass();
    expect(await wakes()).toHaveLength(before + 2);
    expect((await toldOf(threadId))?.answer).toContain('The build passed');
    // Nobody wrote after the first report: the same message says how it ended.
    expect((await resultsOf(threadId)).map((m) => m.text)).toEqual(['The build passed.']);
    for (const w of await wakes()) await done(w.id);
    await quietPass();
    expect(thread.settled).toBe(false);
  });

  it('tries a settle T3 Code refused again later', async () => {
    const step = await turn({ trigger: 'automation' });
    const res = await step.call('t3_thread_launch', { projectId: 'mcp:project-1', title: 'Rename the page' });
    const threadId = JSON.parse(res.content).threadId as string;
    t3.finish(threadId, 'Renamed.');
    await step.end();
    await pass();
    t3.knobs.failSettles = 1;
    await quietPass();
    expect(t3.threads.get(threadId)?.settled).toBe(false);
    expect(progressOf((await watchOf(threadId))?.progress).settle).not.toBeNull();
    await quietPass();
    expect(t3.threads.get(threadId)?.settled).toBe(true);
    expect(progressOf((await watchOf(threadId))?.progress).settle).toBeNull();
  });
});

describe('the job’s result in the thread', () => {
  const REPORT =
    'The login works again: the session cookie lasted too short.\n\n## Left for you\n1. **Keep the old page?** It is unused.\n   - Choices: Keep it | Remove it';
  let threadId = '';
  let resultId = '';

  it('posts T3 Code’s report in the thread it was handed over from, and tells the agent so', async () => {
    const before = (await wakes()).length;
    threadId = await launch('Fix the login');
    // The thread was told how to write its report.
    const brief = String(t3.calls.filter((c) => c.name === 't3_thread_launch').at(-1)?.args.message);
    expect(brief).toContain(JOB_REPORT_MARK);
    t3.finish(threadId, REPORT);
    await pass();
    const [result, more] = await resultsOf(threadId);
    expect(more).toBeUndefined();
    expect(result).toMatchObject({
      text: REPORT,
      conversationId: IDS.dmDusty,
      threadRootId: ROOT,
      authorId: IDS.dusty,
      editedAt: null,
    });
    expect(result?.jobResult).toMatchObject({
      handoffId: threadId,
      outcome: 'completed',
      cut: false,
      sends: [],
    });
    resultId = result?.id as string;
    expect(await wakes()).toHaveLength(before + 1);
    expect(await toldOf(threadId)).toMatchObject({ event: 'finished', reported: true });
    expect(await watchOf(threadId)).toMatchObject({ resultMessageId: resultId, state: 'idle' });
    expect((await handoffsOf(threadId))?.resultMessageId).toBe(resultId);
    for (const w of await wakes()) await done(w.id);
  });

  it('sends the person’s answers to the thread together, and the next end updates the same message', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const ep = api.messages.jobAnswers;
    const answer = () =>
      t.api.inject({
        method: ep.method,
        url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', messageId: resultId })}`,
        headers: { cookie },
        payload: {
          answers: [
            { point: 2, title: 'Rename the cookie?', choice: null, words: 'Call it session.' },
            { point: 1, title: 'Keep the old page?', choice: 'Remove it', words: null },
          ],
        },
      });
    const res = await answer();
    expect(res.statusCode).toBe(200);
    expect(res.json().message.jobResult.sends).toEqual([
      expect.objectContaining({ doneAt: null, outcome: null }),
    ]);
    const sent = String(t3.calls.filter((c) => c.name === 't3_thread_send').at(-1)?.args.message);
    expect(sent).toContain('1. Keep the old page?: Remove it');
    expect(sent).toContain('2. Rename the cookie?: Call it session.');
    expect(await watchOf(threadId)).toMatchObject({
      state: 'watching',
      wakes: true,
      resultMessageId: resultId,
    });
    // One sending at a time.
    expect((await answer()).statusCode).toBe(409);

    await pass();
    t3.finish(threadId, 'Done: the old page is gone and the cookie is called session.');
    await pass();
    const results = await resultsOf(threadId);
    expect(results.map((m) => m.id)).toEqual([resultId]);
    expect(results[0]).toMatchObject({
      text: 'Done: the old page is gone and the cookie is called session.',
      editedAt: null,
    });
    expect(results[0]?.jobResult?.sends).toEqual([
      expect.objectContaining({ outcome: 'completed', doneAt: expect.any(String) }),
    ]);
    expect(await toldOf(threadId)).toMatchObject({ event: 'finished', reported: true });
    // Mara hears once that the report changed, with a link to the same message.
    await vi.waitFor(async () => {
      const notices = await db()
        .select()
        .from(notifications)
        .where(and(eq(notifications.messageId, resultId), like(notifications.dedupKey, 'job-result:%')));
      expect(notices).toEqual([expect.objectContaining({ principalId: IDS.mara })]);
      expect(notices[0]?.text).toContain('Dusty - Fix the login');
    });
    for (const w of await wakes()) await done(w.id);
  });

  it('posts a new message for the next end once someone wrote in the thread after it', async () => {
    await db().insert(messages).values({
      id: 'msg_after_result_1',
      burrowId: t.burrowId,
      conversationId: IDS.dmDusty,
      authorId: IDS.mara,
      createdAt: t.services.clock(),
      text: 'Thanks. Now the logout too.',
      threadRootId: ROOT,
    });
    const a = await turn();
    await a.call('t3_thread_send', { threadId, message: 'Fix the logout too.' });
    await a.end();
    await pass();
    t3.finish(threadId, 'The logout works too.');
    await pass();
    const results = await resultsOf(threadId);
    expect(results.map((m) => m.text)).toEqual([
      'Done: the old page is gone and the cookie is called session.',
      'The logout works too.',
    ]);
    expect((await watchOf(threadId))?.resultMessageId).toBe(results[1]?.id);
    for (const w of await wakes()) await done(w.id);
  });

  it('keeps the report when someone asks the thread for more in T3 Code itself', async () => {
    const job = await launch('Tidy the code');
    t3.finish(job, REPORT);
    await pass();
    const [report] = await resultsOf(job);
    for (const w of await wakes()) await done(w.id);

    // The person answers in T3 Code on their phone, and that run is stopped: its last words are no report.
    t3.message(job, '1. Remove the old page.');
    await quietPass();
    expect((await watchOf(job))?.state).toBe('watching');
    t3.finish(job, 'Now removing the old page.', 'interrupted');
    await pass();
    let results = await resultsOf(job);
    expect(results.map((m) => m.text)).toEqual([REPORT, NO_REPORT_WORDS.stopped]);
    expect(results[0]?.id).toBe(report?.id);
    expect(results[0]?.jobResult).toMatchObject({ outcome: 'completed' });
    expect(results[1]?.jobResult).toMatchObject({ outcome: 'stopped' });
    // The agent is told what the person wrote there, so it doesn't overrule them.
    expect(await toldOf(job)).toMatchObject({ personSaid: ['1. Remove the old page.'] });
    for (const w of await wakes()) await done(w.id);

    // The agent asks it to finish: that run's report is a message of its own too.
    const a = await turn();
    await a.call('t3_thread_send', { threadId: job, message: 'Finish removing the old page.' });
    await a.end();
    await pass();
    t3.finish(job, 'The old page is gone.');
    await pass();
    results = await resultsOf(job);
    expect(results.map((m) => m.text)).toEqual([REPORT, NO_REPORT_WORDS.stopped, 'The old page is gone.']);
    expect((await watchOf(job))?.resultMessageId).toBe(results[2]?.id);
    // Told once: the agent's own message isn't the person's.
    expect(await toldOf(job)).toMatchObject({ personSaid: [] });
    for (const w of await wakes()) await done(w.id);
  });

  it('keeps the report when the run that carries out the person’s answers is stopped', async () => {
    const job = await launch('Clean up the settings');
    t3.finish(job, REPORT);
    await pass();
    const [report] = await resultsOf(job);
    for (const w of await wakes()) await done(w.id);
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const ep = api.messages.jobAnswers;
    const res = await t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', messageId: report?.id as string })}`,
      headers: { cookie },
      payload: { answers: [{ point: 1, title: 'Keep the old page?', choice: 'Remove it', words: null }] },
    });
    expect(res.statusCode).toBe(200);
    await pass();
    t3.finish(job, 'Removing the old page now.', 'interrupted');
    await pass();
    const results = await resultsOf(job);
    expect(results.map((m) => m.id)).toEqual([report?.id]);
    expect(results[0]?.text).toBe(REPORT);
    expect(results[0]?.jobResult).toMatchObject({ outcome: 'completed' });
    expect(results[0]?.jobResult?.sends).toEqual([
      expect.objectContaining({ outcome: 'stopped', doneAt: expect.any(String) }),
    ]);
    for (const w of await wakes()) await done(w.id);
  });

  it('takes the person’s own message to the job', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const ep = api.conversations.handoffSend;
    const res = await t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', conversationId: IDS.dmDusty })}`,
      headers: { cookie },
      payload: { handoffId: threadId, text: 'Also tidy the logout page.', mode: 'steer' },
    });
    expect(res.statusCode).toBe(200);
    expect(t3.calls.filter((c) => c.name === 't3_thread_send').at(-1)?.args.message).toBe(
      'Also tidy the logout page.',
    );
    expect((await watchOf(threadId))?.state).toBe('watching');
    t3.finish(threadId, 'The logout page is tidy.');
    await pass();
    for (const w of await wakes()) await done(w.id);
  });

  it('says a failed job ran into a problem when it wrote no report', async () => {
    const failed = await launch('Upgrade the database');
    t3.finish(failed, null, 'failed');
    await pass();
    const [result] = await resultsOf(failed);
    expect(result?.text).toContain('ran into a problem');
    expect(result?.jobResult).toMatchObject({ outcome: 'failed' });
    expect(await toldOf(failed)).toMatchObject({ reported: true });
    for (const w of await wakes()) await done(w.id);
  });
});

describe('a thread at work is read the moment it ends', () => {
  it('holds a wait open at T3 Code, and wakes the agent without waiting for the next pass', async () => {
    const before = (await wakes()).length;
    const threadId = await launch('Rename the helper');
    t3.knobs.holdsWaits = true;
    const watcher = new T3Watcher(t.services, { holdMs: 1500 }).holdWaits();
    try {
      // The pass reads it at work, then a wait for its end stays open at T3 Code.
      await watcher.pass();
      expect(await wakes()).toHaveLength(before);
      const holds = () =>
        t3.calls.filter(
          (c) => c.name === 't3_thread_wait' && c.args.threadId === threadId && c.args.timeoutMs === 1500,
        );
      await vi.waitFor(() => expect(holds()).toHaveLength(1));
      expect(holds()[0]?.args.untilDelegatedWorkSettled).toBe(true);
      t3.finish(threadId, 'Renamed in four files.');
      // No pass in between: the wait came back, and the thread was read at once.
      await vi.waitFor(async () => expect(await wakes()).toHaveLength(before + 1), { timeout: 4000 });
      expect((await watchOf(threadId))?.state).toBe('idle');
    } finally {
      t3.knobs.holdsWaits = false;
      await watcher.releaseWaits();
    }
    for (const w of await wakes()) if (w.state === 'queued') await done(w.id);
  });

  it('leaves a thread to the passes when T3 Code answers the wait at once', async () => {
    const threadId = await launch('Tidy the imports');
    const watcher = new T3Watcher(t.services, { holdMs: 1500 }).holdWaits();
    await watcher.pass();
    // The stand-in answers at once, as a T3 Code that can't hold the call: asked once, not in a loop.
    await watcher.releaseWaits();
    const asked = t3.calls.filter(
      (c) => c.name === 't3_thread_wait' && c.args.threadId === threadId && c.args.timeoutMs === 1500,
    );
    expect(asked).toHaveLength(1);
    t3.finish(threadId, 'Done.');
    await pass();
    for (const w of await wakes()) if (w.state === 'queued') await done(w.id);
  });
});

describe('turns that wait for their thread themselves', () => {
  it('an automation’s step wakes nobody, and its completed threads are settled', async () => {
    // Cut short or not: Whombat reports the step's own end.
    for (const end of ['done', 'cancelled'] as const) {
      const before = (await wakes()).length;
      const step = await turn({ trigger: 'automation' });
      const res = await step.call('t3_thread_launch', { projectId: 'mcp:project-1', title: 'A step' });
      const threadId = JSON.parse(res.content).threadId as string;
      expect(await watchOf(threadId)).toMatchObject({ state: 'watching', wakes: false });
      // What it asks is the step's to answer, or waits in T3 Code.
      t3.ask(threadId, `request-${threadId}`, 'Which branch?', ['main', 'dev']);
      await pass();
      t3.finish(threadId, 'Tested and fixed.');
      // Not while the step is at work; once it is over the completed thread is settled.
      await pass();
      expect(t3.threads.get(threadId)?.settled).toBe(false);
      await step.end(end);
      await pass();
      expect(await wakes()).toHaveLength(before);
      expect((await watchOf(threadId))?.state).toBe('idle');
      await quietPass();
      expect(t3.threads.get(threadId)?.settled).toBe(true);
    }
  });

  it('the job keeps moving, every step counted, while the step waits for it; it is told nothing', async () => {
    const before = (await wakes()).length;
    const step = await turn({ trigger: 'automation' });
    const res = await step.call('t3_thread_launch', {
      projectId: 'mcp:project-1',
      title: 'Fix the upload',
      message: 'Fix it.',
      workspaceStrategy: { type: 'worktree', baseRef: 'main', branch: 'tracker/fix-22' },
    });
    const threadId = JSON.parse(res.content).threadId as string;
    t3.step(threadId, { type: 'command_execution', text: '$ rg upload apps' });
    await pass();
    expect(await handoffsOf(threadId)).toMatchObject({ state: 'working', stage: 'reading' });
    // More happens between two reads than its latest few items: a test written from the shell, a long think, the
    // tests. Each counts.
    t3.step(threadId, {
      type: 'command_execution',
      text: "$ cat > apps/web/src/upload.test.ts <<'EOF'\nit('uploads', () => {});",
    });
    for (let n = 0; n < 6; n++) t3.step(threadId, { type: 'reasoning', text: 'Thinking' });
    t3.step(threadId, { type: 'command_execution', text: '$ pnpm --filter web test' });
    await pass();
    const job = await handoffsOf(threadId);
    expect(job?.stage).toBe('tests');
    expect(job?.stages.map((s: Json) => s.stage)).toEqual(['reading', 'editing', 'tests']);
    expect(job?.steps.map((s: Json) => s.text)).toContain('Changing upload.test.ts');
    expect(progressOf((await watchOf(threadId))?.progress).branch).toBe('tracker/fix-22');

    // Its end shows at once; the step waiting for it is told nothing and the thread isn't settled under it.
    t3.finish(threadId, 'Fixed and tested.');
    await pass();
    expect(await handoffsOf(threadId)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(t3.threads.get(threadId)?.settled).toBe(false);
    expect((await watchOf(threadId))?.state).toBe('watching');
    await step.end();
    await pass();
    expect(await wakes()).toHaveLength(before);
    expect((await watchOf(threadId))?.state).toBe('idle');
    await quietPass();
    expect(t3.threads.get(threadId)?.settled).toBe(true);
  });

  it('a failed thread of a step stays in T3 Code’s list', async () => {
    const before = (await wakes()).length;
    const step = await turn({ trigger: 'automation' });
    const res = await step.call('t3_thread_launch', { projectId: 'mcp:project-1', title: 'A failing step' });
    const threadId = JSON.parse(res.content).threadId as string;
    t3.finish(threadId, 'The tests failed.', 'failed');
    await step.end();
    await pass();
    expect(await wakes()).toHaveLength(before);
    expect((await watchOf(threadId))?.state).toBe('idle');
    await quietPass();
    expect(t3.threads.get(threadId)?.settled).toBe(false);
  });
});

describe('the thread shows what T3 Code does with the work (T3-24, T3-25)', () => {
  it('shows it at work at once, then its steps, a permission it waits for and its end, each as a frame', async () => {
    const frames: Json[] = [];
    const off = t.services.bus.onFrame((f) => {
      if (f.event.type === 'conversation.handoffs' && f.topic === `conv:${IDS.dmDusty}`) frames.push(f.event);
    });
    const sent = (threadId: string) =>
      (frames.at(-1)?.handoffs as Json[] | undefined)?.find((h) => h.id === threadId);
    try {
      const threadId = await launch('Show the work');
      // Before the watcher read it: at work, from the thread it was handed over in.
      expect(await handoffsOf(threadId)).toMatchObject({
        to: 't3code',
        state: 'working',
        rootId: ROOT,
        agentId: IDS.dusty,
        title: 'Dusty - Show the work',
      });
      expect(sent(threadId)?.state).toBe('working');

      t3.step(threadId, { type: 'command_execution', text: '$ pnpm --filter web test\nrunning' });
      await pass();
      const working = await handoffsOf(threadId);
      expect(working).toMatchObject({ state: 'working', program: 'Codex · gpt-5.5' });
      expect(working?.steps.at(-1)).toMatchObject({ text: 'Running the tests', done: false });
      expect(working?.url).toContain(encodeURIComponent(threadId));
      expect(sent(threadId)?.steps).toEqual(working?.steps);

      t3.askPermission(threadId, 'hello.txt');
      await pass();
      expect(await handoffsOf(threadId)).toMatchObject({ state: 'needs_ok', asks: 'hello.txt' });
      // Dusty was woken to say so; its turn is over.
      for (const w of await wakes()) await done(w.id);

      t3.finish(threadId, 'Done.');
      await pass();
      expect(await handoffsOf(threadId)).toMatchObject({ state: 'ended', outcome: 'completed' });
      expect(sent(threadId)).toMatchObject({ state: 'ended', outcome: 'completed' });
      for (const w of await wakes()) await done(w.id);
    } finally {
      off();
    }
  });
});

describe('a follow-up goes to the thread that did the work', () => {
  it('starts a settled thread again, and the job shows each run’s whole answer once it ended', async () => {
    const threadId = await launch('Look at the export');
    const looked = 'The export drops its last row.\n\n**Where**\n\n- `export.ts` stops one row early.';
    t3.finish(threadId, looked);
    await pass();
    for (const w of await wakes()) await done(w.id);
    expect(await settleAs(threadId)).toMatchObject({ status: 'ok', isError: false });
    // Told and settled, with its whole answer to read in the thread, not only its first sentence.
    expect(t3.threads.get(threadId)?.settled).toBe(true);
    const first = await handoffsOf(threadId);
    expect(first).toMatchObject({ state: 'ended', answer: looked });
    expect(first?.receipt?.summary).toBe('The export drops its last row.');

    // “Now fix it”: the same thread, which T3 Code makes active again by itself.
    const a = await turn();
    const sent = await a.call('t3_thread_send', { threadId, message: 'Now fix it: you may change things.' });
    expect(sent).toMatchObject({ status: 'ok', isError: false });
    await a.end();
    expect(t3.threads.get(threadId)?.settled).toBe(false);
    expect((await watchOf(threadId))?.state).toBe('watching');
    // While the new run works the last run's answer isn't shown as this one's.
    await pass();
    expect(await handoffsOf(threadId)).toMatchObject({ state: 'working', answer: null });

    t3.finish(threadId, 'Fixed: the export keeps its last row.\n\nA test covers it.');
    await pass();
    const second = await handoffsOf(threadId);
    expect(second?.state).toBe('ended');
    expect(second?.answer).toContain('A test covers it.');
    expect(second?.answer).not.toContain('stops one row early');
    for (const w of await wakes()) await done(w.id);
  });
});

describe('the person’s own words reach T3 Code', () => {
  /** What Mara wrote in the thread (the seeded message the turn answers). */
  const ASKED = 'what did we decide about invoice numbering last year?';
  const sentTo = (name: string) => t3.calls.filter((c) => c.name === name).map((c) => String(c.args.message));

  it('adds what she wrote to the brief of a turn her message started, once per thread', async () => {
    const a = await turn({ messageId: ROOT });
    const res = await a.call('t3_thread_launch', {
      projectId: 'mcp:project-1',
      title: 'Invoice numbering',
      message: 'Look up how invoices are numbered in the billing code.',
    });
    const threadId = JSON.parse(res.content).threadId as string;
    const brief = sentTo('t3_thread_launch').at(-1) as string;
    expect(brief.startsWith('Look up how invoices are numbered in the billing code.')).toBe(true);
    expect(brief).toContain(PERSON_WORDS_MARK);
    expect(brief).toContain(ASKED);
    // Her words come before how to work, and a second message of the same turn doesn't repeat them.
    expect(brief.indexOf(ASKED)).toBeLessThan(brief.indexOf('You may start subagents.'));
    await a.call('t3_thread_send', { threadId, message: 'Also check the credit notes.' });
    expect(sentTo('t3_thread_send').at(-1)).toBe('Also check the credit notes.');
    await a.end();
    // A later turn of hers that continues the thread carries what she wrote then.
    const b = await turn({ messageId: ROOT });
    await b.call('t3_thread_send', { threadId, message: 'Now fix it.' });
    expect(sentTo('t3_thread_send').at(-1)).toContain(ASKED);
    await b.end();
    for (const w of await wakes()) await done(w.id);
  });

  it('tells a later turn in the thread which T3 Code threads it handed work to, newest first', async () => {
    const [row] = await db()
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.messageId, ROOT)))
      .limit(1);
    if (!row) throw new Error('no turn of hers');
    const context = await buildDispatchContext(t.services, { ...row, state: 'running' });
    const listed = context.t3Handoffs ?? [];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThanOrEqual(T3_HANDOFFS_MAX);
    // The thread she last had continued comes first, by its id, on the connection's handle.
    expect(listed[0]).toMatchObject({ connection: 't3', title: 'Dusty - Invoice numbering' });
    expect(t3.threads.has(listed[0]?.threadId as string)).toBe(true);
    // Her own message started the turn: its brief gets her words, and the turn is told so.
    expect(context.t3PersonWords).toBe(true);
    // Another thread of the chat has none of them.
    const elsewhere = await buildDispatchContext(t.services, {
      ...row,
      state: 'running',
      threadRootId: 'msg_dm-dusty-1402',
    });
    expect(elsewhere.t3Handoffs ?? null).toBeNull();
  });

  it('adds nothing in a turn no message of hers started', async () => {
    const step = await turn({ trigger: 'automation', messageId: ROOT });
    await step.call('t3_thread_launch', { projectId: 'mcp:project-1', title: 'A step', message: 'Do it.' });
    const wake = await turn();
    await wake.call('t3_thread_launch', {
      projectId: 'mcp:project-1',
      title: 'No message',
      message: 'Do it.',
    });
    for (const brief of sentTo('t3_thread_launch').slice(-2)) expect(brief).not.toContain(PERSON_WORDS_MARK);
    await step.end();
    await wake.end();
  });
});
