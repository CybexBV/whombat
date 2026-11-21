/**
 * `work.overview` (docs/decisions/work-supervision.md WS-18, WS-19) against the seeded burrow: sections from existing
 * state, the viewer's own controls, only their rooms, and health — progressing, quiet (heartbeat current, nothing
 * new), waiting and stalled (no heartbeat for longer than the lease) — plus why a turn is still queued.
 */
import { type DispatchContext, runnerApi, type WorkItem, type WorkOverview } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { createPlan, startPlanStep } from '../commands/plans';
import { pauseRun } from '../commands/runs';
import { activities, dispatches, messages, principals } from '../db/schema/index';
import { followDispatch } from '../domain/plan-follow';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { loadPlan } from './work';

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_work';
let cookie = '';

beforeAll(async () => {
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  Object.assign(t.services.runtime.options, { pollMs: 20 });
});

const post = (url: string, payload: unknown) =>
  t.api.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });

async function overview(): Promise<WorkOverview> {
  const res = await t.api.inject({
    method: 'GET',
    url: '/api/v1/burrows/burrow-hq/work',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as WorkOverview;
}

function find(o: WorkOverview, id: string): (WorkItem & { section: string }) | undefined {
  for (const s of o.sections) for (const i of s.items) if (i.id === id) return i;
  return undefined;
}

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

describe('work.overview', () => {
  it('needs you: approvals the viewer can decide and gate steps that are theirs', async () => {
    const mara = await overview();
    expect(mara.sections.map((s) => s.section)).toEqual([
      'needs_you',
      'running',
      'queued',
      'blocked',
      'failed',
      'done',
    ]);
    expect(find(mara, 'approval:apr_staging-482')).toMatchObject({
      section: 'needs_you',
      kind: 'approval',
      title: 'Deploy feat/invoice-pdf to staging',
      where: 'billing-v2',
      status: { text: 'NEEDS A PERSON', tone: 'warn' },
      actions: ['approve', 'decline', 'open'],
      link: { type: 'approval', number: 12 },
      refs: { approvalNumber: 12, approvalId: 'apr_staging-482', conversationId: IDS.billing },
    });
    // The step approval #12 gates is hers too, but the approval is already her item: one decision, one item.
    expect(find(mara, 'plan_step:pln_invoice-pdf:stp_pdf-4')).toBeUndefined();
    // The seeded live run, with no turn behind it: no heartbeat, so stalled — never “failed”.
    expect(find(mara, 'run:run_1907')).toMatchObject({
      section: 'running',
      actions: ['pause', 'take_over', 'open'],
      health: { state: 'stalled' },
    });
    expect(mara.counts.needs_you).toBeGreaterThanOrEqual(1);
  });

  it('health: progressing, quiet and stalled are different; queued says why', async () => {
    const id = await ask(IDS.billing, '@Dusty please look at the cache');
    let o = await overview();
    // Queued: a runner is connected (this suite claims as one) and runs the agent's provider.
    expect(find(o, `dispatch:${id}`)).toMatchObject({
      section: 'queued',
      status: { text: 'QUEUED · WAITING FOR A RUNNER' },
    });

    const ctx = await claim();
    expect(ctx.dispatch.id).toBe(id);
    await post(`/internal/runner/dispatches/${id}/progress`, {
      state: 'running',
      runnerId: RUNNER,
      attempt: 1,
      activity: [
        {
          key: '1:c',
          seq: 1,
          kind: 'command',
          tool: 'Bash',
          status: 'running',
          object: 'pnpm test',
          at: new Date().toISOString(),
        },
      ],
    });
    o = await overview();
    const running = find(o, `dispatch:${id}`);
    expect(running).toMatchObject({
      section: 'running',
      status: { text: 'WORKING' },
      health: { state: 'progressing' },
      activity: { title: 'Running pnpm test' },
      detail: 'Running pnpm test',
    });

    // Nothing new for 6 minutes, but the runner's heartbeat is current: quiet, not failed.
    await t.services.db
      .update(activities)
      .set({ updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(activities.dispatchId, id));
    o = await overview();
    expect(find(o, `dispatch:${id}`)?.health).toMatchObject({
      state: 'quiet',
      text: 'Working quietly · last step 6 min ago',
    });

    // No heartbeat for longer than the lease: stalled (the sweep then retries or fails it).
    await t.services.db
      .update(dispatches)
      .set({ heartbeatAt: new Date(Date.now() - 3 * 60_000) })
      .where(eq(dispatches.id, id));
    o = await overview();
    expect(find(o, `dispatch:${id}`)?.health).toMatchObject({
      state: 'stalled',
      text: 'No word from the runner for 3 min',
    });

    // A second turn of the same agent here waits for the first.
    const next = await ask(IDS.billing, '@Dusty and then the footer');
    o = await overview();
    expect(find(o, `dispatch:${next}`)).toMatchObject({
      section: 'queued',
      status: { text: 'QUEUED' },
      detail: 'After Dusty’s current turn here.',
    });
    // The agent on a provider no runner has (a later message of Mara's here joins her queued turn).
    await t.services.db
      .update(principals)
      .set({ runtime: { provider: 'codex' } })
      .where(eq(principals.id, IDS.dusty));
    o = await overview();
    expect(find(o, `dispatch:${next}`)).toMatchObject({ status: { text: 'QUEUED · PROVIDER NOT READY' } });
    await t.services.db.update(principals).set({ runtime: null }).where(eq(principals.id, IDS.dusty));

    // Done: the turn did observable work, so it shows in RECENTLY DONE.
    await post(`/internal/runner/dispatches/${id}/complete`, {
      outcome: 'done',
      runnerId: RUNNER,
      attempt: 1,
    });
    o = await overview();
    expect(find(o, `dispatch:${id}`)).toMatchObject({
      section: 'done',
      status: { text: 'DONE', tone: 'ok' },
    });
    const second = await claim();
    await post(`/internal/runner/dispatches/${second.dispatch.id}/complete`, {
      outcome: 'failed',
      error: 'boom',
      refusal: 'The host is not ready.',
      runnerId: RUNNER,
      attempt: second.dispatch.attempts,
    });
    o = await overview();
    expect(find(o, `dispatch:${second.dispatch.id}`)).toMatchObject({
      section: 'failed',
      status: { text: 'FAILED' },
    });
  });

  it('blocked: a paused run offers resume and take over; an agent’s open question needs a reply', async () => {
    const paused = await t.commit(IDS.mara, pauseRun, { number: 1907 });
    expect(paused.status).toBe('ok');
    let o = await overview();
    expect(find(o, 'run:run_1907')).toMatchObject({
      section: 'blocked',
      status: { text: 'PAUSED' },
      actions: ['resume', 'take_over', 'open'],
    });

    const asked = await t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.billing,
      text: 'Should the PDF show VAT per line or only in total?',
    });
    if (asked.status !== 'ok') throw new Error('send failed');
    await t.services.db.update(messages).set({ asks: true }).where(eq(messages.id, asked.result.id));
    o = await overview();
    expect(find(o, `question:${asked.result.id}`)).toMatchObject({
      section: 'needs_you',
      kind: 'question',
      agentId: IDS.dusty,
      actions: ['reply', 'open'],
      link: { type: 'message', messageId: asked.result.id },
    });
    // A person answered: no longer open (AS-03).
    await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text: 'Per line, please.' });
    o = await overview();
    expect(find(o, `question:${asked.result.id}`)).toBeUndefined();
  });

  it('a step someone started that asks to check its result is theirs; the approval item says what it waits for', async () => {
    const made = await t.commit(IDS.mara, createPlan, {
      conversationId: IDS.billing,
      title: 'Starter check',
      steps: [{ title: 'Write the rounding note' }],
    });
    if (made.status !== 'ok') throw new Error('no plan');
    const planId = made.result.planId as string;
    const plan = await loadPlan(t.services.db, planId);
    const stepId = plan?.steps[0]?.id as string;
    const started = await t.commit(IDS.mara, startPlanStep, { planId, stepId });
    if (started.status !== 'ok') throw new Error('not started');
    const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.planStepId, stepId));
    if (!d) throw new Error('no turn');
    // The turn ends without a run: the step asks a person to check the result.
    await t.services.db
      .update(dispatches)
      .set({ state: 'done', finishedAt: new Date() })
      .where(eq(dispatches.id, d.id));
    await followDispatch(t.services, d);
    expect((await loadPlan(t.services.db, planId))?.steps[0]).toMatchObject({
      state: 'gate',
      stateLabel: 'Check result',
    });
    // Mara started it: it's hers to check.
    expect(find(await overview(), `plan_step:${planId}:${stepId}`)).toMatchObject({
      section: 'needs_you',
    });
    // The approval item's detail is the inbox's sentence, not the question again.
    const approval = find(await overview(), 'approval:apr_staging-482');
    expect(approval?.detail).toMatch(/^Deploy feat\/invoice-pdf to staging\./);
    expect(approval?.detail).not.toBe('Deploy feat/invoice-pdf to staging?');
  });
});
