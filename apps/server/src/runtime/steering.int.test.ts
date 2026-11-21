/**
 * Same-person follow-ups into a running turn (docs/decisions/steering.md SX-07…SX-11): the server offers a queued
 * follow-up to the running turn with each beat's answer, merges it once the runner reports it delivered (`cancelled`,
 * `merged:<turn>`, “Answered in the running turn”, `dispatch.updated`), and leaves it to run as its own turn when the
 * runner never reports it (the turn ended first, was stopped or paused). Other people's messages and other threads are
 * never offered, and two threads running at once each take their own (hermes-native.md HN-T05). A message that came
 * after the offer is offered before the merge. In a person's Chat with the agent (one-agent.md OA-04): a top-level
 * message there opens a thread (chat-channel.md CHT-02).
 */
import { type DispatchContext, type DispatchSummary, runnerApi, TURN_MERGED_REASON } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startRun } from '../commands/agent-runs';
import { sendMessage } from '../commands/messages';
import { defineCommand } from '../commit/types';
import { dispatches } from '../db/schema/index';
import { briefAgent } from '../domain/agent-brief';
import { postMessage } from '../domain/messages';
import { loadConversationRow } from '../read/conversations';
import { IDS } from '../seed/test-world';
import { makePng, upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { sessionFor } from '../test/tokens';
import { FollowUps } from './steering';
import { cancelDispatch } from './stop';

type ProgressResponse = z.output<typeof runnerApi.progress.response>;

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_steer';
const frames: DispatchSummary[] = [];
let maraCookie: Record<string, string> = {};
/** Mara's Chat with Dusty. */
let chat = '';

beforeAll(async () => {
  chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
  t.services.bus.onFrame((f) => {
    if (f.event.type === 'dispatch.updated') frames.push(f.event.dispatch);
  });
  maraCookie = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
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

async function beat(ctx: DispatchContext, extra: Record<string, unknown> = {}): Promise<ProgressResponse> {
  const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/progress`, {
    state: 'running',
    runnerId: RUNNER,
    attempt: ctx.dispatch.attempts,
    ...extra,
  });
  expect(res.statusCode).toBe(200);
  return runnerApi.progress.response.parse(res.json());
}

async function complete(ctx: DispatchContext, body: Record<string, unknown> = { outcome: 'done' }) {
  const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/complete`, {
    runnerId: RUNNER,
    attempt: ctx.dispatch.attempts,
    ...body,
  });
  expect(res.statusCode).toBe(200);
}

async function say(
  actorId: string,
  text: string,
  extra: { threadRootId?: string; attachmentIds?: string[]; conversationId?: string } = {},
): Promise<string> {
  const res = await t.commit(actorId, sendMessage, { conversationId: chat, text, ...extra });
  if (res.status !== 'ok') throw new Error('send failed');
  return res.result.id;
}

async function row(id: string) {
  const [r] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!r) throw new Error(`no dispatch ${id}`);
  return r;
}

/** Dusty's queued follow-up turns in Mara's Chat. */
async function queued() {
  return (await t.services.db.select().from(dispatches).where(eq(dispatches.state, 'queued'))).filter(
    (d) => d.agentId === IDS.dusty && d.conversationId === chat,
  );
}

async function drain() {
  for (const r of await t.services.db.select().from(dispatches))
    if (r.state === 'queued' || r.state === 'claimed' || r.state === 'running')
      await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, r.id));
}

/** The thread a turn answers in: a person's top-level message in their Chat opens one (CHT-02). */
function at(turn: DispatchContext): { threadRootId: string } {
  if (!turn.dispatch.threadRootId) throw new Error('the turn has no thread');
  return { threadRootId: turn.dispatch.threadRootId };
}

/** Mara asks Dusty; his turn is claimed and running. */
async function maraAsks(text = '@Dusty why do credit notes round differently?', threadRootId?: string) {
  await drain();
  await say(IDS.mara, text, threadRootId ? { threadRootId } : {});
  const turn = await claimed();
  expect(turn.dispatch).toMatchObject({ agentId: IDS.dusty, mode: 'reply' });
  expect((await beat(turn)).inject).toBeUndefined();
  return turn;
}

