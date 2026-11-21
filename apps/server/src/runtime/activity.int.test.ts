/**
 * Observed activity on the server (docs/decisions/work-supervision.md WS-12…WS-16, WS-19): reports ride on the
 * lease-fenced progress beat and become one row per action (created → updated → finished; duplicates and stale
 * reports ignored; a runner that lost its lease writes nothing); rows follow the run the turn starts; rows still
 * running are interrupted when a turn is requeued, ended, swept or the server restarts; `activity.updated` and
 * `dispatch.updated` reach only the conversation's members; `activity.list` pages by run, turn and conversation.
 */
import { type ActivityReport, type DispatchContext, runnerApi } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideApproval, requestApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { activities, dispatches, runs } from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_activity';
const frames: BusFrame[] = [];
let mara = '';

beforeAll(async () => {
  t.services.bus.onFrame((f) => frames.push(f));
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
  Object.assign(t.services.runtime.options, { retryBackoffMs: 0, pollMs: 20 });
});

beforeEach(() => {
  frames.length = 0;
});

const post = (url: string, payload: unknown) =>
  t.api.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });
const url = (id: string, what: string) => `/internal/runner/dispatches/${id}/${what}`;
const get = (path: string, cookie: string) =>
  t.api.inject({ method: 'GET', url: `/api/v1/burrows/burrow-hq${path}`, headers: { cookie } });

async function ask(conversationId: string, text: string): Promise<string> {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('send failed');
  const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, res.result.id));
  if (!d) throw new Error('no dispatch');
  return d.id;
}

async function claim(): Promise<DispatchContext> {
  const res = await post('/internal/runner/claim', {
    runnerId: RUNNER,
    providers: ['claude'],
    waitMs: 500,
  });
  const ctx = runnerApi.claim.response.parse(res.json()).dispatch;
  if (!ctx) throw new Error('nothing to claim');
  return ctx;
}

const report = (key: string, seq: number, over: Partial<ActivityReport> = {}): ActivityReport => ({
  key,
  seq,
  kind: 'command',
  tool: 'Bash',
  status: 'running',
  object: 'pnpm test',
  exitCode: null,
  failure: null,
  keyNeeded: null,
  approvalId: null,
  evidence: null,
  at: new Date().toISOString(),
  ...over,
});

