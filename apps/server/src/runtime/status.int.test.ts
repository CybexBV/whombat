/**
 * An agent's status is Whombat's (docs/decisions/agent-status.md AS-03): working while a turn runs, waiting
 * while a question it asked has no answer from a person in that place, idle otherwise.
 */
import { runnerApi } from '@whombat/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { setAgentStatus } from '../commands/agent-status';
import { sendMessage } from '../commands/messages';
import { dispatches, events, principals } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { waitFor } from '../test/runner';

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_status-runner';

async function claim() {
  const res = await t.api.inject({
    method: 'POST',
    url: '/internal/runner/claim',
    headers: AUTH,
    payload: { runnerId: RUNNER, providers: ['claude'], waitMs: 0 },
  });
  expect(res.statusCode).toBe(200);
  const ctx = runnerApi.claim.response.parse(res.json()).dispatch;
  if (!ctx) throw new Error('nothing to claim');
  return ctx;
}

/** The lease this runner holds on the dispatch (every call carries it whole, managed-sandbox.md MSB-10). */
async function lease(id: string) {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  return { runnerId: RUNNER, attempt: row?.attempts ?? 1 };
}

async function complete(id: string, outcome: 'done' | 'failed' = 'done') {
  const res = await t.api.inject({
    method: 'POST',
    url: `/internal/runner/dispatches/${id}/complete`,
    headers: AUTH,
    payload: { ...(await lease(id)), outcome, ...(outcome === 'failed' ? { error: 'crash' } : {}) },
  });
  expect(res.statusCode).toBe(200);
}

async function status(agentId: string) {
  const [row] = await t.services.db
    .select({ status: principals.status, doing: principals.doing })
    .from(principals)
    .where(eq(principals.id, agentId));
  return row;
}

async function say(conversationId: string, text: string) {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('send failed');
}

describe('agent status around turns', () => {
  it('a claimed turn makes a waiting agent working; a turn that asked nothing ends idle and keeps its line', async () => {
    // Waiting, as a status left from before (it asked nothing that is still open).
    const line = 'Waiting for the fix on PR #482.';
    await t.services.db
      .update(principals)
      .set({ status: 'waiting', doing: line })
      .where(eq(principals.id, IDS.dusty));
    await say(IDS.billing, '@Dusty is the fix in yet?');
    const ctx = await claim();
    expect(ctx.agent.id).toBe(IDS.dusty);
    expect((await status(IDS.dusty))?.status).toBe('working');
    await complete(ctx.dispatch.id);
    expect(await status(IDS.dusty)).toEqual({ status: 'idle', doing: line });

    const statusEvents = await t.services.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.type, 'agent.status'), eq(events.aboutId, IDS.dusty)))
      .orderBy(asc(events.seq));
    expect(statusEvents.map((e) => (e.payload as { status: string }).status)).toEqual([
      'idle',
      'working',
      'idle',
    ]);
  });

  it('the agent cannot say it is waiting: set_status only writes its line', async () => {
    await say(IDS.billing, '@Dusty nothing for now.');
    const ctx = await claim();
    const set = await t.commit(IDS.dusty, setAgentStatus, {
      doing: 'Parked the review until Dusty pushes.',
    });
    expect(set.status).toBe('ok');
    expect((await status(IDS.dusty))?.status).toBe('working');
    await complete(ctx.dispatch.id);
    expect(await status(IDS.dusty)).toEqual({
      status: 'idle',
      doing: 'Parked the review until Dusty pushes.',
    });
  });

  it('a question it asked keeps it waiting until a person answers there', async () => {
    await say(IDS.billing, '@Dusty can you review the credit notes?');
    const ctx = await claim();
    const asked = await t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.billing,
      text: 'Which PR, #482 or #483?',
      asks: true,
    });
    if (asked.status !== 'ok') throw new Error('ask failed');
    await complete(ctx.dispatch.id);
    expect((await status(IDS.dusty))?.status).toBe('waiting');

    // Talk in another thread is no answer; Dusty (an agent) is no answer either.
    await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'Looks good to me.',
      threadRootId: 'msg_billing-dusty-0941',
    });
    await t.commit(IDS.dusty, sendMessage, { conversationId: IDS.billing, text: 'I pushed #483.' });
    expect((await status(IDS.dusty))?.status).toBe('waiting');

    // Mara answers in the question's thread, without a mention: the question is answered.
    await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: '#483 please.',
      threadRootId: asked.result.id,
    });
    await waitFor(async () => ((await status(IDS.dusty))?.status === 'idle' ? true : null));
    await drain();
  });

  it('stays working while another of its turns runs, and stays working through a retry', async () => {
    await say(IDS.billing, '@Dusty can you check the rounding order?');
    await say(IDS.pr482, '@Dusty is the re-review requested?');
    const first = await claim();
    const second = await claim();
    expect([first.agent.id, second.agent.id]).toEqual([IDS.dusty, IDS.dusty]);
    await complete(first.dispatch.id);
    expect((await status(IDS.dusty))?.status).toBe('working');
    // A crash is retried: the turn is not over yet.
    await complete(second.dispatch.id, 'failed');
    expect((await status(IDS.dusty))?.status).toBe('working');
    // Skip the retry backoff.
    await t.services.db
      .update(dispatches)
      .set({ notBefore: null })
      .where(eq(dispatches.id, second.dispatch.id));
    const retry = await claim();
    expect(retry.dispatch.id).toBe(second.dispatch.id);
    await complete(retry.dispatch.id);
    expect((await status(IDS.dusty))?.status).toBe('idle');
  });
});

/** Ends whatever a test left queued (a person's message may wake an agent). */
async function drain() {
  await t.services.db
    .update(dispatches)
    .set({ state: 'done' })
    .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
}