describe('a follow-up joins the running turn (SX-07, SX-10, SX-11)', () => {
  it('is offered with every beat, merged once delivered: cancelled, linked, “Answered in the running turn”', async () => {
    const turn = await maraAsks();
    const followUpId = await say(IDS.mara, '@Dusty and refunds too, please', at(turn));
    const [q] = await queued();
    if (!q) throw new Error('no follow-up queued');
    // It waits behind the running turn, as always…
    expect(await claim()).toBeNull();
    // …and is offered to it, with the message as the agent reads it, again on every beat until it is delivered.
    const offered = await beat(turn);
    expect(offered.inject).toEqual([
      {
        dispatchId: q.id,
        messageId: followUpId,
        message: expect.objectContaining({
          id: followUpId,
          authorId: IDS.mara,
          text: '@Dusty and refunds too, please',
        }),
        attachments: [],
      },
    ]);
    expect((await beat(turn)).inject?.map((i) => i.dispatchId)).toEqual([q.id]);

    frames.length = 0;
    const merged = await beat(turn, { injected: [q.id] });
    expect(merged.inject).toBeUndefined();
    expect(await row(q.id)).toMatchObject({ state: 'cancelled', error: `merged:${turn.dispatch.id}` });
    expect(frames).toContainEqual(
      expect.objectContaining({ id: q.id, state: 'cancelled', reason: TURN_MERGED_REASON }),
    );
    // A second report changes nothing; the turn ends and nothing is left to run.
    await beat(turn, { injected: [q.id] });
    await complete(turn);
    expect(await claim()).toBeNull();
  });

  it('a follow-up the runner never reports runs as its own turn once the running one ends', async () => {
    const turn = await maraAsks();
    await say(IDS.mara, '@Dusty also the VAT lines', at(turn));
    const [q] = await queued();
    expect((await beat(turn)).inject?.map((i) => i.dispatchId)).toEqual([q?.id]);
    await complete(turn);
    const next = await claimed();
    expect(next.dispatch.id).toBe(q?.id);
    expect(next.trigger?.text).toBe('@Dusty also the VAT lines');
    await complete(next);
  });

  it('a message the follow-up took on after its offer becomes a follow-up of its own at the merge', async () => {
    const turn = await maraAsks();
    const first = await say(IDS.mara, '@Dusty refunds too', at(turn));
    const [q] = await queued();
    if (!q) throw new Error('no follow-up queued');
    expect((await beat(turn)).inject?.map((i) => i.messageId)).toEqual([first]);
    // Coalesced into the same queued turn after the offer, which stays as it was: a report means what was offered.
    const second = await say(IDS.mara, '@Dusty and the VAT lines', at(turn));
    expect((await queued()).map((d) => d.id)).toEqual([q.id]);
    expect((await beat(turn)).inject?.map((i) => i.messageId)).toEqual([first]);
    // The runner delivered the first: merged, and the second queued as its own follow-up in the same commit…
    const merged = await beat(turn, { injected: [q.id] });
    expect((await row(q.id)).state).toBe('cancelled');
    const [rest] = await queued();
    expect(rest).toMatchObject({
      messageId: second,
      trigger: 'mention',
      threadRootId: at(turn).threadRootId,
    });
    expect(merged.inject?.map((i) => [i.dispatchId, i.messageId])).toEqual([[rest?.id, second]]);
    // …which joins the turn the same way.
    await beat(turn, { injected: [rest?.id] });
    expect((await row(rest?.id as string)).state).toBe('cancelled');
    await complete(turn);
    expect(await claim()).toBeNull();
  });

  it('a report based on an older offer never merges a message it didn’t see', async () => {
    const turn = await maraAsks();
    const first = await say(IDS.mara, '@Dusty refunds too', at(turn));
    const [q] = await queued();
    await beat(turn);
    const second = await say(IDS.mara, '@Dusty and the VAT lines', at(turn));
    // Two beats overlap: the runner reports from the first offer while the server has seen the second message.
    await beat(turn);
    await beat(turn, { injected: [q?.id] });
    const [rest] = await queued();
    expect(rest?.messageId).toBe(second);
    expect(first).not.toBe(second);
    await complete(turn);
    expect((await claimed()).dispatch.id).toBe(rest?.id);
    await drain();
  });

  it('two follow-ups one after the other: each its own queued turn, each merged', async () => {
    const turn = await maraAsks();
    await say(IDS.mara, '@Dusty refunds too', at(turn));
    const [q1] = await queued();
    await beat(turn);
    await beat(turn, { injected: [q1?.id] });
    expect((await row(q1?.id as string)).state).toBe('cancelled');
    await say(IDS.mara, '@Dusty and the VAT lines', at(turn));
    const [q2] = await queued();
    expect(q2?.id).not.toBe(q1?.id);
    expect((await beat(turn)).inject?.map((i) => i.dispatchId)).toEqual([q2?.id]);
    await beat(turn, { injected: [q2?.id] });
    expect((await row(q2?.id as string)).state).toBe('cancelled');
    await complete(turn);
    expect(await claim()).toBeNull();
  });

  it('in a thread: the person’s next reply there joins; their message elsewhere has its own turn', async () => {
    await drain();
    const root = await say(IDS.mara, 'Credit notes, one thread please');
    const turn = await maraAsks('@Dusty why do they round differently?', root);
    expect(turn.dispatch.threadRootId).toBe(root);
    await say(IDS.mara, '@Dusty refunds too', { threadRootId: root });
    const [q] = await queued();
    expect((await beat(turn)).inject?.map((i) => i.dispatchId)).toEqual([q?.id]);
    // The same person at the top level: a new thread and its own turn (CHT-02), never offered to this one and never
    // keeping the thread's follow-up out (hermes-native.md HN-T05): that one still joins.
    const outHere = await say(IDS.mara, '@Dusty and a question out here');
    const turns = await queued();
    expect(turns.map((d) => d.threadRootId).sort()).toEqual([outHere, root].sort());
    expect((await beat(turn)).inject?.map((i) => i.dispatchId)).toEqual([q?.id]);
    await beat(turn, { injected: [q?.id] });
    expect((await row(q?.id as string)).state).toBe('cancelled');
    expect((await queued()).map((d) => d.threadRootId)).toEqual([outHere]);
    await complete(turn);
  });

  it('two threads running at once: each takes its own follow-up, the other thread’s reply keeps neither out', async () => {
    // Two of Mara's threads run side by side (hermes-native.md HN-T01).
    const one = await maraAsks();
    await say(IDS.mara, '@Dusty and how do refunds round?');
    const two = await claimed();
    expect(two.dispatch.threadRootId).not.toBe(one.dispatch.threadRootId);
    // A reply in each: one queued follow-up per thread (HN-T04), each offered to its own thread's turn (HN-T05).
    await say(IDS.mara, '@Dusty only the October ones', at(one));
    await say(IDS.mara, '@Dusty partial refunds too', at(two));
    const byThread = new Map((await queued()).map((d) => [d.threadRootId, d.id]));
    expect(byThread.size).toBe(2);
    for (const turn of [one, two]) {
      const q = byThread.get(turn.dispatch.threadRootId);
      expect((await beat(turn)).inject?.map((i) => i.dispatchId)).toEqual([q]);
      await beat(turn, { injected: [q] });
      expect((await row(q as string)).state).toBe('cancelled');
      await complete(turn);
    }
    expect(await claim()).toBeNull();
  });

  it('never offers another thread’s message', async () => {
    const turn = await maraAsks();
    // Mara in another thread of her Chat.
    const elsewhere = await say(IDS.mara, 'A thread about something else');
    await say(IDS.mara, 'Look at this one', { threadRootId: elsewhere });
    expect((await queued()).length).toBe(1);
    expect((await beat(turn)).inject).toBeUndefined();
    await complete(turn);
    await drain();
  });

  it('a Stop or a pause with the report: nothing merged, the follow-up runs as its own turn', async () => {
    // Stop (RF-01): the running turn is cancelled; its runner's next beat says so and merges nothing.
    const turn = await maraAsks();
    await say(IDS.mara, '@Dusty refunds too', at(turn));
    const [q] = await queued();
    await beat(turn);
    const stopped = await t.commit(IDS.mara, cancelDispatch, { dispatchId: turn.dispatch.id });
    expect(stopped.status).toBe('ok');
    expect(await beat(turn, { injected: [q?.id] })).toMatchObject({ cancel: true });
    expect((await row(q?.id as string)).state).toBe('queued');
    await complete(turn, { outcome: 'cancelled' });
    expect((await claimed()).dispatch.id).toBe(q?.id);

    // A pause (or take over) asks the turn to stop: neither offered nor merged then.
    const paused = await maraAsks();
    await say(IDS.mara, '@Dusty and the VAT lines', at(paused));
    const [q2] = await queued();
    await beat(paused);
    await t.services.db
      .update(dispatches)
      .set({ cancelReason: 'paused' })
      .where(eq(dispatches.id, paused.dispatch.id));
    const answer = await beat(paused, { injected: [q2?.id] });
    expect(answer).toMatchObject({ cancel: true, reason: 'paused' });
    expect(answer.inject).toBeUndefined();
    expect((await row(q2?.id as string)).state).toBe('queued');
    await drain();
  });

  it('a runner restart: the turn is handed back, claimed again, offered again, and merged then', async () => {
    const turn = await maraAsks();
    await say(IDS.mara, '@Dusty refunds too', at(turn));
    const [q] = await queued();
    await beat(turn);
    // The runner delivered it, then restarted before its next beat: the turn goes back to the queue, ahead of it.
    await complete(turn, { outcome: 'failed', error: 'runner_shutdown' });
    const again = await claimed();
    expect(again.dispatch.id).toBe(turn.dispatch.id);
    // Its window holds the follow-up; it is offered to the new attempt too, and merged when that delivers it.
    expect((await beat(again)).inject?.map((i) => i.dispatchId)).toEqual([q?.id]);
    await beat(again, { injected: [q?.id] });
    expect((await row(q?.id as string)).state).toBe('cancelled');
    await complete(again);
  });

  it('a server restart forgets what was offered: the next report merges nothing, the one after does', async () => {
    const turn = await maraAsks();
    await say(IDS.mara, '@Dusty refunds too', at(turn));
    const [q] = await queued();
    const fresh = new FollowUps(t.services);
    const current = await row(turn.dispatch.id);
    expect(await fresh.beat(current, [q?.id as string])).toHaveLength(1);
    expect((await row(q?.id as string)).state).toBe('queued');
    expect(await fresh.beat(current, [q?.id as string])).toEqual([]);
    expect((await row(q?.id as string)).state).toBe('cancelled');
    await complete(turn);
  });

  it('a follow-up’s image is offered with the message, and the running turn may fetch it', async () => {
    const turn = await maraAsks();
    const png = await upload(t.api, maraCookie, chat, 'refund.png', makePng(4, 4));
    await say(IDS.mara, '@Dusty this one too', { attachmentIds: [png.id], ...at(turn) });
    const [item] = (await beat(turn)).inject ?? [];
    expect(item?.attachments).toEqual([expect.objectContaining({ id: png.id, kind: 'image' })]);
    const lease = `runnerId=${RUNNER}&attempt=${turn.dispatch.attempts ?? 1}`;
    const got = await t.api.inject({
      method: 'GET',
      url: `/internal/runner/dispatches/${turn.dispatch.id}/attachments/${png.id}?${lease}`,
      headers: AUTH,
    });
    expect(got.statusCode).toBe(200);
    await complete(turn);
    await drain();
  });
});