async function beat(
  ctx: DispatchContext,
  reports: ActivityReport[],
  lease?: { runnerId: string; attempt: number },
) {
  const res = await post(url(ctx.dispatch.id, 'progress'), {
    state: 'running',
    activity: reports,
    ...(lease ?? { runnerId: RUNNER, attempt: ctx.dispatch.attempts }),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { cancel: boolean };
}

const rowsOf = (dispatchId: string) =>
  t.services.db
    .select()
    .from(activities)
    .where(eq(activities.dispatchId, dispatchId))
    .orderBy(activities.key);

const activityFrames = () => frames.filter((f) => f.event.type === 'activity.updated');
const dispatchStates = (id: string) =>
  frames.flatMap((f) =>
    f.event.type === 'dispatch.updated' && f.event.dispatch.id === id ? [f.event.dispatch.state] : [],
  );

describe('progress with activity', () => {
  it('publishes one running transition while concurrent first beats retain every activity report', async () => {
    const id = await ask(IDS.billing, '@Dusty check the billing tools please');
    const ctx = await claim();
    expect(ctx.dispatch.id).toBe(id);

    // Both first beats must load "claimed" before either enters its transaction.
    // The app-only fixture has no background runtime loops; restore the real
    // pipeline before checking or completing the turn.
    const original = t.services.pipeline.transactAccount.bind(t.services.pipeline);
    let entered = 0;
    let release: () => void = () => undefined;
    const bothLoaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: typeof t.services.pipeline.transactAccount = async (fn) => {
      if (entered < 2) {
        entered++;
        if (entered === 2) release();
        await bothLoaded;
      }
      return original(fn);
    };
    const gate = vi.spyOn(t.services.pipeline, 'transactAccount').mockImplementation(gated);
    let responses: { cancel: boolean }[];
    try {
      responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) => beat(ctx, [report(`1:parallel-${index}`, index + 1)])),
      );
    } finally {
      gate.mockRestore();
    }
    expect(responses.every((response) => !response.cancel)).toBe(true);
    const rows = await rowsOf(id);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.key)).size).toBe(8);
    expect(rows.every((row) => row.status === 'running')).toBe(true);
    expect(dispatchStates(id)).toEqual(['queued', 'claimed', 'running']);

    await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
    expect(dispatchStates(id)).toEqual(['queued', 'claimed', 'running', 'done']);
  });

  it('one row per action through its lifecycle; stale, duplicate and lost-lease reports change nothing', async () => {
    const id = await ask(IDS.billing, '@Dusty run the billing tests please');
    const ctx = await claim();
    expect(ctx.dispatch.id).toBe(id);

    await beat(ctx, [report('1:t1', 1)]);
    let [row] = await rowsOf(id);
    expect(row).toMatchObject({
      key: '1:t1',
      attempt: 1,
      seq: 1,
      status: 'running',
      title: 'Running pnpm test',
      agentId: IDS.dusty,
      conversationId: IDS.billing,
      runId: null,
      finishedAt: null,
    });

    await beat(ctx, [report('1:t1', 2, { status: 'failed', exitCode: 1, failure: 'error' })]);
    [row] = await rowsOf(id);
    expect(row).toMatchObject({
      seq: 2,
      status: 'failed',
      title: 'Command failed',
      detail: 'exit 1',
      important: true,
    });
    expect(row?.finishedAt).not.toBeNull();
    const rev = row?.rev;

    // The old “running” report arriving late, and the same report twice: ignored.
    frames.length = 0;
    await beat(ctx, [report('1:t1', 1), report('1:t1', 2, { status: 'done' })]);
    [row] = await rowsOf(id);
    expect(row).toMatchObject({ seq: 2, status: 'failed', rev });
    expect(activityFrames()).toHaveLength(0);

    // A runner that lost its lease (another claim) is told to stop and writes nothing.
    const stale = await beat(ctx, [report('1:t1', 9, { status: 'done' }), report('1:t9', 10)], {
      runnerId: 'rnr_someone_else',
      attempt: ctx.dispatch.attempts ?? 1,
    });
    expect(stale.cancel).toBe(true);
    expect(await rowsOf(id)).toHaveLength(1);
    expect((await rowsOf(id))[0]).toMatchObject({ seq: 2, status: 'failed' });

    // Frames: on the conversation topic.
    frames.length = 0;
    await beat(ctx, [report('1:t2', 3, { kind: 'read', tool: 'Read', object: 'billing/pdf/render.ts' })]);
    const [frame] = activityFrames();
    expect(frame).toMatchObject({ topic: `conv:${IDS.billing}` });
    expect(frame?.event.type === 'activity.updated' && frame.event.activity.title).toBe('Reading render.ts');
    await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
  });

  it('a command that printed NUL bytes keeps the beat (and the lease): its row is stored without them (FS-D10)', async () => {
    const id = await ask(IDS.billing, '@Dusty look at the model file please');
    const ctx = await claim();
    expect(ctx.dispatch.id).toBe(id);
    const output = 'VFF\u0000\u0000 header \uD800 PID ELAPSED RSS COMMAND';
    await beat(ctx, [
      report('1:nul', 1, {
        status: 'done',
        exitCode: 0,
        object: 'head -c 64 model.skp\u0000',
        evidence: { input: 'head -c 64 model.skp', output, truncated: false },
      }),
    ]);
    const [row] = await rowsOf(id);
    expect(row?.object).toBe('head -c 64 model.skp');
    expect(row?.evidence).toEqual({
      input: 'head -c 64 model.skp',
      output: 'VFF header \uFFFD PID ELAPSED RSS COMMAND',
      truncated: false,
    });
    const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
    expect(d?.heartbeatAt).not.toBeNull();
    await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
  });

  it('links an approval only when this agent asked for it, and a waiting row follows the approval', async () => {
    const id = await ask(IDS.billing, '@Dusty deploy it please');
    const ctx = await claim();
    expect(ctx.dispatch.id).toBe(id);
    // apr_staging-482 is Dusty's own: linked. The same id reported by another agent's turn would not be.
    await beat(ctx, [
      report('1:w', 1, {
        kind: 'whombat',
        tool: 'whombat.request_approval',
        status: 'waiting',
        object: null,
        approvalId: 'apr_staging-482',
      }),
      report('1:bad', 2, {
        kind: 'whombat',
        tool: 'whombat.perform_action',
        status: 'waiting',
        approvalId: 'apr_nope',
      }),
    ]);
    const rows = await rowsOf(id);
    expect(rows.find((r) => r.key === '1:w')).toMatchObject({
      approvalId: 'apr_staging-482',
      title: 'Waiting for approval',
    });
    expect(rows.find((r) => r.key === '1:bad')?.approvalId).toBeNull();
    const list = await get(`/activity?dispatchId=${id}`, mara);
    const w = (
      list.json() as { activities: { key: string; link: unknown; detail: string }[] }
    ).activities.find((a) => a.key === '1:w');
    expect(w).toMatchObject({ link: { type: 'approval', number: 12 }, detail: 'approval #12' });

    // Ending the turn interrupts what still runs, never a row waiting on an approval (it follows the approval).
    await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
    const after = await rowsOf(id);
    expect(after.find((r) => r.key === '1:w')?.status).toBe('waiting');
    expect(after.find((r) => r.key === '1:bad')).toMatchObject({
      status: 'interrupted',
      detail: 'the turn stopped',
    });
    expect(dispatchStates(id)).toEqual(['queued', 'claimed', 'running', 'done']);
  });

  it('attaches the run the turn starts, to earlier rows too, and frames them on the run topic', async () => {
    const id = await ask(IDS.billing, '@Dusty start on the export endpoint');
    const ctx = await claim();
    await beat(ctx, [report('1:a', 1, { kind: 'read', tool: 'Read', object: 'a.ts', status: 'done' })]);
    expect((await rowsOf(id))[0]?.runId).toBeNull();
    // The turn starts a run (start_run records the dispatch on it).
    await t.services.db.insert(runs).values({
      id: 'run_act1',
      burrowId: t.burrowId,
      number: 3001,
      agentId: IDS.dusty,
      title: 'Export endpoint',
      branch: 'feat/export',
      status: 'live',
      askedById: IDS.mara,
      conversationId: IDS.billing,
      dispatchId: id,
      startedAt: new Date(),
    });
    frames.length = 0;
    await beat(ctx, [report('1:b', 2)]);
    expect((await rowsOf(id)).map((r) => [r.key, r.runId])).toEqual([
      ['1:a', 'run_act1'],
      ['1:b', 'run_act1'],
    ]);
    expect(activityFrames().filter((f) => f.topic === 'run:run_act1')).toHaveLength(2);
    const list = await get('/activity?runNumber=3001', mara);
    expect((list.json() as { activities: unknown[]; reported: boolean }).reported).toBe(true);
    // Finished, so Whombat doesn't wake Dusty for a run left live (run-checkout.md RC-11).
    await t.services.db.update(runs).set({ status: 'done' }).where(eq(runs.id, 'run_act1'));
    await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
    expect((await rowsOf(id)).find((r) => r.key === '1:b')?.status).toBe('interrupted');
  });
});

