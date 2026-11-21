/**
 * (n) Work supervision on the managed stack (contracts ≥ 0.12.0; Whombat work-supervision WS-01…WS-51, one-agent.md
 * OA-14): over the real client, relay and runtime, the owner makes a plan in their Chat (nothing starts; its steps are
 * the agent's own work, no step owners since contracts 0.123.0), starts its first step (the agent is asked in the
 * plan's thread; the scripted Hermes answers without a run, so the step truthfully asks a person to check the result
 * instead of claiming it done), sees the turn's lifecycle and observed activity live, finds the step in the Work view's
 * Needs you, and finds the plan in search with its state.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractsAtLeast } from '../src/manifest/version.ts';
import type { ApplianceSession } from '../src/scenario-kit/app-client.ts';
import { note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession } from '../src/scenario-kit/slice.ts';
import { api, collect, ensureWorkspace, eventType, type Workspace } from '../src/scenario-kit/work.ts';

const enabled = contractsAtLeast('0.12.0');

interface Step {
  id: string;
  title: string;
  state: string;
  stateLabel: string;
  note: string | null;
  dispatchId: string | null;
}
interface Plan {
  id: string;
  title: string;
  steps: Step[];
  messageId: string | null;
}

let owner: ApplianceSession;
let w: Workspace;
let plan: Plan;

beforeAll(async () => {
  if (!enabled) return;
  const slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
  w = await ensureWorkspace(owner, `Work ${randomBytes(3).toString('hex')}`);
}, 300_000);

afterAll(() => {
  try {
    owner?.close('closed');
  } catch {
    // already closed
  }
});

const getPlan = async (): Promise<Plan> =>
  (await api<{ plan: Plan }>(owner, 'plans.get', 'GET', { params: { burrow: w.slug, planId: plan.id } }))
    .plan;

describe.skipIf(!enabled)('n work supervision', () => {
  it('1 making a plan in the owner’s Chat posts its card and starts nothing', async (ctx) => {
    // The Whombat's one burrow is shared by the scenarios (OA-01): an earlier run's plans may be there.
    const before = await api<{ plans: Plan[] }>(owner, 'plans.list', 'GET', {
      params: { burrow: w.slug },
      query: { conversationId: w.conversationId },
    });
    const title = `Release notes ${randomBytes(2).toString('hex')}`;
    const made = await api<{ plan: Plan }>(owner, 'plans.create', 'POST', {
      params: { burrow: w.slug },
      body: {
        conversationId: w.conversationId,
        title,
        steps: [{ title: 'Draft the notes' }, { title: 'Publish them' }],
      },
    });
    plan = made.plan;
    note(ctx, 'plan', {
      id: plan.id,
      earlier: before.plans.length,
      steps: plan.steps.map((s) => `${s.title}: ${s.state}`),
    });
    expect(before.plans.map((p) => p.id)).not.toContain(plan.id);
    expect(plan.steps.map((s) => s.state)).toEqual(['queued', 'queued']);
    expect(plan.steps.some((s) => 'ownerId' in s)).toBe(false);
    expect(plan.messageId).toBeTruthy();
    expect(plan.steps.every((s) => s.dispatchId === null)).toBe(true);
  });

  it('2 starting a step asks the agent in the plan’s thread; its turn and activity stream live', async (ctx) => {
    const events = collect(owner, [`conv:${w.conversationId}`, `burrow:${w.burrowId}`]);
    const started = await api<{ dispatchId: string | null; messageId: string | null }>(
      owner,
      'plans.startStep',
      'POST',
      { params: { burrow: w.slug, planId: plan.id, stepId: plan.steps[0]?.id }, body: {} },
    );
    expect(started.dispatchId).toBeTruthy();
    const done = await events.waitFor(
      (e) => {
        const d = (e.event as { dispatch?: { id: string; state: string } }).dispatch;
        return eventType(e) === 'dispatch.updated' && d?.id === started.dispatchId && d.state === 'done'
          ? d
          : null;
      },
      90_000,
      'the step’s turn to finish',
    );
    const states = events.events
      .filter((e) => eventType(e) === 'dispatch.updated')
      .map((e) => (e.event as { dispatch: { id: string; state: string } }).dispatch)
      .filter((d) => d.id === started.dispatchId)
      .map((d) => d.state);
    note(ctx, 'turn', { states, done });
    expect(states).toContain('done');
    const activity = await api<{ activities: { title: string; status: string }[]; reported: boolean }>(
      owner,
      'activity.list',
      'GET',
      { params: { burrow: w.slug }, query: { dispatchId: started.dispatchId } },
    );
    note(ctx, 'activity', {
      reported: activity.reported,
      rows: activity.activities.map((a) => `${a.title} (${a.status})`),
    });
    // Rows only from what the provider reported, each finished or failed, never left running.
    expect(activity.activities.every((a) => a.status !== 'running')).toBe(true);
    expect(events.duplicateCursors()).toEqual([]);
  });

  it('3 the turn answered without a run: the step asks a person to check, and it is in the Work view', async (ctx) => {
    let step: Step | undefined;
    for (let i = 0; i < 60; i++) {
      step = (await getPlan()).steps[0];
      if (step?.state === 'gate') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    note(ctx, 'step', { ...step });
    expect(step).toMatchObject({ state: 'gate', stateLabel: 'Check result' });
    const work = await api<{
      sections: { section: string; items: { refs: { stepId: string | null }; actions: string[] }[] }[];
    }>(owner, 'work.overview', 'GET', { params: { burrow: w.slug } });
    const needs = work.sections.find((s) => s.section === 'needs_you')?.items ?? [];
    const item = needs.find((i) => i.refs.stepId === step?.id);
    expect(item?.actions).toEqual(expect.arrayContaining(['mark_step_done']));
  });

  it('4 marking it done completes it; search finds the plan with its state', async (ctx) => {
    await api(owner, 'plans.updateStep', 'PATCH', {
      params: { burrow: w.slug, planId: plan.id, stepId: plan.steps[0]?.id },
      body: { state: 'done' },
    });
    const found = await api<{ results: { id: string; type: string; status: { text: string } | null }[] }>(
      owner,
      'search.query',
      'GET',
      { params: { burrow: w.slug }, query: { q: plan.title, type: 'plans' } },
    );
    note(ctx, 'search', { results: found.results.map((r) => `${r.type} ${r.id} ${r.status?.text ?? ''}`) });
    expect(found.results.find((r) => r.id === plan.id)).toMatchObject({
      type: 'PLAN',
      status: { text: '1 OF 2 DONE' },
    });
  });
});
