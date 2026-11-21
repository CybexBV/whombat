/**
 * Settling threads (docs/decisions/chat-settle.md): the person settles a finished thread of their Chat and opens it
 * again, a new message opens it by itself, the Threads list pages open and settled threads, and the automatic round
 * settles quiet and merged threads, and a customer's report once its fixes are live — never one the agent works on or one
 * that waits for the person. Needs Postgres: what a thread is doing is read from its turns, approvals, questions, runs,
 * pull requests and report fixes.
 */
import { newId } from '@whombat/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { updatePreferences } from '../commands/account';
import { requestApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { defineCommand } from '../commit/types';
import {
  automationRuns,
  automations,
  dispatches,
  events,
  messages,
  outbox,
  principals,
  pullRequests,
  runs,
  trackerFixes,
} from '../db/schema/index';
import { type Step, suggestionStep } from '../guides/flows';
import { runInDispatchScope } from '../runtime/dispatch-scope';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';
import {
  CHAT_THREAD_OPENED_EVENT,
  CHAT_THREAD_SETTLED_EVENT,
  CHAT_THREADS_SETTLED_EVENT,
  settleResolvedThreads,
  settleRound,
  settleThread,
} from './settle';

const t = useTestServer({ seed: true, app: true });
let mine: PersonalSetup;
let cookie: string;
let accountId: string;
const DAY = 24 * 60 * 60_000;

/** A guide card that states a setting rather than asks (`standing`), as older cards in a Chat do. */
const standing =
  (step: Step): Step =>
  (f, id) => {
    const post = step(f, id);
    return { ...post, card: post.card && { ...post.card, standing: true } };
  };

beforeAll(async () => {
  // No keys: asking for one is an approval whose card lands in the thread it was asked in.
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    name: 'Dusty',
    services: null,
    grants: [],
  });
  ({ cookie } = await sessionFor(t.services, IDS.mara));
  const [person] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  accountId = person?.accountId ?? '';
});

/** Each case starts with every turn ended and the threads of earlier cases settled, so the round sees only its own. */
beforeEach(async () => {
  await finishTurns();
  await t.services.db
    .update(messages)
    .set({ settledAt: new Date(), settledHow: 'person', keptOpenAt: null })
    .where(
      and(
        eq(messages.conversationId, mine.dmId),
        sql`${messages.threadRootId} is null and ${messages.settledAt} is null`,
      ),
    );
});

async function finishTurns() {
  await t.services.db
    .update(dispatches)
    .set({ state: 'done', finishedAt: new Date() })
    .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
}

async function send(authorId: string, text: string, extra: Record<string, unknown> = {}) {
  const res = await t.commit(authorId, sendMessage, { conversationId: mine.dmId, text, ...extra });
  if (res.status !== 'ok') throw new Error(`send: ${res.status}`);
  return res.result.id as string;
}

async function settle(rootId: string, settled: boolean) {
  return t.api.inject({
    method: 'PUT',
    url: `/api/v1/burrows/burrow-hq/chats/threads/${rootId}/settled`,
    headers: { cookie },
    payload: { settled },
  });
}

/** Posts a guide card as Mara's assistant, a thread of its own in her Chat. */
async function postCard(step: Step) {
  const [id] = await t.services.guides.postTo(t.burrowId, IDS.mara, async () => [step], { notify: false });
  if (!id) throw new Error('no guide card');
  return id;
}