describe('interrupted, never done (WS-15)', () => {
  it('on a requeue after a crash, on a swept lease, and at boot for turns that no longer run', async () => {
    const id = await ask(IDS.incidents, '@Dusty is the backup ok?');
    let ctx = await claim();
    await beat(ctx, [report('1:x', 1)]);
    // The runner crashed: failed once, requeued (attempt 1 of 2).
    await post(url(id, 'complete'), {
      outcome: 'failed',
      error: 'claude exited',
      runnerId: RUNNER,
      attempt: 1,
    });
    expect((await rowsOf(id))[0]).toMatchObject({
      status: 'interrupted',
      title: 'Ran pnpm test · interrupted',
    });
    expect(dispatchStates(id)).toContain('queued');

    // Attempt 2 runs, then its runner goes silent: the sweep ends it and interrupts its rows.
    ctx = await claim();
    expect(ctx.dispatch).toMatchObject({ id, attempts: 2 });
    await beat(ctx, [report('2:y', 2, { kind: 'edit', tool: 'Edit', object: 'backup.ts' })]);
    // Attempt 1's key can't come back to life.
    await beat(ctx, [report('1:x', 3, { status: 'done' })]);
    await t.services.db
      .update(dispatches)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(dispatches.id, id));
    expect(await t.services.runtime.sweep()).toBeGreaterThanOrEqual(1);
    const rows = await rowsOf(id);
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ['1:x', 'interrupted'],
      ['2:y', 'interrupted'],
    ]);
    expect(rows[1]?.title).toBe('Edited backup.ts · interrupted');

    // A row left running by a turn that ended while the server was down: “· restarted” at boot.
    const [done] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, id));
    expect(done?.state).toBe('failed');
    await t.services.db
      .update(activities)
      .set({ status: 'running' })
      .where(and(eq(activities.dispatchId, id), eq(activities.key, '2:y')));
    expect(await t.services.runtime.interruptOrphans('restarted')).toBe(1);
    expect((await rowsOf(id)).find((r) => r.key === '2:y')).toMatchObject({
      status: 'interrupted',
      detail: 'restarted',
    });
  });
});

