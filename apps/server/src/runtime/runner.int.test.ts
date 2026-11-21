/**
 * The runner protocol (`/internal/runner/*`): runner tokens, long-poll claims that lease a dispatch and hand
 * out a DispatchContext, the one-turn-per-(agent, conversation) invariant with coalesced follow-ups,
 * progress (thinking, cancel on pause / take over), completion with one retry after a crash and a quiet
 * error, heartbeats, lease expiry and git credentials.
 */
import { DispatchContext, runnerApi, turnFailureText } from '@whombat/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyAgentToken } from '../auth/agent-tokens';
import { askSearch } from '../commands/content';
import { sendMessage } from '../commands/messages';
import { pauseRun, resumeRun, takeOverRun } from '../commands/runs';
import { approvals, dispatches, events, messages, principals, runs, searchAnswers } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { IDS } from '../seed/test-world';
import { BUSY_POOL_SIZE } from '../test/db';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { waitFor } from '../test/runner';
import { RUNNER_SHUTDOWN } from './service';

const t = useTestServer({ seed: true, app: true, poolSize: BUSY_POOL_SIZE, env: signInsEnv() });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_test-runner';

beforeAll(async () => {
  Object.assign(t.services.runtime.options, { retryBackoffMs: 40, pollMs: 20 });
  // Agents' git runs on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
  await connectGitHubAs(t.services, IDS.mara);
});

async function post(url: string, payload: unknown, headers: Record<string, string> = AUTH) {
  return t.api.inject({ method: 'POST', url, headers, payload: (await withLease(url, payload)) as object });
}

/**
 * A call about one dispatch carries the whole lease its runner holds now (managed-sandbox.md MSB-10), unless the test
 * names one itself.
 */
async function withLease(url: string, payload: unknown) {
  const id = /^\/internal\/runner\/dispatches\/([^/]+)\//.exec(url)?.[1];
  if (!id || typeof payload !== 'object' || payload === null || 'runnerId' in payload) return payload;
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  return row?.runnerId ? { runnerId: row.runnerId, attempt: row.attempts, ...payload } : payload;
}

async function claim(waitMs = 0): Promise<DispatchContext | null> {
  const res = await post('/internal/runner/claim', { runnerId: RUNNER, providers: ['claude'], waitMs });
  expect(res.statusCode).toBe(200);
  const body = runnerApi.claim.response.parse(res.json());
  return body.dispatch;
}

async function progress(id: string, extra: Record<string, unknown> = {}) {
  const res = await post(`/internal/runner/dispatches/${id}/progress`, { state: 'running', ...extra });
  expect(res.statusCode).toBe(200);
  return runnerApi.progress.response.parse(res.json());
}

async function complete(id: string, body: Record<string, unknown>) {
  const res = await post(`/internal/runner/dispatches/${id}/complete`, body);
  expect(res.statusCode).toBe(200);
}

async function dispatchRow(id: string) {
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!row) throw new Error(`no dispatch ${id}`);
  return row;
}

async function say(actorId: string, conversationId: string, text: string, threadRootId?: string) {
  const res = await t.commit(actorId, sendMessage, {
    conversationId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (res.status !== 'ok') throw new Error('send failed');
  return res.result.id;
}

async function drain() {
  // Finish anything a previous test left queued or running so each test starts clean.
  const rows = await t.services.db.select().from(dispatches);
  for (const r of rows)
    if (r.state === 'queued' || r.state === 'claimed' || r.state === 'running')
      await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, r.id));
}