/** A test-only command: Whombat posts for the person, mentioning Dusty, with more for him than the chat shows. */
const postWithMore = defineCommand({
  name: 'test_post_with_more',
  schema: z.object({
    conversationId: z.string(),
    threadRootId: z.string(),
    text: z.string(),
    brief: z.string().optional(),
    handoff: z.boolean().optional(),
  }),
  async apply(tx, ctx, input) {
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation) throw new Error('no conversation');
    const posted = await postMessage(ctx, {
      conversation,
      threadRootId: input.threadRootId,
      text: input.text,
      mentions: [IDS.dusty],
      ...(input.handoff ? { provenance: 'feedback_handoff' as const } : {}),
    });
    if (input.brief) await briefAgent(ctx, { messageId: posted.id, agentId: IDS.dusty, brief: input.brief });
    return { id: posted.id };
  },
});

async function postedWithMore(
  turn: DispatchContext,
  more: { brief?: string; handoff?: boolean },
): Promise<string> {
  const res = await t.commit(IDS.mara, postWithMore, {
    conversationId: chat,
    ...at(turn),
    text: '@Dusty there is more to this',
    ...more,
  });
  if (res.status !== 'ok') throw new Error('post failed');
  return res.result.id;
}

describe('a message with more for the agent than the chat shows gets a turn of its own', () => {
  it('one with a brief is never offered: it runs as its own turn, which reads the brief', async () => {
    const turn = await maraAsks();
    const briefed = await postedWithMore(turn, { brief: 'Use draft_automation for aut_42.' });
    const [q] = await queued();
    expect(q?.messageId).toBe(briefed);
    expect((await beat(turn)).inject).toBeUndefined();
    await complete(turn);
    const next = await claimed();
    expect(next.dispatch.id).toBe(q?.id);
    expect(next.trigger?.text).toContain('aut_42');
    await complete(next);
  });

  it('a follow-up is offered up to a handoff, which keeps a queued turn of its own through the merge', async () => {
    const turn = await maraAsks();
    const first = await say(IDS.mara, '@Dusty refunds too', at(turn));
    const handoff = await postedWithMore(turn, { handoff: true });
    const both = await queued();
    expect(both.map((d) => d.messageId).sort()).toEqual([first, handoff].sort());
    const q = both.find((d) => d.messageId === first);
    if (!q) throw new Error('no follow-up queued');
    expect((await beat(turn)).inject?.map((i) => i.messageId)).toEqual([first]);
    const merged = await beat(turn, { injected: [q.id] });
    expect((await row(q.id)).state).toBe('cancelled');
    // The merge leaves the handoff's own turn as it was: one turn for it, not a second.
    const rest = await queued();
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ messageId: handoff, trigger: 'mention' });
    expect(merged.inject).toBeUndefined();
    await complete(turn);
    const next = await claimed();
    expect(next.dispatch.id).toBe(rest[0]?.id);
    expect(next.trigger?.id).toBe(handoff);
    await complete(next);
  });

  it('one with a brief never joins a turn already queued for an earlier message: its own turn reads the brief', async () => {
    const turn = await maraAsks();
    const first = await say(IDS.mara, '@Dusty refunds too', at(turn));
    const briefed = await postedWithMore(turn, { brief: 'Use draft_automation for aut_77.' });
    const both = await queued();
    expect(both.map((d) => d.messageId).sort()).toEqual([first, briefed].sort());
    // A later message of the person's joins one of them, and starts no third turn.
    await say(IDS.mara, '@Dusty and the totals', at(turn));
    expect(await queued()).toHaveLength(2);
    await complete(turn);
    const next = await claimed();
    expect(next.trigger?.id).toBe(first);
    await complete(next);
    const own = await claimed();
    expect(own.trigger?.id).toBe(briefed);
    expect(own.trigger?.text).toContain('aut_77');
    await complete(own);
  });
});

