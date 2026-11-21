/**
 * Plans, activity, the Work view and wider search over a managed session (work-supervision WS-26, contracts CT-88):
 * the new ops are allowlisted by the protocol, answered by the REST handlers in-process, and their frames reach the
 * person.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;
const B = { burrow: 'burrow-hq' };

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

type Out = { t: string; output?: Record<string, unknown>; code?: string };

describe('work supervision over a session', () => {
  it('makes and edits a plan, framed to the room, and finds it in search', async () => {
    const a = await m.client(mara);
    a.send({ t: 'subscribe', sub: 'burrow', topics: [`burrow:${TEST_BURROW_ID}`] });
    await a.waitFor((x) => x.t === 'subscribed');
    const made = (await a.request('plans.create', {
      params: B,
      body: {
        conversationId: IDS.billing,
        title: 'Session plan for credit notes',
        steps: [{ title: 'Draft the credit note template', ownerId: IDS.mara }],
      },
    })) as Out;
    expect(made.t).toBe('result');
    const plan = (made.output as { plan: { id: string; steps: { id: string; state: string }[] } }).plan;
    const stepId = plan.steps[0]?.id as string;
    expect(plan.steps[0]?.state).toBe('queued');

    const started = (await a.request('plans.startStep', {
      params: { ...B, planId: plan.id, stepId },
      body: {},
    })) as Out;
    expect((started.output as { plan: { steps: { state: string }[] } }).plan.steps[0]?.state).toBe('active');
    await a.waitFor(
      (x) =>
        x.t === 'event' &&
        (x as unknown as { event: { type: string; plan?: { id: string } } }).event.type === 'plan.updated' &&
        (x as unknown as { event: { plan: { id: string } } }).event.plan.id === plan.id,
    );

    const found = (await a.request('search.query', {
      params: B,
      query: { q: 'credit note template', type: 'plans' },
    })) as Out;
    expect(
      (found.output as { results: { id: string; type: string }[] }).results.map((r) => [r.id, r.type]),
    ).toContainEqual([plan.id, 'PLAN']);
  });

  it('serves the Work view', async () => {
    const a = await m.client(mara);
    const work = (await a.request('work.overview', { params: B })) as Out;
    expect(work.t).toBe('result');
    expect((work.output as { sections: { section: string }[] }).sections.map((s) => s.section)).toEqual([
      'needs_you',
      'running',
      'queued',
      'blocked',
      'failed',
      'done',
    ]);
  });
});
