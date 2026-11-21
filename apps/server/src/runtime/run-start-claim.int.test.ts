/**
 * A run's turn isn't queued behind the turn that started it (docs/decisions/health-run-start.md HRS-01…HRS-04): the
 * claim hands out a run's turn while the turn whose `start_run` made the run (`runs.dispatch_id`) is still in flight in
 * the same conversation. Nothing else gets past the one in-flight turn per (agent, conversation): another mention
 * there, another run's turn, the run's own next turn. The run's turn never resumes the provider session its starting
 * turn still runs in, and its beats and its end leave that turn's “is thinking” alone.
 */
import { type DispatchContext, runnerApi } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { startRun } from '../commands/agent-runs';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_test-runner';
/** Dusty's “is thinking” for top-level messages in #billing-v2: his mention turn's, and the run turn's it starts. */

async function post(url: string, payload: unknown) {
  return t.api.inject({
    method: 'POST',
    url,
    headers: AUTH,
    payload: (await withLease(url, payload)) as object,
  });
}

/**
 * A call about one dispatch carries the whole lease its runner holds now (managed-sandbox.md MSB-10), unless the test
 * names one itself.
 */
async function withLease(url: string, payload: unknown) {
  const id = /^\/internal\/runner\/dispatches\/([^/]+)\//.exec(url)?.[1];
  if (!id || typeof payload !== 'object' || payload === null || 'attempt' in payload) return payload;
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  return row?.runnerId ? { runnerId: row.runnerId, attempt: row.attempts, ...payload } : payload;
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

async function progress(id: string, extra: Record<string, unknown> = {}) {
  const res = await post(`/internal/runner/dispatches/${id}/progress`, { state: 'running', ...extra });
  expect(res.statusCode).toBe(200);
}

async function complete(id: string) {
  const res = await post(`/internal/runner/dispatches/${id}/complete`, { outcome: 'done' });
  expect(res.statusCode).toBe(200);
}

async function say(actorId: string, text: string) {
  const res = await t.commit(actorId, sendMessage, { conversationId: IDS.billing, text });
  if (res.status !== 'ok') throw new Error('send failed');
}

async function drain() {
  for (const r of await t.services.db.select().from(dispatches))
    if (r.state === 'queued' || r.state === 'claimed' || r.state === 'running')
      await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, r.id));
}

/** Dusty's turn `parentId` (a mention, no checkout) starts a run: the run and the run turn it queued (RC-01). */
async function startRunFrom(parentId: string, branch: string) {
  const res = await t.commit(IDS.dusty, startRun, {
    conversationId: IDS.billing,
    title: 'Round credit notes like invoices',
    repo: 'whombat/billing',
    branch,
    dispatchId: parentId,
    steps: [{ title: 'Fix the rounding', detail: '' }],
  });
  if (res.status !== 'ok') throw new Error(`start_run: ${res.status}`);
  const turns = await t.services.db.select().from(dispatches).where(eq(dispatches.runId, res.result.runId));
  expect(turns).toHaveLength(1);
  return { runId: res.result.runId, turn: turns[0] as (typeof turns)[number] };
}

/** A run-control turn of Dusty's on `runId` in #billing-v2 (a resume, a recovery). */
async function runControl(runId: string) {
  const [queued] = await enqueueDispatches(t.services, {
    burrowId: t.burrowId,
    causedById: IDS.mara,
    conversationId: IDS.billing,
    messageId: null,
    threadRootId: null,
    requests: [{ agentId: IDS.dusty, trigger: 'run_control', mode: 'run' }],
    at: new Date(),
    runId,
  });
  if (!queued?.created) throw new Error('no new run turn');
  return queued.dispatchId;
}

describe('a run’s turn beside the turn that started it (HR-01)', () => {
  it('is claimed while that turn is in flight; every other turn there still waits for the one in flight', async () => {
    await drain();
    await say(IDS.mara, '@Dusty credit notes round differently from invoices, please fix that');
    const parent = await claimed();
    expect(parent.dispatch).toMatchObject({ agentId: IDS.dusty, trigger: 'mention', mode: 'reply' });
    // Its provider session, as its beats report it.
    await progress(parent.dispatch.id, { providerSessionId: 'sess-parent' });
    // Mara asks Dusty something else there: it waits for the turn in flight, as always.
    await say(IDS.mara, '@Dusty how do refunds round?');
    expect(await claim()).toBeNull();

    // The mention turn starts a run; the run's turn, with the checkout, is queued after Mara's question…
    const { runId, turn } = await startRunFrom(parent.dispatch.id, 'feat/credit-note-rounding');
    expect(turn).toMatchObject({
      trigger: 'run_control',
      mode: 'run',
      state: 'queued',
      conversationId: IDS.billing,
    });
    // …and claimed now, while the turn that started it is still at work (HRS-01), never in that turn's session (HRS-03).
    const run = await claimed();
    expect(run.dispatch).toMatchObject({ id: turn.id, runId, mode: 'run', providerSessionId: null });

    // Nothing else gets past the two: Mara's question, another run's turn, the run's own next turn (HRS-02).
    expect(await claim()).toBeNull();
    const other = await runControl('run_1907');
    const next = await runControl(runId);
    expect(await claim()).toBeNull();

    // The starting turn ends: the run's turn is the one in flight there, and the others wait for it as before.
    await complete(parent.dispatch.id);
    expect(await claim()).toBeNull();
    await complete(run.dispatch.id);

    // Then one at a time, oldest first.
    const question = await claimed();
    expect(question.dispatch).toMatchObject({ trigger: 'mention', mode: 'reply' });
    expect(question.trigger?.text).toBe('@Dusty how do refunds round?');
    expect(await claim()).toBeNull();
    await complete(question.dispatch.id);
    const resumed = await claimed();
    expect(resumed.dispatch).toMatchObject({ id: other, runId: 'run_1907' });
    expect(await claim()).toBeNull();
    await complete(resumed.dispatch.id);
    // A starting turn that has ended hands its session on as before (HRS-03).
    const again = await claimed();
    expect(again.dispatch).toMatchObject({ id: next, runId, providerSessionId: 'sess-parent' });
    await complete(again.dispatch.id);
    expect(await claim()).toBeNull();
  });

  it('leaves the starting turn’s “is thinking” alone (HR-04)', async () => {
    await drain();
    await say(IDS.mara, '@Dusty the VAT line is a cent off, can you fix it?');
    const parent = await claimed();
    // In the thread under the ask (channel-threads.md CH-01).
    const THINKING = {
      conversationId: IDS.billing,
      threadRootId: parent.dispatch.threadRootId,
      principalId: IDS.dusty,
    };
    await progress(parent.dispatch.id, { thinking: true });
    expect(t.services.typing.isActive(THINKING)).toBe(true);

    const { turn } = await startRunFrom(parent.dispatch.id, 'feat/vat-cent');
    expect((await claimed()).dispatch.id).toBe(turn.id);
    // A run's turn never thinks out loud (its run shows): neither its beats nor its end clear the other turn's.
    await progress(turn.id, { thinking: false });
    expect(t.services.typing.isActive(THINKING)).toBe(true);
    await complete(turn.id);
    expect(t.services.typing.isActive(THINKING)).toBe(true);

    // The starting turn said something: its indicator goes, as always.
    await progress(parent.dispatch.id, { thinking: false });
    expect(t.services.typing.isActive(THINKING)).toBe(false);
    await complete(parent.dispatch.id);
  });
});
