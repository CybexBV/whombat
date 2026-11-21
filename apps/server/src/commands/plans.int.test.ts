/**
 * Plans (docs/decisions/work-supervision.md WS-01…WS-10, WS-20): making them, editing after work started, handing
 * steps out through the ordinary mention dispatch, and steps following their linked work — idempotently.
 */
import { api, buildPath } from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyPlanEdit } from '../collab/commands';
import { applyContext, loadBurrowRow } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import {
  canvases,
  dispatches,
  events,
  grants,
  messages,
  notifications,
  plans,
  runs,
} from '../db/schema/index';
import { followDispatch, followPlanWork, reconcilePlans } from '../domain/plan-follow';
import { loadPrincipalRow, toActor } from '../read/principals';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { finishRun, runStep, startRun } from './agent-runs';
import { decideApproval } from './approvals';
import {
  addPlanStep,
  createPlan,
  createPlanCanvas,
  removePlanStep,
  startPlanStep,
  updatePlan,
  updatePlanStep,
} from './plans';
import { pauseRun, resumeRun, takeOverRun } from './runs';

const t = useTestServer({ seed: true, listen: true, env: signInsEnv() });
// Runs need a checkout: agents' git runs on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));

function ok<R>(res: { status: string; result?: R }): R {
  expect(res.status).toBe('ok');
  return (res as { result: R }).result;
}

async function plan(id: string) {
  const [row] = await t.services.db.select().from(plans).where(eq(plans.id, id));
  if (!row) throw new Error('no plan');
  return row;
}

async function step(planId: string, index: number) {
  return (await plan(planId)).steps[index] as NonNullable<Awaited<ReturnType<typeof plan>>['steps'][number]>;
}

async function planEvents(planId: string) {
  return t.services.db
    .select()
    .from(events)
    .where(
      sql`${events.type} in ('plan.created', 'plan.updated') and ${events.payload}->>'planId' = ${planId}`,
    )
    .orderBy(events.seq);
}

async function newPlan(actorId: string = IDS.mara, over: Record<string, unknown> = {}) {
  return ok(
    await t.commit(actorId, createPlan, {
      conversationId: IDS.billing,
      title: 'Refund flow',
      steps: [{ title: 'Write the spec' }, { title: 'Build the endpoint' }, { title: 'Review it' }],
      ...over,
    }),
  );
}

/** Runs `fn` as Mara inside a commit (the collab service's path into `applyPlanEdit`). */
async function asMara<R>(fn: (ctx: ApplyContext) => Promise<R>): Promise<R> {
  const { result } = await t.services.pipeline.transact(t.burrowId, async (session) => {
    const burrow = await loadBurrowRow(session.tx, t.burrowId);
    const actor = await loadPrincipalRow(session.tx, IDS.mara);
    if (!burrow || !actor) throw new Error('seed');
    const now = t.services.clock();
    return fn(
      applyContext(session, {
        burrow,
        actor: toActor(actor),
        now,
        at: now.toISOString(),
        decision: null,
        requirement: null,
        approvalId: null,
        onBehalfOf: {},
      }),
    );
  });
  return result;
}