describe('runner tokens', () => {
  it('refuses runner endpoints without the runner token', async () => {
    const none = await post('/internal/runner/claim', { runnerId: RUNNER, providers: ['claude'] }, {});
    expect(none.statusCode).toBe(401);
    const wrong = await post(
      '/internal/runner/heartbeat',
      { runnerId: RUNNER, active: [] },
      { authorization: 'Bearer nope' },
    );
    expect(wrong.statusCode).toBe(401);
    const agent = await post(
      '/internal/runner/claim',
      { runnerId: RUNNER, providers: ['claude'] },
      {
        authorization: 'Bearer wat_x',
      },
    );
    expect(agent.statusCode).toBe(401);
  });

  it('names the person, the account that claimed the box (one-person.md OP-S131)', async () => {
    const res = await post('/internal/runner/person', {});
    expect(res.statusCode).toBe(200);
    const [mara] = await t.services.db
      .select({ accountId: principals.accountId })
      .from(principals)
      .where(eq(principals.id, IDS.mara));
    expect(runnerApi.person.response.parse(res.json())).toEqual({ accountId: mara?.accountId });
    expect((await post('/internal/runner/person', {}, {})).statusCode).toBe(401);
  });

  it('answers an empty claim after the long-poll window', async () => {
    const started = Date.now();
    expect(await claim(120)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });
});

describe('claim and the in-flight invariant', () => {
  it('a person’s message in their Chat queues a dispatch; the claim leases it and hands out a DispatchContext', async () => {
    await drain();
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    const messageId = await say(IDS.mara, chat, '@Dusty can you check the rounding order?');
    const [queued] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, IDS.dusty)));
    expect(queued?.state).toBe('queued');
    // In a person's Chat the turn answers in a thread under the message (chat-channel.md CHT-02).
    expect(queued?.threadRootId).toBe(messageId);
    expect(
      t.services.typing.isActive({
        conversationId: chat,
        threadRootId: messageId,
        principalId: IDS.dusty,
      }),
    ).toBe(true);

    const ctx = await claim();
    expect(ctx).not.toBeNull();
    if (!ctx) return;
    expect(() => DispatchContext.parse(ctx)).not.toThrow();
    expect(ctx.dispatch).toMatchObject({
      id: queued?.id,
      agentId: IDS.dusty,
      trigger: 'mention',
      mode: 'reply',
    });
    expect(ctx.agent).toMatchObject({ name: 'Dusty' });
    expect(ctx.agent).not.toHaveProperty('role');
    expect(ctx.agent.keys.can.map((k) => k.label)).toContain('Read and write feat/* branches');
    expect(ctx.agent.keys.cannot.map((k) => k.label)).toContain('Merge into main');
    expect(ctx.conversation).toMatchObject({ id: chat, kind: 'dm' });
    expect(ctx.trigger?.text).toBe('@Dusty can you check the rounding order?');
    expect(ctx.thread?.root.id).toBe(messageId);
    // A Chat thread is a conversation of its own: no room window.
    expect(ctx.window).toEqual([]);
    expect(ctx.principals.find((p) => p.id === IDS.mara)?.name).toBe('Mara Okafor');
    expect(ctx.facts.join(' ')).toContain('whombat/billing');
    expect(ctx.mcpPath).toBe('/mcp');
    expect(await verifyAgentToken(t.services, ctx.agentToken.token)).toMatchObject({ agentId: IDS.dusty });

    const row = await dispatchRow(ctx.dispatch.id);
    expect(row).toMatchObject({ state: 'claimed', runnerId: RUNNER, attempts: 1 });
    expect(row.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    await complete(ctx.dispatch.id, {
      outcome: 'done',
      usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.01 },
    });
    expect(await dispatchRow(ctx.dispatch.id)).toMatchObject({
      state: 'done',
      usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.01 },
    });
  });

  it('mentions during a turn coalesce into one follow-up, claimed only after the turn ends', async () => {
    await drain();
    await say(IDS.mara, IDS.pr482, '@Dusty first question');
    const first = await claim();
    expect(first).not.toBeNull();
    if (!first) return;
    await say(IDS.mara, IDS.pr482, '@Dusty second question');
    await say(IDS.mara, IDS.pr482, '@Dusty third question');
    const queuedNow = () =>
      t.services.db
        .select()
        .from(dispatches)
        .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.state, 'queued')));
    const queued = await queuedNow();
    expect(queued).toHaveLength(1);
    // One in-flight turn per (agent, conversation): the follow-ups wait.
    expect(await claim()).toBeNull();
    await complete(first.dispatch.id, { outcome: 'done' });
    const next = await claim();
    expect(next?.dispatch.id).toBe(queued[0]?.id);
    const texts = next
      ? [...next.window, ...(next.thread ? [next.thread.root, ...next.thread.replies] : [])]
      : [];
    const words = texts.map((m) => m.text);
    expect(words).toContain('@Dusty second question');
    expect(words).toContain('@Dusty third question');
    expect(await claim()).toBeNull();
    if (next) await complete(next.dispatch.id, { outcome: 'done' });
  });

  it('concurrent claims never hand out two turns for the same agent and conversation', async () => {
    await drain();
    // Her message in her Chat and her search question: both the agent's turns there (OA-S46).
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    await say(IDS.mara, chat, 'What did we decide about VAT on refunds?');
    await t.commit(IDS.mara, askSearch, { q: 'refund VAT rounding' });
    const both = await Promise.all([claim(), claim()]);
    const got = both.filter((c) => c !== null);
    expect(got).toHaveLength(1);
    if (got[0]) await complete(got[0].dispatch.id, { outcome: 'done' });
    const second = await claim();
    expect(second).not.toBeNull();
    if (second) await complete(second.dispatch.id, { outcome: 'done' });
  });
});