/** Mara reads a thread up to a message: a thread with something new doesn't settle by itself (chat-inbox.md CIB-08). */
async function readUpTo(rootId: string, messageId: string) {
  const res = await t.api.inject({
    method: 'POST',
    url: `/api/v1/burrows/burrow-hq/chats/threads/${rootId}/read`,
    headers: { cookie },
    payload: { messageId },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function threads(query = '') {
  const res = await t.api.inject({
    method: 'GET',
    url: `/api/v1/burrows/burrow-hq/chats/threads${query}`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    threads: { rootId: string; settled?: { at: string; how: string } | null; waiting?: boolean }[];
    next: string | null;
    settledCount?: number;
  };
}

async function root(id: string) {
  const [row] = await t.services.db.select().from(messages).where(eq(messages.id, id));
  return row;
}

async function lastEvent(type: string) {
  const [event] = await t.services.db
    .select({ type: events.type, payload: events.payload, text: events.text })
    .from(events)
    .where(eq(events.type, type))
    .orderBy(desc(events.seq))
    .limit(1);
  return event;
}

async function lastFrame() {
  const [frame] = await t.services.db
    .select({ topic: outbox.topic, event: outbox.event })
    .from(outbox)
    .where(sql`${outbox.event}->>'type' = 'chat.settled'`)
    .orderBy(desc(outbox.id))
    .limit(1);
  return frame;
}

describe('settling a thread by hand', () => {
  it('settles a finished thread, shelves it, and a new message in it opens it again', async () => {
    const first = await send(IDS.mara, 'Is pve-02 hot?');
    await send(mine.agentId, 'A bit warm, 71 °C.', { threadRootId: first });

    // Its turn is still queued: not while Dusty works on it.
    const busy = await settle(first, true);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.message).toContain('Dusty');
    await finishTurns();

    const res = await settle(first, true);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().thread).toMatchObject({ rootId: first, settled: { how: 'person' }, waiting: false });
    expect(await lastEvent(CHAT_THREAD_SETTLED_EVENT)).toMatchObject({
      payload: { conversationId: mine.dmId, rootId: first, how: 'person' },
    });
    expect(await lastFrame()).toMatchObject({
      topic: `me:${IDS.mara}`,
      event: { conversationId: mine.dmId, room: 'chat', rootId: first, settled: { how: 'person' } },
    });

    // The room's timeline folds it; Threads lists it on the shelf, with the count on a first page.
    const timeline = await t.api.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/conversations/${mine.dmId}/messages`,
      headers: { cookie },
    });
    const shown = timeline.json().messages.find((m: { id: string }) => m.id === first);
    expect(shown.settled).toMatchObject({ how: 'person' });
    expect((await threads('?state=open')).threads.map((th) => th.rootId)).not.toContain(first);
    const shelf = await threads('?state=settled&limit=50');
    expect(shelf.threads[0]?.rootId).toBe(first);
    expect(shelf.settledCount).toBe(shelf.threads.length);
    expect(shelf.settledCount).toBeGreaterThan(0);

    // The agent's next word in it opens it again, in the same commit.
    await send(mine.agentId, 'It cooled down.', { threadRootId: first });
    expect(await root(first)).toMatchObject({ settledAt: null, settledHow: null, keptOpenAt: null });
    expect(await lastEvent(CHAT_THREAD_OPENED_EVENT)).toMatchObject({
      payload: { conversationId: mine.dmId, rootId: first, by: 'message' },
    });
    expect(await lastFrame()).toMatchObject({ event: { rootId: first, settled: null } });
    expect((await threads('?state=open')).threads.map((th) => th.rootId)).toContain(first);
  });

  it('pages the shelf by when threads settled', async () => {
    const ids = [await send(IDS.mara, 'One'), await send(IDS.mara, 'Two'), await send(IDS.mara, 'Three')];
    await finishTurns();
    for (const id of ids) expect((await settle(id, true)).statusCode).toBe(200);
    const page = await threads('?state=settled&limit=2');
    expect(page.threads.map((th) => th.rootId)).toEqual([ids[2], ids[1]]);
    expect(page.next).toBe(page.threads[1]?.settled?.at);
    const more = await threads(`?state=settled&limit=2&before=${encodeURIComponent(page.next ?? '')}`);
    expect(more.threads[0]?.rootId).toBe(ids[0]);
    expect(more.settledCount).toBeUndefined();
  });

  it('opens it again by hand and keeps it open from the round until its next message', async () => {
    const first = await send(IDS.mara, 'Back up the NAS?');
    await finishTurns();
    expect((await settle(first, true)).statusCode).toBe(200);
    const opened = await settle(first, false);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().thread.settled).toBeNull();
    expect((await root(first))?.keptOpenAt).not.toBeNull();
    expect(await lastEvent(CHAT_THREAD_OPENED_EVENT)).toMatchObject({
      payload: { rootId: first, by: 'person' },
    });

    const later = new Date(Date.now() + 10 * DAY);
    await settleRound(t.services, later);
    expect((await root(first))?.settledAt).toBeNull();

    // A new message clears the mark: then quiet days settle it, at its last message's time.
    const reply = await send(IDS.mara, 'Never mind.', { threadRootId: first });
    await finishTurns();
    await settleRound(t.services, later);
    const [last] = await t.services.db.select().from(messages).where(eq(messages.id, reply));
    expect(await root(first)).toMatchObject({ settledHow: 'quiet', settledAt: last?.createdAt });
  });

  it('is the person’s: the agent can’t settle, and a thread of someone else’s room isn’t found', async () => {
    const first = await send(IDS.mara, 'Anything new?');
    await finishTurns();
    await expect(
      t.commit(mine.agentId, settleThread, { rootId: first, settled: true }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await settle('msg_general-tom-0831', true)).statusCode).toBe(404);
  });
});

describe('a thread that waits for the person', () => {
  it('waits while its question is unanswered and settles once answered', async () => {
    const first = await send(IDS.mara, 'Clean up the disks?');
    await finishTurns();
    await send(mine.agentId, 'Which disk, the big one or the small one?', {
      threadRootId: first,
      asks: true,
    });
    expect((await threads('?state=open')).threads.find((th) => th.rootId === first)?.waiting).toBe(true);
    const refused = await settle(first, true);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/your answer/);
    await settleRound(t.services, new Date(Date.now() + 10 * DAY));
    expect((await root(first))?.settledAt).toBeNull();

    await send(IDS.mara, 'The big one.', { threadRootId: first });
    await finishTurns();
    expect((await threads('?state=open')).threads.find((th) => th.rootId === first)?.waiting).toBe(false);
    expect((await settle(first, true)).statusCode).toBe(200);
  });

  it('waits while a key it asked for in the thread is pending', async () => {
    const first = await send(IDS.mara, 'Look up the docs?');
    const [turn] = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, first));
    if (!turn) throw new Error('no turn');
    const asked = await runInDispatchScope(
      { dispatchId: turn.id, agentId: mine.agentId, onBehalfOfAccountId: turn.onBehalfOfAccountId },
      () =>
        t.commit(mine.agentId, requestApproval, {
          conversationId: mine.dmId,
          action: { type: 'grant_key', params: { keyId: 'web.browse' } },
          title: 'Browse the web',
          question: 'May I look it up?',
          whatHappens: ['Dusty may browse the web.'],
          explainer: 'To read the docs.',
          summary: 'Browse the web',
        }),
    );
    expect(asked.status).toBe('ok');
    await finishTurns();
    expect((await settle(first, true)).statusCode).toBe(409);
    expect((await threads('?state=open')).threads.find((th) => th.rootId === first)?.waiting).toBe(true);
  });

  it('waits while a guide card asks something, but not for a standing card that states a setting', async () => {
    const asking = await postCard(suggestionStep('email'));
    const stands = await postCard(standing(suggestionStep('files')));
    expect((await root(asking))?.card).toMatchObject({ kind: 'guide', state: 'open' });
    expect((await root(stands))?.card).toMatchObject({ kind: 'guide', state: 'open', standing: true });

    const open = (await threads('?state=open')).threads;
    expect(open.find((th) => th.rootId === asking)?.waiting).toBe(true);
    expect(open.find((th) => th.rootId === stands)?.waiting).toBe(false);

    expect((await settle(asking, true)).statusCode).toBe(409);
    expect((await settle(stands, true)).statusCode).toBe(200);
    expect((await root(stands))?.settledHow).toBe('person');
  });
});

describe('settling by themselves', () => {
  it('settles quiet threads after the person’s days, and none when they turned it off', async () => {
    const first = await send(IDS.mara, 'What’s the weather?');
    await finishTurns();
    expect(await settleRound(t.services, new Date(Date.now() + 2 * DAY))).toBe(0);

    const prefs = await updatePreferences(t.services, accountId, {
      chat: { settleQuietDays: null, settleMerged: true },
    });
    expect(prefs.chat).toEqual({ settleQuietDays: null, settleMerged: true });
    expect(await settleRound(t.services, new Date(Date.now() + 30 * DAY))).toBe(0);

    await updatePreferences(t.services, accountId, {
      chat: { settleQuietDays: 3, settleMerged: true },
    });
    expect(await settleRound(t.services, new Date(Date.now() + 4 * DAY))).toBe(1);
    expect((await root(first))?.settledHow).toBe('quiet');
    expect(await lastEvent(CHAT_THREADS_SETTLED_EVENT)).toMatchObject({
      text: null,
      payload: { conversationId: mine.dmId, room: 'chat', count: 1, how: 'quiet' },
    });
    expect(await lastFrame()).toMatchObject({ event: { rootId: null, settled: { how: 'quiet' } } });
  });

  it('settles a thread when its run’s pull request merged after the person’s last word, never while it works', async () => {
    const first = await send(IDS.mara, 'Fix the invoice PDF?');
    const card = await send(mine.agentId, 'On it.', { threadRootId: first });
    await t.services.db.insert(runs).values({
      id: 'run_settle-1',
      burrowId: t.burrowId,
      number: 9101,
      agentId: mine.agentId,
      title: 'Fix the invoice PDF',
      branch: 'feat/invoice-pdf',
      repoId: 'rep_billing',
      prNumber: 482,
      status: 'done',
      askedById: IDS.mara,
      conversationId: mine.dmId,
      messageId: card,
      startedAt: new Date(),
    });
    const mergedAt = new Date(Date.now() + 60_000);
    await t.services.db
      .update(pullRequests)
      .set({ state: 'merged', mergedAt })
      .where(eq(pullRequests.id, 'pr_482'));
    // Its turn is still queued: the round leaves it.
    expect(await settleRound(t.services, new Date(Date.now() + 2 * 60_000))).toBe(0);
    await finishTurns();
    // The agent's “On it.” is new to Mara: it waits until she has read it.
    expect(await settleRound(t.services, new Date(Date.now() + 2 * 60_000))).toBe(0);
    await readUpTo(first, card);
    expect(await settleRound(t.services, new Date(Date.now() + 2 * 60_000))).toBe(1);
    expect(await root(first)).toMatchObject({ settledHow: 'merged', settledAt: mergedAt });
    expect((await threads('?state=settled')).threads[0]).toMatchObject({
      rootId: first,
      settled: { how: 'merged' },
    });
  });
});

/** A run of a report automation whose thread is `rootId`, in `status`: its id. */
async function reportRun(rootId: string, status: 'running' | 'succeeded') {
  const automationId = newId('automation');
  const now = new Date();
  await t.services.db.insert(automations).values({
    id: automationId,
    burrowId: t.burrowId,
    name: 'Assess and fix reports',
    principalId: mine.agentId,
    createdById: IDS.mara,
    createdAt: now,
    updatedAt: now,
  });
  const [{ n } = { n: 0 }] = await t.services.db
    .select({ n: sql<number>`coalesce(max(${automationRuns.number}), 0)::int` })
    .from(automationRuns)
    .where(eq(automationRuns.burrowId, t.burrowId));
  const id = newId('automationRun');
  await t.services.db.insert(automationRuns).values({
    id,
    burrowId: t.burrowId,
    number: n + 1,
    automationId,
    version: 1,
    definition: { steps: [] } as never,
    publishedById: IDS.mara,
    status,
    trigger: {
      kind: 'schedule',
      summary: 'Every day',
      actorId: null,
      eventId: null,
      messageId: null,
      scheduledFor: null,
    },
    triggerKey: `report:${id}`,
    conversationId: mine.dmId,
    threadRootId: rootId,
    createdAt: now,
    deadlineAt: now,
    updatedAt: now,
  });
  return id;
}

describe('a customer’s report settling by itself', () => {
  it('settles once every fix of the report is live where the customer is and none of its runs goes on', async () => {
    const first = await send(IDS.mara, 'Assess it: #31 “Invoices are empty”');
    const reply = await send(mine.agentId, 'It’s a bug, and T3 Code is fixing it.', { threadRootId: first });
    await finishTurns();
    await readUpTo(first, reply);
    const runId = await reportRun(first, 'succeeded');
    const now = Date.now();
    const fix = (id: string, prNumber: number, state: 'live' | 'development', productionAt: Date | null) => ({
      id,
      burrowId: t.burrowId,
      connectionId: 'con_settle-tracker',
      reportId: 'report-31',
      number: 31,
      runId,
      repo: 'acme/billing',
      prNumber,
      kind: 'bug',
      state,
      productionAt,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await t.services.db
      .insert(trackerFixes)
      .values([
        fix('tfx_settle-1', 501, 'live', new Date(now + 60_000)),
        fix('tfx_settle-2', 502, 'development', null),
      ]);
    // One fix is live, the other only on development: the report isn't done.
    expect(await settleRound(t.services, new Date(now + 2 * 60_000))).toBe(0);
    const liveAt = new Date(now + 5 * 60_000);
    await t.services.db
      .update(trackerFixes)
      .set({ state: 'live', productionAt: liveAt })
      .where(eq(trackerFixes.id, 'tfx_settle-2'));
    // The customer wrote back and a run of the report goes on: not yet.
    const again = await reportRun(first, 'running');
    expect(await settleRound(t.services, new Date(now + 10 * 60_000))).toBe(0);
    await t.services.db
      .update(automationRuns)
      .set({ status: 'succeeded' })
      .where(eq(automationRuns.id, again));
    expect(await settleRound(t.services, new Date(now + 10 * 60_000))).toBe(1);
    expect(await root(first)).toMatchObject({ settledHow: 'merged', settledAt: liveAt });
  });
});

describe('settling finished threads', () => {
  it('pages through threads settled together', async () => {
    const ids = [await send(IDS.mara, 'Uno'), await send(IDS.mara, 'Dos'), await send(IDS.mara, 'Tres')];
    await finishTurns();
    const res = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/chats/settle',
      headers: { cookie },
      payload: {},
    });
    expect(res.json().settled).toBe(3);
    // Two at a time through the whole shelf: each once, the latest activity first, as they were in Threads.
    const seen: string[] = [];
    let page = await threads('?state=settled&limit=2');
    for (;;) {
      seen.push(...page.threads.map((th) => th.rootId));
      if (!page.next) break;
      page = await threads(`?state=settled&limit=2&before=${encodeURIComponent(page.next)}`);
    }
    expect(seen.filter((id) => ids.includes(id))).toEqual([ids[2], ids[1], ids[0]]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('pages through threads the assistant settled together once their problems went away', async () => {
    const ids = [await send(IDS.mara, 'One'), await send(IDS.mara, 'Two'), await send(IDS.mara, 'Three')];
    await finishTurns();
    const settleResolved = defineCommand({
      name: 'test_settle_resolved',
      schema: z.object({ rootIds: z.array(z.string()) }),
      apply: (_tx, ctx, input) => settleResolvedThreads(ctx, mine.dmId, input.rootIds),
    });
    const res = await t.commit(mine.agentId, settleResolved, { rootIds: ids });
    expect(res.status === 'ok' && res.result).toBe(3);
    const seen: string[] = [];
    let page = await threads('?state=settled&limit=2');
    for (;;) {
      seen.push(...page.threads.map((th) => th.rootId));
      if (!page.next) break;
      page = await threads(`?state=settled&limit=2&before=${encodeURIComponent(page.next)}`);
    }
    expect(seen.filter((id) => ids.includes(id))).toEqual([ids[2], ids[1], ids[0]]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('settles every open thread that may settle, leaving working, waiting and pinned ones', async () => {
    const done = await send(IDS.mara, 'Done one');
    const pinned = await send(IDS.mara, 'Pinned one');
    await finishTurns();
    await t.services.db
      .update(messages)
      .set({ pinnedAt: new Date(), pinnedById: IDS.mara })
      .where(eq(messages.id, pinned));
    const asking = await send(IDS.mara, 'Asking one');
    await finishTurns();
    await send(mine.agentId, 'Which one?', { threadRootId: asking, asks: true });
    const working = await send(IDS.mara, 'Working one');

    const res = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/chats/settle',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ room: 'chat', conversationId: mine.dmId, settled: 1 });
    expect((await root(done))?.settledHow).toBe('person');
    for (const id of [pinned, asking, working]) expect((await root(id))?.settledAt).toBeNull();
    expect(await lastEvent(CHAT_THREADS_SETTLED_EVENT)).toMatchObject({
      payload: { count: 1, how: 'person' },
    });
    expect(await lastFrame()).toMatchObject({ event: { rootId: null, settled: { how: 'person' } } });

    const again = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/chats/settle',
      headers: { cookie },
      payload: { room: 'chat' },
    });
    expect(again.json().settled).toBe(0);
  });

  it('settles a thread under a standing guide card, by the round and all together, never one that asks', async () => {
    const byRound = await postCard(standing(suggestionStep('files')));
    const asking = await postCard(suggestionStep('calendar'));
    // Unread, the card's thread stays; once Mara read it, the round settles it.
    await settleRound(t.services, new Date(Date.now() + 10 * DAY));
    expect((await root(byRound))?.settledAt).toBeNull();
    await readUpTo(byRound, byRound);
    await readUpTo(asking, asking);
    await settleRound(t.services, new Date(Date.now() + 10 * DAY));
    expect((await root(byRound))?.settledHow).toBe('quiet');
    expect((await root(asking))?.settledAt).toBeNull();

    const together = await postCard(standing(suggestionStep('email')));
    const res = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/chats/settle',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await root(together))?.settledHow).toBe('person');
    expect((await root(asking))?.settledAt).toBeNull();
  });
});