async function rest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  who: string = IDS.mara,
) {
  const { cookie } = await sessionFor(t.services, who);
  const res = await t.api.inject({
    method,
    url: `/api/v1${path}`,
    headers: { cookie },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('making a plan (WS-01, WS-10)', () => {
  it('posts its card in the source message’s thread and remembers who, when and where from', async () => {
    const made = await newPlan(IDS.mara, { sourceMessageId: 'msg_billing-priya-0912' });
    const row = await plan(made.planId);
    expect(row).toMatchObject({
      createdById: IDS.mara,
      sourceMessageId: 'msg_billing-priya-0912',
      sourceThreadRootId: 'msg_billing-priya-0912',
      messageId: made.messageId,
      conversationId: IDS.billing,
    });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.steps.map((s) => s.state)).toEqual(['queued', 'queued', 'queued']);
    const [card] = await t.services.db.select().from(messages).where(eq(messages.id, made.messageId));
    expect(card).toMatchObject({
      threadRootId: 'msg_billing-priya-0912',
      card: { kind: 'plan', planId: made.planId },
    });
    // Starting nothing: no dispatch for anyone.
    const [queued] = await t.services.db.select().from(dispatches).where(eq(dispatches.planId, made.planId));
    expect(queued).toBeUndefined();
    const [created] = await planEvents(made.planId);
    expect(created).toMatchObject({
      type: 'plan.created',
      text: 'Made the plan “Refund flow”',
      where: 'billing-v2',
    });
  });

  it('keeps a DM plan’s title out of the burrow’s log', async () => {
    const made = ok(
      await t.commit(IDS.mara, createPlan, {
        conversationId: IDS.dmDusty,
        title: 'Secret birthday plan',
        steps: [{ title: 'Order the cake' }],
      }),
    );
    await t.commit(IDS.mara, updatePlanStep, {
      planId: made.planId,
      stepId: (await step(made.planId, 0)).id,
      state: 'done',
      note: 'Chocolate',
    });
    const logged = await planEvents(made.planId);
    expect(logged.map((e) => e.text)).toEqual(['Made a plan', 'Updated a plan']);
    expect(JSON.stringify(logged)).not.toMatch(/birthday|cake|Chocolate/i);
  });

  it('lets the agent plan its own work without a key (one-agent.md OA-S41)', async () => {
    await t.services.db
      .delete(grants)
      .where(and(eq(grants.agentId, IDS.dusty), eq(grants.keyId, 'tasks.create')));
    const own = await newPlan(IDS.dusty);
    expect((await plan(own.planId)).createdById).toBe(IDS.dusty);
  });

  it('the person’s turn reads plans of another room; an outsiders’ turn none, not even its own room’s (outsiders-turns.md OT-03)', async () => {
    const inIncidents = ok(
      await t.commit(IDS.mara, createPlan, {
        conversationId: IDS.incidents,
        title: 'Incident follow-up',
        steps: [{ title: 'Postmortem' }],
      }),
    );
    const inBilling = await newPlan();
    const read = async (planId: string, onBehalfOfAccountId?: null) => {
      const turn = await agentTokenFor(
        t.services,
        t.burrowId,
        IDS.dusty,
        IDS.billing,
        onBehalfOfAccountId === null ? { onBehalfOfAccountId } : {},
      );
      const dusty = await mcpClient(t.baseUrl, turn.token);
      try {
        return (await dusty.call('plan_read', { planId })).isError;
      } finally {
        await dusty.close();
      }
    };
    expect(await read(inIncidents.planId)).toBe(false);
    expect(await read(inIncidents.planId, null)).toBe(true);
    expect(await read(inBilling.planId, null)).toBe(true);
    expect(await read(inBilling.planId)).toBe(false);
  });

  it('creates, edits and lists plans over REST', async () => {
    const b = { burrow: 'burrow-hq' };
    const made = await rest('POST', buildPath(api.plans.create.path, b), {
      conversationId: IDS.billing,
      title: 'Over REST',
      steps: [{ title: 'One' }],
      canvas: true,
    });
    expect(made.status).toBe(201);
    const p = made.body.plan as { id: string; canvasSlug: string | null; steps: { id: string }[] };
    expect(p.canvasSlug).toBeTruthy();
    const listed = await rest('GET', `${buildPath(api.plans.list.path, b)}?conversationId=${IDS.billing}`);
    expect((listed.body.plans as { id: string }[]).some((x) => x.id === p.id)).toBe(true);
    const added = await rest('POST', buildPath(api.plans.addStep.path, { ...b, planId: p.id }), {
      title: 'Two',
    });
    expect(added.status).toBe(201);
    const removed = await rest(
      'DELETE',
      buildPath(api.plans.removeStep.path, { ...b, planId: p.id, stepId: p.steps[0]?.id as string }),
    );
    expect(removed.status).toBe(200);
    expect((removed.body.plan as { steps: unknown[] }).steps).toHaveLength(1);
  });
});

describe('editing after work started never loses work (WS-07)', () => {
  it('refuses removing a started step (409 step_started), keeps links and done steps through a reorder', async () => {
    const { planId } = await newPlan();
    const [s1, s2, s3] = (await plan(planId)).steps.map((s) => s.id) as [string, string, string];
    ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: s1 }));
    ok(await t.commit(IDS.mara, updatePlanStep, { planId, stepId: s3, link: { runNumber: 1907 } }));
    ok(await t.commit(IDS.mara, updatePlanStep, { planId, stepId: s1, state: 'done' }));
    for (const stepId of [s1, s3])
      await expect(t.commit(IDS.mara, removePlanStep, { planId, stepId })).rejects.toMatchObject({
        code: 'conflict',
        extra: { details: { reason: 'step_started' } },
      });
    const res = await rest(
      'DELETE',
      buildPath(api.plans.removeStep.path, { burrow: 'burrow-hq', planId, stepId: s3 }),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'conflict', details: { reason: 'step_started' } } });
    ok(await t.commit(IDS.mara, updatePlan, { planId, order: [s3, s2, s1], title: 'Refund flow v2' }));
    const after = await plan(planId);
    expect(after.title).toBe('Refund flow v2');
    expect(after.steps.map((s) => s.id)).toEqual([s3, s2, s1]);
    expect(after.steps[0]).toMatchObject({ runId: 'run_1907' });
    expect(after.steps[2]).toMatchObject({ state: 'done' });
    await expect(t.commit(IDS.mara, updatePlan, { planId, order: [s1, s2] })).rejects.toMatchObject({
      code: 'bad_request',
    });
    // A queued step that never started goes.
    ok(await t.commit(IDS.mara, removePlanStep, { planId, stepId: s2 }));
    expect((await plan(planId)).steps.map((s) => s.id)).toEqual([s3, s1]);
    // The replaced run link is in the signed payload.
    ok(await t.commit(IDS.mara, updatePlanStep, { planId, stepId: s3, link: { runNumber: null } }));
    const last = (await planEvents(planId)).at(-1);
    expect(last?.payload).toMatchObject({ steps: [{ stepId: s3, runId: ['run_1907', null] }] });
  });

  it('links only work the plan’s room may see', async () => {
    const { planId } = await newPlan();
    const s1 = (await step(planId, 0)).id;
    await expect(
      t.commit(IDS.mara, updatePlanStep, { planId, stepId: s1, link: { runNumber: 99999 } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps a started step the canvas block dropped, and re-syncs the block (WS-07)', async () => {
    const { planId } = await newPlan();
    const { canvasId } = ok(await t.commit(IDS.mara, createPlanCanvas, { planId }));
    const [s1, s2, s3] = (await plan(planId)).steps.map((s) => s.id) as [string, string, string];
    ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: s1 }));
    const doc = (id: string, title: string, state = 'queued') => ({
      stepId: id,
      title,
      ownerId: IDS.mara,
      state,
    });
    const before = [doc(s1, 'Write the spec', 'active'), doc(s2, 'Build the endpoint'), doc(s3, 'Review it')];
    // The block lost step 1 (started) and step 3 (never started) and gained a line.
    const after = [
      doc(s2, 'Build the endpoint'),
      { stepId: null, title: 'Ship it', ownerId: IDS.mara, state: 'queued' },
    ];
    await asMara((ctx) => applyPlanEdit(ctx, canvasId, { planId, before, after }));
    const steps = (await plan(planId)).steps;
    expect(steps.map((s) => s.title)).toEqual(['Write the spec', 'Build the endpoint', 'Ship it']);
    expect(steps[0]?.state).toBe('active');
    // Only a block edit that refused a removal: the plan is published again so the block gets its step back.
    const dropOnly = [doc(s2, 'Build the endpoint'), doc(steps[2]?.id as string, 'Ship it')];
    const seen: string[] = [];
    const off = t.services.bus.onFrame((f) => {
      if (f.event.type === 'plan.updated' && f.event.plan.id === planId) seen.push(f.event.plan.id);
    });
    try {
      await asMara((ctx) =>
        applyPlanEdit(ctx, canvasId, {
          planId,
          before: [doc(s1, 'Write the spec', 'active'), ...dropOnly],
          after: dropOnly,
        }),
      );
    } finally {
      off();
    }
    expect((await plan(planId)).steps).toHaveLength(3);
    expect(seen).toEqual([planId]);
  });

  it('makes one plan canvas, bound both ways, with the plan block', async () => {
    const { planId } = await newPlan();
    const first = ok(await t.commit(IDS.mara, createPlanCanvas, { planId }));
    const again = ok(await t.commit(IDS.mara, createPlanCanvas, { planId }));
    expect(again.canvasId).toBe(first.canvasId);
    const [row] = await t.services.db.select().from(canvases).where(eq(canvases.id, first.canvasId));
    expect(row).toMatchObject({ planId, conversationId: IDS.billing });
    expect(row?.markdown).toContain(`:::plan{id=${planId}}`);
    expect((await plan(planId)).canvasId).toBe(first.canvasId);
    // Agents: `canvas_create {planId}` with “Write canvases”.
    const other = await newPlan();
    const turn = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const toffee = await mcpClient(t.baseUrl, turn.token);
    try {
      const made = await toffee.call('canvas_create', {
        conversationId: IDS.billing,
        title: 'Refund plan',
        planId: other.planId,
      });
      expect(made.body).toMatchObject({ status: 'ok' });
      expect((await plan(other.planId)).canvasId).toBe(made.body.canvasId);
    } finally {
      await toffee.close();
    }
  });
});

