/**
 * Stop on an agent's turn (docs/decisions/review-features.md RF-01; contracts CT-295, `dispatches.cancel`):
 *
 *  - who: the person — never an agent (403), never someone outside the room (404);
 *  - a queued turn is cancelled at once (“Stopped by Mara”, `dispatch.updated`, the thinking line cleared, a hidden
 *    signed `dispatch.cancelled`); a running one too, and the runner's next beat answers `cancel`, its completion still
 *    counts what it used, and the agent's next turn there waits until then;
 *  - a run's turn answers 409 “Pause the run instead.”; a second press answers with how the turn ended;
 *  - `typing.dispatchId` names the turn that thinks; the Work view offers `stop_turn` to those allowed.
 */
import {
  api,
  CancelDispatchResponse,
  DispatchContext,
  runnerApi,
  TURN_STOP_RUN_REFUSAL,
  WorkOverview,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches, events } from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { cancelDispatch } from './stop';

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_stop';
const frames: BusFrame[] = [];

beforeAll(async () => {
  Object.assign(t.services.runtime.options, { retryBackoffMs: 0, pollMs: 20, maxAttempts: 1 });
  t.services.bus.onFrame((f) => frames.push(f));
});

async function post(url: string, payload: unknown) {
  return t.api.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });
}

async function drain() {
  await t.services.db
    .update(dispatches)
    .set({ state: 'done', leaseExpiresAt: null })
    .where(eq(dispatches.burrowId, t.burrowId));
}

async function claim(): Promise<DispatchContext | null> {
  const res = await post('/internal/runner/claim', { runnerId: RUNNER, providers: ['claude'], waitMs: 0 });
  const ctx = runnerApi.claim.response.parse(res.json()).dispatch;
  return ctx ? DispatchContext.parse(ctx) : null;
}

async function row(id: string) {
  const [r] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!r) throw new Error(`no dispatch ${id}`);
  return r;
}

/** Mara asks Dusty in #billing-v2: the queued turn's id. */
async function ask(text = '@Dusty can you check the totals?'): Promise<string> {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text });
  if (res.status !== 'ok') throw new Error('send failed');
  const [queued] = await t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
  if (!queued) throw new Error('nothing queued');
  return queued.id;
}