describe('progress, pause and take over', () => {
  async function runControl() {
    await drain();
    const [queued] = await enqueueDispatches(t.services, {
      burrowId: t.burrowId,
      causedById: IDS.mara,
      conversationId: IDS.billing,
      messageId: null,
      threadRootId: null,
      requests: [{ agentId: IDS.dusty, trigger: 'run_control', mode: 'run' }],
      at: new Date(),
      runId: 'run_1907',
    });
    const ctx = await claim();
    expect(ctx?.dispatch.id).toBe(queued?.dispatchId);
    expect(ctx?.run?.number).toBe(1907);
    expect(ctx?.workspace).toMatchObject({
      repo: 'whombat/billing',
      branch: 'feat/invoice-pdf',
      baseBranch: 'main',
    });
    return ctx as DispatchContext;
  }

  it('keeps thinking alive and answers cancel once a person pauses the run; resume continues the session', async () => {
    const ctx = await runControl();
    expect(await progress(ctx.dispatch.id, { providerSessionId: 'sess-1907' })).toEqual({
      cancel: false,
      reason: null,
    });
    expect((await dispatchRow(ctx.dispatch.id)).state).toBe('running');

    await t.commit(IDS.mara, pauseRun, { number: 1907 });
    expect(await progress(ctx.dispatch.id)).toEqual({ cancel: true, reason: 'paused' });
    const hb = await post('/internal/runner/heartbeat', { runnerId: RUNNER, active: [ctx.dispatch.id] });
    expect(hb.json()).toEqual({ cancel: [ctx.dispatch.id] });
    await complete(ctx.dispatch.id, { outcome: 'cancelled' });
    expect(await dispatchRow(ctx.dispatch.id)).toMatchObject({ state: 'cancelled', cancelReason: 'paused' });

    await t.commit(IDS.mara, resumeRun, { number: 1907 });
    const resumed = await claim();
    expect(resumed?.dispatch).toMatchObject({
      trigger: 'run_control',
      runId: 'run_1907',
      providerSessionId: 'sess-1907',
    });
    if (resumed) await complete(resumed.dispatch.id, { outcome: 'done' });
  });

  it('take over stops the turn and cancels the dispatch', async () => {
    const ctx = await runControl();
    await progress(ctx.dispatch.id);
    await t.commit(IDS.mara, takeOverRun, { number: 1907 });
    expect(await progress(ctx.dispatch.id)).toEqual({ cancel: true, reason: 'taken_over' });
    await complete(ctx.dispatch.id, { outcome: 'cancelled' });
    expect((await dispatchRow(ctx.dispatch.id)).state).toBe('cancelled');
    // A resume request for a taken-over run is never claimed.
    const [late] = await enqueueDispatches(t.services, {
      burrowId: t.burrowId,
      causedById: IDS.mara,
      conversationId: IDS.billing,
      messageId: null,
      threadRootId: null,
      requests: [{ agentId: IDS.dusty, trigger: 'run_control', mode: 'run' }],
      at: new Date(),
      runId: 'run_1907',
    });
    expect(await claim()).toBeNull();
    expect(await dispatchRow(late?.dispatchId ?? '')).toMatchObject({
      state: 'cancelled',
      error: 'run_taken_over',
    });
  });

  it('a take over that commits while a progress beat waits for the row still answers taken_over', async () => {
    await t.services.db
      .update(runs)
      .set({ status: 'live', takenOverById: null, finishedAt: null })
      .where(eq(runs.id, 'run_1907'));
    const ctx = await runControl();
    const lease = { runnerId: RUNNER, attempt: ctx.dispatch.attempts };
    await progress(ctx.dispatch.id, lease);
    let beat!: ReturnType<typeof progress>;
    // The take over's writes hold the dispatch row; the beat reads the old state, then its renewal waits.
    await t.services.db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({ status: 'taken_over', takenOverById: IDS.mara })
        .where(eq(runs.id, 'run_1907'));
      await tx
        .update(dispatches)
        .set({ state: 'cancelled', finishedAt: new Date(), error: 'taken_over' })
        .where(eq(dispatches.id, ctx.dispatch.id));
      beat = progress(ctx.dispatch.id, lease);
      await waitFor(
        async () => {
          const [row] = await t.services.db.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
          );
          return (row?.n ?? 0) > 0;
        },
        10_000,
        'the beat to wait for the row',
      );
    });
    expect(await beat).toEqual({
      cancel: true,
      reason: 'taken_over',
    });
  });
});

