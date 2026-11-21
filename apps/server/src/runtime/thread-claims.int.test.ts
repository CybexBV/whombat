/**
 * One turn in flight per (agent, conversation, thread) (docs/decisions/hermes-native.md HN-T01…HN-T05): two threads of a
 * person's Chat are claimed at once; one thread still runs one turn at a time; a turn at a conversation's top level runs
 * alone there (a flat room's turns, a scheduled turn in Chat) and goes before later threads; two turns of one run never run at
 * once; a stopped turn holds only its own thread; requests coalesce only within their thread; and a new thread starts
 * fresh, without the others (chat-channel.md). Needs Postgres: the claim's rule
 * is one SQL query under the claim lock, and the turns' contexts are read from the stored messages.
 */
import { type DispatchContext, runnerApi } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { accountOf } from '../test/tokens';
import { cancelDispatch } from './stop';

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_threads';
/** Mara's Chat with Dusty: each of her top-level messages there opens a thread (chat-channel.md CHT-02). */
let chat = '';

beforeAll(async () => {
  chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
});

async function post(url: string, payload: unknown) {
  return t.api.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });
}

async function claim(): Promise<DispatchContext | null> {
  const res = await post('/internal/runner/claim', { runnerId: RUNNER, providers: ['claude'], waitMs: 0 });
  expect(res.statusCode).toBe(200);
  return runnerApi.claim.response.parse(res.json()).dispatch;
}

async function claimed(): Promise<DispatchContext> {
  const ctx = await claim();
  if (!ctx) throw new Error('nothing was claimed');
  return ctx;
}

async function beat(ctx: DispatchContext) {
  const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/progress`, {
    state: 'running',
    runnerId: RUNNER,
    attempt: ctx.dispatch.attempts,
  });
  expect(res.statusCode).toBe(200);
}

async function complete(ctx: DispatchContext, outcome: 'done' | 'cancelled' = 'done') {
  const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/complete`, {
    runnerId: RUNNER,
    attempt: ctx.dispatch.attempts,
    outcome,
  });
  expect(res.statusCode).toBe(200);
  // What Whombat does after a turn runs off the request (`afterRunTurn`): done before the next step reads the rows.
  await t.services.runtime.recovery;
}

async function say(
  actorId: string,
  text: string,
  where: { conversationId?: string; threadRootId?: string } = {},
): Promise<string> {
  const res = await t.commit(actorId, sendMessage, { conversationId: chat, text, ...where });
  if (res.status !== 'ok') throw new Error('send failed');
  return res.result.id;
}

async function drain() {
  await t.services.db
    .update(dispatches)
    .set({ state: 'done', leaseExpiresAt: null })
    .where(eq(dispatches.burrowId, t.burrowId));
}

/** Dusty's queued turns in a conversation. */
async function queuedIn(conversationId: string) {
  return t.services.db
    .select()
    .from(dispatches)
    .where(
      and(
        eq(dispatches.agentId, IDS.dusty),
        eq(dispatches.conversationId, conversationId),
        eq(dispatches.state, 'queued'),
      ),
    );
}

describe('turns per thread (HN-T01)', () => {
  it('claims two threads of one Chat for the same person at once', async () => {
    await drain();
    const first = await say(IDS.mara, '@Dusty can you look at the PDF cache?');
    const second = await say(IDS.mara, '@Dusty and what about the invoices?');
    const a = await claimed();
    const b = await claimed();
    expect([a.dispatch.threadRootId, b.dispatch.threadRootId].sort()).toEqual([first, second].sort());
    const mara = await accountOf(t.services, IDS.mara);
    for (const turn of [a, b]) {
      const [stored] = await t.services.db
        .select()
        .from(dispatches)
        .where(eq(dispatches.id, turn.dispatch.id));
      expect(stored).toMatchObject({ conversationId: chat, onBehalfOfAccountId: mara, state: 'claimed' });
    }
    await beat(a);
    await beat(b);
    // Each thread has its own session key, so neither resumes the other's Hermes session.
    expect(a.session?.key).not.toBe(b.session?.key);
    expect(await claim()).toBeNull();
    await complete(a);
    await complete(b);
  });

  it('still runs one turn at a time in a thread, and a reply joins only its own thread’s queued turn', async () => {
    await drain();
    const first = await say(IDS.mara, '@Dusty can you check the totals?');
    const second = await say(IDS.mara, '@Dusty and the VAT lines?');
    const a = await claimed();
    const b = await claimed();
    const [inFirst, inSecond] = a.dispatch.threadRootId === first ? [a, b] : [b, a];
    // A reply in each thread while both run: one queued follow-up per thread, never one turn for both (HN-T04).
    await say(IDS.mara, 'the totals of October', { threadRootId: first });
    await say(IDS.mara, 'only the Dutch ones', { threadRootId: second });
    const queued = await queuedIn(chat);
    expect(queued.map((d) => d.threadRootId).sort()).toEqual([first, second].sort());
    // Each waits for its own thread's turn.
    expect(await claim()).toBeNull();
    await complete(inFirst);
    const next = await claimed();
    expect(next.dispatch.threadRootId).toBe(first);
    expect(await claim()).toBeNull();
    await complete(inSecond);
    expect((await claimed()).dispatch.threadRootId).toBe(second);
    await drain();
  });

  it('holds only its own thread while a stopped turn’s runner still has it', async () => {
    await drain();
    const first = await say(IDS.mara, '@Dusty can you look at the export?');
    const stopped = await claimed();
    await beat(stopped);
    const res = await t.commit(IDS.mara, cancelDispatch, { dispatchId: stopped.dispatch.id });
    expect(res.status).toBe('ok');
    // Mara replies in the stopped thread first, then asks something new.
    const reply = await say(IDS.mara, 'actually, look at the import', { threadRootId: first });
    const second = await say(IDS.mara, '@Dusty how do refunds round?');
    // The reply waits for the stopped turn's runner to let go (RF-01); the other thread doesn't.
    const other = await claimed();
    expect(other.dispatch.threadRootId).toBe(second);
    expect(await claim()).toBeNull();
    await complete(stopped, 'cancelled');
    const resumed = await claimed();
    expect(resumed.dispatch).toMatchObject({ threadRootId: first, messageId: reply });
    await drain();
  });
});