describe('visibility and activity.list (WS-16)', () => {
  it('members page through a turn, a run and a conversation; others get nothing over REST or realtime', async () => {
    const id = await ask(IDS.billing, '@Dusty review the PDF module');
    const ctx = await claim();
    await beat(ctx, [
      report('1:r1', 1, { kind: 'read', tool: 'Read', object: 'a.ts', status: 'done' }),
      report('1:r2', 2, { kind: 'read', tool: 'Read', object: 'b.ts', status: 'done' }),
      report('1:r3', 3, { kind: 'search', tool: 'Grep', object: 'vat', status: 'done' }),
    ]);
    const page1 = (await get(`/activity?dispatchId=${id}&limit=2`, mara)).json() as {
      activities: { key: string }[];
      cursor: string;
      hasMore: boolean;
      reported: boolean;
    };
    expect(page1.activities.map((a) => a.key)).toEqual(['1:r1', '1:r2']);
    expect(page1).toMatchObject({ hasMore: true, reported: true });
    const page2 = (
      await get(`/activity?dispatchId=${id}&limit=2&after=${page1.cursor}`, mara)
    ).json() as typeof page1;
    expect(page2.activities.map((a) => a.key)).toEqual(['1:r3']);
    expect(page2.hasMore).toBe(false);
    // An update moves a row past the cursor: a client catching up sees it again.
    await beat(ctx, [
      report('1:r1', 4, { kind: 'read', tool: 'Read', object: 'a.ts', status: 'failed', failure: 'error' }),
    ]);
    const page3 = (
      await get(`/activity?dispatchId=${id}&after=${page2.cursor}`, mara)
    ).json() as typeof page1;
    expect(page3.activities.map((a) => a.key)).toEqual(['1:r1']);

    const conv = (await get(`/activity?conversationId=${IDS.billing}`, mara)).json() as typeof page1;
    expect(conv.activities.some((a) => a.key === '1:r3')).toBe(true);

    expect((await get('/activity', mara)).statusCode).toBe(400);
    // Every activity and lifecycle frame goes out on its conversation's topic.
    for (const f of frames.filter(
      (x) => x.event.type === 'activity.updated' || x.event.type === 'dispatch.updated',
    ))
      expect(f.topic === `conv:${IDS.billing}` || f.topic.startsWith('run:')).toBe(true);

    // A turn without any rows: its provider reports none (WS-15).
    const quiet = await ask(IDS.billing, '@Dusty any thoughts?');
    const none = (await get(`/activity?dispatchId=${quiet}`, mara)).json() as typeof page1;
    expect(none).toMatchObject({ activities: [], reported: false, hasMore: false });

    await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
    const next = await claim();
    await post(url(next.dispatch.id, 'complete'), {
      outcome: 'done',
      runnerId: RUNNER,
      attempt: next.dispatch.attempts,
    });
  });

  it('a failed Whombat call says why, as the agent heard it; nothing else of a Whombat call is kept (RA-DS49)', async () => {
    const id = await ask(IDS.billing, '@Dusty hand the export to Dusty');
    const ctx = await claim();
    const SAY_WHICH = 'Say which plan (planId), or give conversationId and planTitle to make one.';
    const whombat = (key: string, seq: number, tool: string, over: Partial<ActivityReport> = {}) =>
      report(key, seq, {
        kind: 'whombat',
        tool,
        object: null,
        status: 'failed',
        failure: 'error',
        evidence: { input: null, output: SAY_WHICH, truncated: false },
        ...over,
      });
    await beat(ctx, [
      whombat('1:a', 1, 'whombat.start_run'),
      whombat('1:b', 2, 'whombat.start_run', {
        evidence: {
          input: null,
          output: `Dusty isn’t in this conversation. ${'Pick someone who is. '.repeat(10)}`,
          truncated: false,
        },
      }),
      // An ok call and a denial keep no evidence, whatever the runner sent.
      whombat('1:c', 3, 'whombat.post_message', {
        status: 'done',
        failure: null,
        evidence: { input: '{"text":"Mara’s salary"}', output: '{"status":"ok"}', truncated: false },
      }),
      whombat('1:d', 4, 'whombat.delegate', { failure: 'cancelled' }),
      // Saving a login sent in chat holds the secret in its input: the Vault's neutral row (vault-self-serve.md VS-14).
      whombat('1:h', 8, 'whombat.vault_save', {
        evidence: { input: '{"secret":"pl3x-Secret-pass!"}', output: '{"status":"ok"}', truncated: false },
      }),
      // A browser tool from a runner that calls it a Whombat row: the browser's rules (BT-03), no reason.
      whombat('1:g', 7, 'whombat.browser_navigate', {
        evidence: {
          input: null,
          output: 'https://intranet.example/salaries is on a private network.',
          truncated: false,
        },
      }),
    ]);
    const rows = new Map((await rowsOf(id)).map((r) => [r.key, r]));
    expect(rows.get('1:a')).toMatchObject({
      title: 'Starting a run failed',
      detail: SAY_WHICH,
      evidence: { input: null, output: SAY_WHICH, truncated: false },
      important: true,
    });
    const long = rows.get('1:b');
    expect(long?.detail).toHaveLength(160);
    expect(long?.detail?.endsWith('…')).toBe(true);
    expect(long?.evidence?.output?.startsWith('Dusty isn’t in this conversation. Pick someone who is.')).toBe(
      true,
    );
    expect(rows.get('1:c')).toMatchObject({ status: 'done', detail: null, evidence: null });
    expect(rows.get('1:d')).toMatchObject({ failure: 'cancelled', detail: 'cancelled', evidence: null });
    expect(rows.get('1:g')).toMatchObject({ detail: null, evidence: null });
    expect(rows.get('1:h')).toMatchObject({ tool: 'whombat.vault_request', detail: null, evidence: null });
    expect(JSON.stringify(rows.get('1:h'))).not.toContain('pl3x-Secret-pass!');
    // Members see it in the activity list.
    const listed = await get(`/activity?dispatchId=${id}`, mara);
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { activities: { key: string; detail: string | null }[] }).activities.find(
        (a) => a.key === '1:a',
      ),
    ).toMatchObject({ detail: SAY_WHICH });
    await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
  });

  it('a Feedback assessment’s rows keep kind and state only, whatever the runner sent', async () => {
    const id = await ask(IDS.billing, '@Dusty look');
    const ctx = await claim();
    await t.services.db.update(dispatches).set({ trigger: 'feedback' }).where(eq(dispatches.id, id));
    await beat(ctx, [
      report('1:f', 1, {
        object: 'cat .env',
        exitCode: 2,
        evidence: { input: 'cat .env', output: 'SECRET', truncated: false },
      }),
    ]);
    expect((await rowsOf(id))[0]).toMatchObject({
      object: null,
      evidence: null,
      exitCode: null,
      kind: 'command',
    });
    await t.services.db.update(dispatches).set({ trigger: 'mention' }).where(eq(dispatches.id, id));
    await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
  });
});