describe('starting steps (WS-04; one-agent.md OA-14)', () => {
  it('a person’s start asks the agent in the plan’s thread; the dispatch is linked and one start is in flight', async () => {
    const { planId, messageId } = await newPlan();
    const s2 = (await step(planId, 1)).id;
    const started = ok(
      await t.commit(IDS.mara, startPlanStep, { planId, stepId: s2, message: 'Use the new API.' }),
    );
    const [asked] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, started.messageId as string));
    expect(asked?.text).toBe(
      '@Dusty, please take step 2 of “Refund flow”: Build the endpoint\n\nUse the new API.',
    );
    expect(asked?.threadRootId).toBe(messageId);
    expect(asked?.mentions).toEqual([IDS.dusty]);
    const [dispatch] = await t.services.db.select().from(dispatches).where(eq(dispatches.planStepId, s2));
    expect(dispatch).toMatchObject({ agentId: IDS.dusty, planId, trigger: 'mention', state: 'queued' });
    expect(await step(planId, 1)).toMatchObject({
      dispatchId: dispatch?.id,
      state: 'active',
      stateLabel: 'Asked',
    });
    await expect(t.commit(IDS.mara, startPlanStep, { planId, stepId: s2 })).rejects.toMatchObject({
      code: 'conflict',
    });
    // The REST answer carries the dispatch.
    const other = await newPlan();
    const res = await rest(
      'POST',
      buildPath(api.plans.startStep.path, {
        burrow: 'burrow-hq',
        planId: other.planId,
        stepId: (await step(other.planId, 1)).id,
      }),
      {},
    );
    expect(res.status).toBe(200);
    expect(res.body.dispatchId).toMatch(/^dsp_/);
    // The runner's context tells the agent which step it was handed.
    const context = await buildDispatchContext(t.services, dispatch as NonNullable<typeof dispatch>);
    expect(context.planStep).toMatchObject({
      planId,
      stepId: s2,
      planTitle: 'Refund flow',
      position: 2,
      title: 'Build the endpoint',
      outline: ['1. Write the spec · Queued', '2. Build the endpoint · Asked', '3. Review it · Queued'],
    });
  });

  it('every step is the agent’s: starting the first one asks it too', async () => {
    const { planId } = await newPlan();
    const s1 = (await step(planId, 0)).id;
    const started = ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: s1 }));
    const [asked] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, started.messageId as string));
    expect(asked?.mentions).toEqual([IDS.dusty]);
    expect(await step(planId, 0)).toMatchObject({ state: 'active', stateLabel: 'Asked' });
  });

  it('a step waiting for the person’s word goes ahead: the agent is told to carry on with it', async () => {
    const { planId } = await newPlan();
    const s2 = (await step(planId, 1)).id;
    ok(
      await t.commit(IDS.mara, updatePlanStep, {
        planId,
        stepId: s2,
        state: 'gate',
        note: 'Waiting for your go',
      }),
    );
    const started = ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: s2 }));
    const [asked] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, started.messageId as string));
    expect(asked?.text).toContain('go ahead');
    expect(asked?.text).toContain('Build the endpoint');
    expect(asked?.mentions).toEqual([IDS.dusty]);
    expect(await step(planId, 1)).toMatchObject({ state: 'active', stateLabel: 'Asked', note: null });
  });

  it('two steps get a turn each, never one merged turn', async () => {
    const { planId } = ok(
      await t.commit(IDS.mara, createPlan, {
        conversationId: IDS.billing,
        title: 'Two for Dusty',
        steps: [{ title: 'First' }, { title: 'Second' }],
      }),
    );
    const [a, b] = (await plan(planId)).steps.map((s) => s.id) as [string, string];
    ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: a }));
    ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: b }));
    const [da, db] = [(await step(planId, 0)).dispatchId, (await step(planId, 1)).dispatchId];
    expect(da).toMatch(/^dsp_/);
    expect(db).toMatch(/^dsp_/);
    expect(da).not.toBe(db);
  });

  it('the agent never starts a step: it marks its own with plan_update (CT-1108)', async () => {
    const { planId } = await newPlan(IDS.dusty);
    const s2 = (await step(planId, 1)).id;
    await expect(t.commit(IDS.dusty, startPlanStep, { planId, stepId: s2 })).rejects.toMatchObject({
      code: 'forbidden',
    });
    const turn = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const agent = await mcpClient(t.baseUrl, turn.token);
    try {
      const tools = await agent.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain('plan_start_step');
      const res = await agent.call('plan_update', { planId, steps: [{ stepId: s2, state: 'active' }] });
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(await step(planId, 1)).toMatchObject({ state: 'active' });
    } finally {
      await agent.close();
    }
  });
});