describe('the top level (HN-T02)', () => {
  it('runs a flat room’s turns one at a time, a thread’s turn there too', async () => {
    await drain();
    await say(IDS.mara, '@Dusty how do credit notes round?', { conversationId: IDS.billing });
    const first = await claimed();
    expect(first.dispatch).toMatchObject({ conversationId: IDS.billing, threadRootId: null });
    await say(IDS.mara, '@Dusty and refunds?', { conversationId: IDS.billing });
    expect(await claim()).toBeNull();
    // A reply in a thread of the flat room waits for the top-level turn as well.
    const root = await say(IDS.mara, 'Invoices for October are out.', { conversationId: IDS.billing });
    expect((await queuedIn(IDS.billing)).length).toBe(1);
    await say(IDS.mara, '@Dusty is the VAT right here?', { conversationId: IDS.billing, threadRootId: root });
    expect(await claim()).toBeNull();
    await complete(first);
    // Oldest first: Mara's top-level question, which runs alone again.
    const second = await claimed();
    expect(second.dispatch).toMatchObject({ threadRootId: null, trigger: 'mention' });
    expect(await claim()).toBeNull();
    await complete(second);
    expect((await claimed()).dispatch.threadRootId).toBe(root);
    await drain();
  });

  it('runs a top-level turn in Chat once its threads are done, before the threads asked after it', async () => {
    await drain();
    await say(IDS.mara, '@Dusty can you look at the PDF cache?');
    const thread = await claimed();
    // A turn Dusty scheduled at the top of Mara's Chat: it waits for the thread in flight…
    const [scheduled] = await enqueueDispatches(t.services, {
      burrowId: t.burrowId,
      causedById: IDS.mara,
      conversationId: chat,
      messageId: null,
      threadRootId: null,
      requests: [{ agentId: IDS.dusty, trigger: 'schedule' }],
      at: new Date(),
    });
    expect(await claim()).toBeNull();
    // …and a thread asked after it waits behind it.
    const later = await say(IDS.mara, '@Dusty and the invoices?');
    expect(await claim()).toBeNull();
    await complete(thread);
    const top = await claimed();
    expect(top.dispatch).toMatchObject({ id: scheduled?.dispatchId, threadRootId: null });
    expect(await claim()).toBeNull();
    await complete(top);
    expect((await claimed()).dispatch.threadRootId).toBe(later);
    await drain();
  });
});

describe('a run’s turns (HN-T03)', () => {
  it('never runs two turns of one run at once, whatever their threads; another thread’s turn runs beside them', async () => {
    await drain();
    const x = await say(IDS.mara, 'About the rounding fix.', { conversationId: IDS.billing });
    const y = await say(IDS.mara, 'About the PDF layout.', { conversationId: IDS.billing });
    const z = await say(IDS.mara, 'About the paper size.', { conversationId: IDS.billing });
    await drain();
    const runTurn = async (threadRootId: string) => {
      const [queued] = await enqueueDispatches(t.services, {
        burrowId: t.burrowId,
        causedById: IDS.mara,
        conversationId: IDS.billing,
        messageId: null,
        threadRootId,
        requests: [{ agentId: IDS.dusty, trigger: 'run_control', mode: 'run' }],
        at: new Date(),
        runId: 'run_1907',
      });
      if (!queued?.created) throw new Error('no new run turn');
      return queued.dispatchId;
    };
    const one = await runTurn(x);
    const two = await runTurn(y);
    const running = await claimed();
    expect(running.dispatch).toMatchObject({ id: one, runId: 'run_1907', threadRootId: x });
    // Mara asks in a third thread: her question runs beside the run's turn, the run's next turn doesn't.
    await say(IDS.mara, '@Dusty does the layout fit A4?', { conversationId: IDS.billing, threadRootId: z });
    const question = await claimed();
    expect(question.dispatch).toMatchObject({ threadRootId: z, mode: 'reply' });
    expect(await claim()).toBeNull();
    await complete(running);
    expect((await claimed()).dispatch).toMatchObject({ id: two, runId: 'run_1907', threadRootId: y });
    await drain();
  });
});

describe('a new thread in Chat', () => {
  it('starts fresh: neither a settled thread nor one still being answered comes along', async () => {
    await drain();
    // A settled thread: asked, answered, ended.
    const settled = await say(IDS.mara, '@Dusty why do credit notes round differently?');
    const s = await claimed();
    const answer = await say(IDS.dusty, 'Credit notes round per line.', { threadRootId: settled });
    await complete(s);
    // A thread being answered: Dusty has said something there, and is still at it.
    const busy = await say(IDS.mara, '@Dusty can you fix the rounding?');
    const b = await claimed();
    const partial = await say(IDS.dusty, 'Looking at the rounding now.', { threadRootId: busy });
    // A new thread beside them sees only itself.
    const fresh = await say(IDS.mara, '@Dusty what is on today?');
    const opening = await claimed();
    expect(opening.thread?.root.id).toBe(fresh);
    expect(opening.window).toEqual([]);
    const shown = (opening.thread?.replies ?? []).map((m) => m.id);
    expect(shown).not.toContain(answer);
    expect(shown).not.toContain(partial);
    await complete(b);
    await complete(opening);
  });
});