describe('a run’s turn and its person’s follow-ups (SX-07)', () => {
  it('beside the turn that started the run (HR-01), the run’s turn takes the follow-up, the other offers nothing', async () => {
    const parent = await maraAsks('@Dusty credit notes round differently from invoices, please fix that');
    const res = await t.commit(IDS.dusty, startRun, {
      conversationId: chat,
      title: 'Round credit notes like invoices',
      repo: 'whombat/billing',
      branch: 'feat/steer-credit-notes',
      dispatchId: parent.dispatch.id,
      steps: [{ title: 'Fix the rounding', detail: '' }],
    });
    if (res.status !== 'ok') throw new Error(`start_run: ${res.status}`);
    const run = await claimed();
    expect(run.dispatch).toMatchObject({ mode: 'run', runId: res.result.runId });
    await beat(run);
    await say(
      IDS.mara,
      '@Dusty round half up, not to even',
      run.dispatch.threadRootId ? { threadRootId: run.dispatch.threadRootId } : {},
    );
    const [q] = await queued();
    expect((await beat(parent)).inject).toBeUndefined();
    expect((await beat(run)).inject?.map((i) => i.dispatchId)).toEqual([q?.id]);
    await beat(run, { injected: [q?.id] });
    expect((await row(q?.id as string)).state).toBe('cancelled');
    await drain();
  });
});