describe('failures, retries and leases', () => {
  it('retries a crashed turn once after a backoff, then fails it and says why (essentials-agents.md EA-08)', async () => {
    await drain();
    const trigger = await say(IDS.mara, IDS.incidents, '@Dusty anything odd overnight?');
    const first = await claim();
    expect(first?.dispatch.messageId).toBe(trigger);
    if (!first) return;
    const failedAt = Date.now();
    await complete(first.dispatch.id, { outcome: 'failed', error: 'claude exited with code 1' });
    const requeued = await dispatchRow(first.dispatch.id);
    expect(requeued).toMatchObject({ state: 'queued', attempts: 1, runnerId: null });
    // Not before the backoff (40 ms here) counted from when the turn failed.
    expect(requeued.notBefore?.getTime()).toBeGreaterThanOrEqual(failedAt + 40);

    const retry = await claim(500);
    expect(retry?.dispatch.id).toBe(first.dispatch.id);
    expect((await dispatchRow(first.dispatch.id)).attempts).toBe(2);
    await complete(first.dispatch.id, { outcome: 'failed', error: 'claude exited with code 1' });
    expect(await dispatchRow(first.dispatch.id)).toMatchObject({ state: 'failed' });
    const [quiet] = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, IDS.incidents), eq(messages.authorId, IDS.dusty)))
      .orderBy(desc(messages.createdAt));
    // An older runner's crash without a classification: the server's own, with Try again.
    expect(quiet?.text).toBe(turnFailureText('internal'));
    expect(quiet?.card).toMatchObject({
      kind: 'turn_failed',
      code: 'internal',
      dispatchId: first.dispatch.id,
    });
  });

  it('a refusal is final at once; the agent says why, without the host path it names (EA-08)', async () => {
    await drain();
    await say(IDS.mara, IDS.incidents, '@Dusty check the clone');
    const ctx = await claim();
    if (!ctx) throw new Error('no claim');
    const refusal =
      'I work directly in ~/Code/billing, and it has uncommitted changes. Commit or stash them, then ask me again.';
    await complete(ctx.dispatch.id, { outcome: 'failed', error: 'clone_dirty', refusal });
    expect(await dispatchRow(ctx.dispatch.id)).toMatchObject({ state: 'failed', attempts: 1 });
    const [said] = await t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, IDS.incidents), eq(messages.authorId, IDS.dusty)))
      .orderBy(desc(messages.createdAt));
    // The refusal names a host path: the room gets the public sentence, the person the refusal in the Work view.
    expect(said?.text).toBe(turnFailureText('workspace'));
    expect((await dispatchRow(ctx.dispatch.id)).failure?.detail).toContain(refusal);
  });

  it('a runner shutting down requeues its turn without counting a crash', async () => {
    await drain();
    await say(IDS.mara, IDS.incidents, '@Dusty one more thing');
    const ctx = await claim();
    if (!ctx) throw new Error('no claim');
    expect(ctx.dispatch.postedAt).toBeNull();
    // It had already posted: the retry is told so (it carries on instead of answering again).
    await t.services.runtime.markPosted(ctx.dispatch.id);
    await complete(ctx.dispatch.id, { outcome: 'failed', error: RUNNER_SHUTDOWN });
    expect(await dispatchRow(ctx.dispatch.id)).toMatchObject({
      state: 'queued',
      attempts: 0,
      notBefore: null,
    });
    const again = await claim();
    expect(again?.dispatch.id).toBe(ctx.dispatch.id);
    expect(again?.dispatch.postedAt).toEqual(expect.any(String));
    if (again) await complete(again.dispatch.id, { outcome: 'done' });
  });

  it('requeues a dispatch whose lease expired (runner gone) and fails it after the retry', async () => {
    await drain();
    Object.assign(t.services.runtime.options, { leaseMs: 30 });
    try {
      await say(IDS.mara, IDS.incidents, '@Dusty are you there?');
      const ctx = await claim();
      if (!ctx) throw new Error('no claim');
      // Sweep until the lease has run out: this sweep or the background sweeper requeues it.
      const swept = async (state: string) => {
        await t.services.runtime.sweep();
        const row = await dispatchRow(ctx.dispatch.id);
        return row.state === state ? row : null;
      };
      const requeued = await waitFor(() => swept('queued'), 10_000, 'the expired lease to requeue it');
      expect(requeued).toMatchObject({ error: 'lease_expired', runnerId: null });
      const again = await claim(500);
      expect(again?.dispatch.id).toBe(ctx.dispatch.id);
      const failed = await waitFor(() => swept('failed'), 10_000, 'the second expiry to fail it');
      expect(failed).toMatchObject({ error: 'lease_expired' });
    } finally {
      Object.assign(t.services.runtime.options, { leaseMs: 60_000 });
    }
  });

  it('a runner that lost its lease can neither cancel, fail, finish nor renew the dispatch', async () => {
    await drain();
    Object.assign(t.services.runtime.options, { leaseMs: 30 });
    const url = (id: string, what: string) => `/internal/runner/dispatches/${id}/${what}`;
    try {
      await say(IDS.mara, IDS.incidents, '@Dusty did the backup run?');
      const first = await claim();
      if (!first) throw new Error('no claim');
      // The lease a runner holds: which runner, which claim.
      const stale = { runnerId: RUNNER, attempt: 1 };
      // The runner goes quiet (laptop sleep); its lease expires and the dispatch is requeued.
      await new Promise((r) => setTimeout(r, 60));
      expect(await t.services.runtime.sweep()).toBe(1);
      Object.assign(t.services.runtime.options, { leaseMs: 60_000 });

      // It wakes up: progress tells it to stop, and its "cancelled" changes nothing.
      expect(await progress(first.dispatch.id, stale)).toEqual({ cancel: true, reason: 'cancelled' });
      const cancelled = await post(url(first.dispatch.id, 'complete'), { outcome: 'cancelled', ...stale });
      expect(await dispatchRow(first.dispatch.id)).toMatchObject({ state: 'queued', runnerId: null });
      expect(cancelled.statusCode).toBe(409);
      expect(first.dispatch).toMatchObject({ runnerId: RUNNER, attempts: 1 });

      // Another runner claims it; the stale runner can neither renew that lease nor fail the dispatch.
      const other = await post('/internal/runner/claim', {
        runnerId: 'rnr_other',
        providers: ['claude'],
        waitMs: 500,
      });
      const second = runnerApi.claim.response.parse(other.json()).dispatch;
      expect(second?.dispatch).toMatchObject({ id: first.dispatch.id, runnerId: 'rnr_other', attempts: 2 });
      const leased = await dispatchRow(first.dispatch.id);
      expect(await progress(first.dispatch.id, stale)).toEqual({ cancel: true, reason: 'cancelled' });
      const failed = await post(url(first.dispatch.id, 'complete'), {
        outcome: 'failed',
        error: 'claude exited with code 1',
        ...stale,
      });
      expect(failed.statusCode).toBe(409);
      const creds = await post(url(first.dispatch.id, 'git-credentials'), {
        repo: 'whombat/billing',
        branch: 'feat/invoice-pdf',
        operation: 'fetch',
        ...stale,
      });
      expect(creds.statusCode).toBe(409);
      expect(await dispatchRow(first.dispatch.id)).toMatchObject({
        state: 'claimed',
        runnerId: 'rnr_other',
        attempts: 2,
        leaseExpiresAt: leased.leaseExpiresAt,
      });

      // The runner holding the lease finishes it.
      const current = { runnerId: 'rnr_other', attempt: 2 };
      expect(await progress(first.dispatch.id, current)).toEqual({ cancel: false, reason: null });
      await complete(first.dispatch.id, { outcome: 'done', ...current });
      expect(await dispatchRow(first.dispatch.id)).toMatchObject({ state: 'done' });
    } finally {
      Object.assign(t.services.runtime.options, { leaseMs: 60_000 });
    }
  });

  it('heartbeats renew leases and list dispatches the runner must drop', async () => {
    await drain();
    await say(IDS.mara, IDS.billing, '@Dusty can you update the plan?');
    const ctx = await claim();
    if (!ctx) throw new Error('no claim');
    const before = (await dispatchRow(ctx.dispatch.id)).leaseExpiresAt?.getTime() ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    const res = await post('/internal/runner/heartbeat', {
      runnerId: RUNNER,
      active: [ctx.dispatch.id, 'dsp_unknown'],
    });
    expect(res.json()).toEqual({ cancel: ['dsp_unknown'] });
    expect((await dispatchRow(ctx.dispatch.id)).leaseExpiresAt?.getTime()).toBeGreaterThan(before);
    const other = await post('/internal/runner/heartbeat', {
      runnerId: 'rnr_other',
      active: [ctx.dispatch.id],
    });
    expect(other.json()).toEqual({ cancel: [ctx.dispatch.id] });
    await complete(ctx.dispatch.id, { outcome: 'done' });
  });

  it('an answer-mode turn that ends without an answer leaves the search screen with none', async () => {
    await drain();
    const asked = await t.commit(IDS.mara, askSearch, {
      q: 'have we seen this invoice rounding error before?',
    });
    if (asked.status !== 'ok') throw new Error('ask failed');
    const ctx = await claim();
    expect(ctx?.dispatch.mode).toBe('answer');
    expect(ctx?.search?.answerId).toBe(asked.result.answerId);
    expect(ctx?.search?.results.map((r) => r.id)).toContain('hist_thread-credit-note');
    if (!ctx) return;
    await complete(ctx.dispatch.id, { outcome: 'done' });
    const [answer] = await t.services.db
      .select()
      .from(searchAnswers)
      .where(eq(searchAnswers.id, asked.result.answerId));
    expect(answer?.status).toBe('none');
  });
});