it('publishes approval-derived activity changes and advances the incremental cursor', async () => {
  const id = await ask(IDS.billing, '@Dusty ask before continuing');
  const ctx = await claim();
  expect(ctx.dispatch.id).toBe(id);
  const asked = await t.commit(IDS.dusty, requestApproval, {
    conversationId: IDS.billing,
    action: { type: 'custom', params: { name: 'continue the work', keyId: 'deploy.staging', data: {} } },
    whatHappens: ['Continue the saved work'],
    explainer: '',
    summary: '',
  });
  if (asked.status !== 'ok') throw new Error('No approval');
  await beat(ctx, [
    report('approval-projection', 1, {
      kind: 'whombat',
      tool: 'whombat.request_approval',
      status: 'waiting',
      approvalId: asked.result.approvalId,
    }),
  ]);
  const before = (await get(`/activity?dispatchId=${id}`, mara)).json();
  const waiting = before.activities.find((a: { key: string }) => a.key === 'approval-projection');
  expect(waiting.status).toBe('waiting');
  await t.commit(IDS.mara, decideApproval, { number: asked.result.number, decision: 'approve' });
  const updates = frames.flatMap((f) =>
    f.event.type === 'activity.updated' && f.event.activity.id === waiting.id ? [f.event.activity] : [],
  );
  const done = updates.at(-1);
  expect(done).toMatchObject({ id: waiting.id, status: 'done', seq: waiting.seq });
  if (!done) throw new Error('No activity update');
  expect(Date.parse(done.updatedAt)).toBeGreaterThan(Date.parse(waiting.updatedAt));
  const caughtUp = (await get(`/activity?dispatchId=${id}&after=${before.cursor}`, mara)).json();
  expect(caughtUp.activities).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: waiting.id, status: 'done' })]),
  );
  expect(Number(caughtUp.cursor)).toBeGreaterThan(Number(before.cursor));
  await post(url(id, 'complete'), { outcome: 'done', runnerId: RUNNER, attempt: ctx.dispatch.attempts });
});