async function stop(dispatchId: string, as: string) {
  const { cookie } = await sessionFor(t.services, as);
  const res = await t.api.inject({
    method: 'POST',
    url: `/api/v1/burrows/burrow-hq/dispatches/${dispatchId}/cancel`,
    headers: { cookie },
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown> & { error?: { message: string } },
  };
}

async function work(as: string) {
  const { cookie } = await sessionFor(t.services, as);
  const res = await t.api.inject({
    method: 'GET',
    url: '/api/v1/burrows/burrow-hq/work',
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return WorkOverview.parse(res.json());
}

const workItem = (overview: WorkOverview, dispatchId: string) =>
  overview.sections.flatMap((s) => s.items).find((i) => i.refs.dispatchId === dispatchId);

describe('who may stop a turn', () => {
  it('the person it is for; never an agent', async () => {
    await drain();
    const id = await ask();
    // An agent never stops a turn.
    await expect(t.commit(IDS.dusty, cancelDispatch, { dispatchId: id })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await row(id)).state).toBe('queued');
    const byMara = await stop(id, IDS.mara);
    expect(byMara.status, JSON.stringify(byMara.body)).toBe(200);
    expect(CancelDispatchResponse.parse(byMara.body).dispatch).toMatchObject({
      id,
      state: 'cancelled',
      reason: 'Stopped by Mara',
    });
    expect((await row(id)).stoppedById).toBe(IDS.mara);
  });
});

describe('a queued turn', () => {
  it('is cancelled at once: the frame says who, the line clears, a hidden event is signed', async () => {
    await drain();
    frames.length = 0;
    const id = await ask();
    // The thinking line names the turn (CT-295).
    const thinking = frames.find((f) => f.event.type === 'typing' && f.event.active);
    expect(thinking?.event).toMatchObject({ type: 'typing', principalId: IDS.dusty, dispatchId: id });
    expect(workItem(await work(IDS.mara), id)?.actions).toEqual(['stop_turn', 'open']);
    frames.length = 0;
    const res = await stop(id, IDS.mara);
    expect(res.status).toBe(200);
    const stopped = await row(id);
    expect(stopped).toMatchObject({ state: 'cancelled', error: 'stopped', stoppedById: IDS.mara });
    const updated = frames.find((f) => f.event.type === 'dispatch.updated');
    expect(updated?.event).toMatchObject({
      dispatch: { id, state: 'cancelled', reason: 'Stopped by Mara' },
    });
    const cleared = frames.find((f) => f.event.type === 'typing' && !f.event.active);
    expect(cleared?.event).toMatchObject({ principalId: IDS.dusty, dispatchId: id });
    const event = (
      await t.services.db
        .select()
        .from(events)
        .where(and(eq(events.type, 'dispatch.cancelled'), eq(events.actorId, IDS.mara)))
    ).find((e) => (e.payload as { dispatchId?: string }).dispatchId === id);
    expect(event).toMatchObject({ kind: 'System', text: null });
    expect(event?.payload).toMatchObject({ dispatchId: id, agentId: IDS.dusty });
    // Nothing is claimed for it.
    expect(await claim()).toBeNull();
    // A second press answers with how it ended.
    const again = await stop(id, IDS.mara);
    expect(again.status).toBe(200);
    expect(CancelDispatchResponse.parse(again.body).dispatch).toMatchObject({
      state: 'cancelled',
      reason: 'Stopped by Mara',
    });
  });
});

describe('a running turn', () => {
  it('stops at the runner’s next beat; what it used still counts; the next turn waits for its end', async () => {
    await drain();
    await ask();
    const ctx = await claim();
    if (!ctx) throw new Error('nothing claimed');
    const id = ctx.dispatch.id;
    const beat = await post(`/internal/runner/dispatches/${id}/progress`, {
      runnerId: RUNNER,
      attempt: 1,
      state: 'running',
      thinking: true,
      providerSessionId: 'sess-stop',
    });
    expect(beat.json()).toMatchObject({ cancel: false });
    const thinking = frames.filter((f) => f.event.type === 'typing' && f.event.active).at(-1);
    expect(thinking?.event).toMatchObject({ dispatchId: id });
    expect(workItem(await work(IDS.mara), id)?.actions).toContain('stop_turn');
    expect((await stop(id, IDS.mara)).status).toBe(200);
    expect(await row(id)).toMatchObject({ state: 'cancelled', stoppedById: IDS.mara });
    // Mara asks again at once: queued, not claimed beside the stopping turn.
    const next = await ask('@Dusty never mind that, do this instead');
    expect(await claim()).toBeNull();
    // The runner's next beat says stop.
    const after = await post(`/internal/runner/dispatches/${id}/progress`, {
      runnerId: RUNNER,
      attempt: 1,
      state: 'running',
      thinking: true,
    });
    expect(after.json()).toMatchObject({ cancel: true, reason: 'cancelled' });
    // It ends: what it used is kept, the lease ends, and the next turn may start.
    const done = await post(`/internal/runner/dispatches/${id}/complete`, {
      runnerId: RUNNER,
      attempt: 1,
      outcome: 'cancelled',
      providerSessionId: 'sess-stop',
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
    expect(done.statusCode, done.body).toBe(200);
    const ended = await row(id);
    expect(ended).toMatchObject({ state: 'cancelled', leaseExpiresAt: null, providerSessionId: 'sess-stop' });
    expect(ended.usage).toMatchObject({ inputTokens: 1200, outputTokens: 80 });
    const claimed = await claim();
    expect(claimed?.dispatch.id).toBe(next);
  });

  it('a run’s turn answers 409: the run is paused instead', async () => {
    await drain();
    const id = await ask();
    await t.services.db
      .update(dispatches)
      .set({ runId: 'run_somewhere', mode: 'run' })
      .where(eq(dispatches.id, id));
    const res = await stop(id, IDS.mara);
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toBe(TURN_STOP_RUN_REFUSAL);
    expect((await row(id)).state).toBe('queued');
  });

  it('is in the contract: dispatches.cancel', () => {
    expect(api.dispatches.cancel.path).toBe('/burrows/:burrow/dispatches/:dispatchId/cancel');
  });
});