describe('steps follow their linked work (WS-05)', () => {
  async function asked() {
    const { planId } = await newPlan();
    const s2 = (await step(planId, 1)).id;
    ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: s2 }));
    const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.planStepId, s2));
    if (!d) throw new Error('no dispatch');
    return { planId, stepId: s2, dispatchId: d.id };
  }

  async function runFor(dispatchId: string) {
    return ok(
      await t.commit(IDS.dusty, startRun, {
        conversationId: IDS.billing,
        title: 'Build the refund endpoint',
        repo: 'whombat/billing',
        branch: 'feat/refunds',
        steps: [{ title: 'Write it', detail: '' }],
        dispatchId,
      }),
    );
  }

  it('dispatch → run: working, in progress, done; a late “live” changes nothing', async () => {
    const { planId, dispatchId } = await asked();
    await t.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, dispatchId));
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    if (!row) throw new Error('no dispatch');
    await followDispatch(t.services, row);
    expect(await step(planId, 1)).toMatchObject({ state: 'active', stateLabel: 'Working' });
    const run = await runFor(dispatchId);
    expect(await step(planId, 1)).toMatchObject({
      runId: run.runId,
      state: 'active',
      stateLabel: 'In progress',
    });
    ok(await t.commit(IDS.dusty, runStep, { run: run.number, step: 0, state: 'done' }));
    ok(await t.commit(IDS.dusty, finishRun, { run: run.number, outcome: 'done', summary: 'Shipped.' }));
    expect(await step(planId, 1)).toMatchObject({ state: 'done', stateLabel: 'Done' });
    const count = (await planEvents(planId)).length;
    // Repeated and late events: following again reads the current state and writes nothing.
    await followDispatch(t.services, row);
    await t.services.pipeline.transact(t.burrowId, async (session) => {
      const burrow = await loadBurrowRow(session.tx, t.burrowId);
      if (!burrow) throw new Error('seed');
      await followPlanWork(
        { session, burrow, now: new Date(), signerId: IDS.dusty },
        { kind: 'run', id: run.runId },
      );
    });
    expect((await planEvents(planId)).length).toBe(count);
    expect(await step(planId, 1)).toMatchObject({ state: 'done' });
  });

  it('run failed → blocked “Run failed”, never done; failDispatchRuns too', async () => {
    const { planId, dispatchId } = await asked();
    const run = await runFor(dispatchId);
    ok(await t.commit(IDS.dusty, finishRun, { run: run.number, outcome: 'failed', summary: 'Tests broke.' }));
    expect(await step(planId, 1)).toMatchObject({
      state: 'blocked',
      stateLabel: 'Run failed',
      note: `Run #${run.number} failed. Retry it.`,
    });
    // The plan's creator hears about it once (WS-20).
    const [n] = await t.services.db
      .select()
      .from(notifications)
      .where(
        sql`${notifications.dedupKey} = ${`plan-step:${(await step(planId, 1)).id}:blocked:run:${run.runId}:failed`}`,
      );
    expect(n).toMatchObject({ principalId: IDS.mara, kind: 'needs_you' });
    // Retry: starting again replaces the links (the failed run stays in the signed event).
    ok(await t.commit(IDS.mara, startPlanStep, { planId, stepId: (await step(planId, 1)).id }));
    expect(await step(planId, 1)).toMatchObject({ runId: null, state: 'active', stateLabel: 'Asked' });
  });

  it('paused → blocked, resumed → in progress, taken over → active', async () => {
    const { planId, dispatchId } = await asked();
    const run = await runFor(dispatchId);
    ok(await t.commit(IDS.mara, pauseRun, { number: run.number }));
    expect(await step(planId, 1)).toMatchObject({ state: 'blocked', stateLabel: 'Paused' });
    ok(await t.commit(IDS.mara, resumeRun, { number: run.number }));
    expect(await step(planId, 1)).toMatchObject({ state: 'active', stateLabel: 'In progress' });
    ok(await t.commit(IDS.mara, takeOverRun, { number: run.number }));
    expect(await step(planId, 1)).toMatchObject({
      state: 'active',
      stateLabel: 'Taken over',
      note: `Mara took over Run #${run.number}.`,
    });
  });

  it('a turn that ended without a run asks a person to check; a failed turn couldn’t start', async () => {
    const { planId, dispatchId } = await asked();
    await t.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, dispatchId));
    await t.services.runtime.finalize(dispatchId, { outcome: 'done' });
    expect(await step(planId, 1)).toMatchObject({ state: 'gate', stateLabel: 'Check result' });
    const other = await asked();
    await t.services.db
      .update(dispatches)
      .set({ state: 'running', attempts: 9 })
      .where(eq(dispatches.id, other.dispatchId));
    await t.services.runtime.finalize(other.dispatchId, { outcome: 'failed', error: 'boom' });
    expect(await step(other.planId, 1)).toMatchObject({ state: 'blocked', stateLabel: 'Couldn’t start' });
  });

  it('an approval declined blocks its step; a manual “done” for the same work stands', async () => {
    const { planId } = await newPlan();
    const s3 = (await step(planId, 2)).id;
    ok(await t.commit(IDS.mara, updatePlanStep, { planId, stepId: s3, link: { approvalNumber: 12 } }));
    expect(await step(planId, 2)).toMatchObject({ state: 'gate', approvalId: 'apr_staging-482' });
    ok(await t.commit(IDS.mara, decideApproval, { number: 12, decision: 'decline', note: 'Not yet.' }));
    expect(await step(planId, 2)).toMatchObject({ state: 'blocked', stateLabel: 'Declined' });
    // The seeded plan follows the same approval.
    expect((await step('pln_invoice-pdf', 3)).state).toBe('blocked');
  });

  it('reconciles at startup, idempotently', async () => {
    const { planId, dispatchId } = await asked();
    // The dispatch failed while nobody listened.
    await t.services.db.update(dispatches).set({ state: 'failed' }).where(eq(dispatches.id, dispatchId));
    expect(await step(planId, 1)).toMatchObject({ stateLabel: 'Asked' });
    expect(await reconcilePlans(t.services)).toBeGreaterThanOrEqual(1);
    expect(await step(planId, 1)).toMatchObject({ state: 'blocked', stateLabel: 'Couldn’t start' });
    const count = (await planEvents(planId)).length;
    await reconcilePlans(t.services);
    expect((await planEvents(planId)).length).toBe(count);
  });

  it('a run started for a named step links it (start_run.planStep)', async () => {
    const { planId } = await newPlan();
    const s2 = (await step(planId, 1)).id;
    const turn = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const banjo = await mcpClient(t.baseUrl, turn.token);
    try {
      const res = await banjo.call('start_run', {
        conversationId: IDS.billing,
        title: 'Refund endpoint',
        repo: 'whombat/billing',
        branch: 'feat/refund-endpoint',
        steps: [{ title: 'Code', detail: '' }],
        planStep: { planId, stepId: s2 },
      });
      expect(res.body).toMatchObject({ status: 'ok' });
      const [r] = await t.services.db.select().from(runs).orderBy(desc(runs.number)).limit(1);
      expect(await step(planId, 1)).toMatchObject({
        runId: r?.id,
        state: 'active',
        stateLabel: 'In progress',
      });
    } finally {
      await banjo.close();
    }
  });

  it('adds steps after others (plan_update by an agent)', async () => {
    const { planId } = await newPlan(IDS.dusty);
    const s1 = (await step(planId, 0)).id;
    ok(await t.commit(IDS.dusty, addPlanStep, { planId, title: 'Between', after: s1 }));
    expect((await plan(planId)).steps.map((s) => s.title)).toEqual([
      'Write the spec',
      'Between',
      'Build the endpoint',
      'Review it',
    ]);
  });
});