describe('git credentials', () => {
  it('answers 501 without GitHub, and gives tokens only for the branch key', async () => {
    await drain();
    await say(IDS.mara, IDS.billing, '@Dusty push please');
    const ctx = await claim();
    if (!ctx) throw new Error('no claim');
    const host = t.services.runtime.gitHost;
    t.services.runtime.gitHost = null;
    const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/git-credentials`, {
      repo: 'whombat/billing',
      branch: 'feat/invoice-pdf',
      operation: 'push',
    });
    expect(res.statusCode).toBe(501);

    t.services.runtime.gitHost = host;
    try {
      const push = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/git-credentials`, {
        repo: 'whombat/billing',
        branch: 'feat/invoice-pdf',
        operation: 'push',
      });
      expect(push.statusCode).toBe(200);
      expect(runnerApi.gitCredentials.response.parse(push.json()).remoteUrl).toContain('whombat/billing');

      const main = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/git-credentials`, {
        repo: 'whombat/billing',
        branch: 'main',
        operation: 'push',
      });
      expect(main.statusCode).toBe(403);
      expect(main.json()).toMatchObject({ blocked: true, keyNeeded: { id: 'branch.main.push' } });

      const shared = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/git-credentials`, {
        repo: 'whombat/billing',
        branch: 'release/2026-10',
        operation: 'push',
        sha: 'c0ffee1234567890c0ffee1234567890c0ffee12',
      });
      expect(shared.statusCode).toBe(202);
      expect(shared.json()).toMatchObject({ approvalRequired: true });
      // A push of exactly that commit (essentials-agents.md EA-05), asked of the person where the turn was
      // (one-person.md OP-S62).
      const [asked] = await t.services.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, (shared.json() as { approvalId: string }).approvalId));
      expect(asked).toMatchObject({
        conversationId: ctx.dispatch.conversationId,
        title: 'Push c0ffee to release/2026-10',
        action: {
          type: 'push_shared_branch',
          params: {
            repo: 'whombat/billing',
            branch: 'release/2026-10',
            sha: 'c0ffee1234567890c0ffee1234567890c0ffee12',
          },
        },
      });
      // Asking again while it waits answers with the same request.
      const again = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/git-credentials`, {
        repo: 'whombat/billing',
        branch: 'release/2026-10',
        operation: 'push',
        sha: 'c0ffee1234567890c0ffee1234567890c0ffee12',
      });
      expect(again.statusCode).toBe(202);
      expect((again.json() as { approvalId: string }).approvalId).toBe(asked?.id);
    } finally {
      await complete(ctx.dispatch.id, { outcome: 'done' });
    }
    const blocked = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.actorId, IDS.dusty), eq(events.kind, 'Blocked')))
      .orderBy(asc(events.seq));
    expect(blocked.at(-1)?.text).toBe('Tried to push to main. Blocked.');
  });
});
