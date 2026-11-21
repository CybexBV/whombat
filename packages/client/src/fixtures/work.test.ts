import { Plan, WorkOverview } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { createWorkFixtures } from './work';

const base = 'http://fixtures.local/api/v1/burrows/burrow-hq';
const call = async (
  w: ReturnType<typeof createWorkFixtures>,
  method: string,
  path: string,
  body?: unknown,
) => {
  const res = await w.handle(
    new Request(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
  );
  if (!res) throw new Error(`not handled: ${method} ${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('work fixtures', () => {
  it('serves the seeded plan, a Work view and an activity feed that parse', async () => {
    const w = createWorkFixtures();
    const list = await call(w, 'GET', '/plans?conversationId=cnv_dm-dusty');
    const plans = (list.body.plans as unknown[]).map((p) => Plan.parse(p));
    expect(plans.map((p) => p.title)).toEqual(['Invoice PDF export']);
    const work = WorkOverview.parse((await call(w, 'GET', '/work')).body);
    expect(work.sections.map((s) => s.items.length)).toEqual([1, 1, 1, 0, 1, 1]);
    const feed = await call(w, 'GET', '/activity?runNumber=1907');
    expect((feed.body.activities as unknown[]).length).toBeGreaterThan(0);
    expect((await call(w, 'GET', '/activity?runNumber=1882')).body.activities).toEqual([]);
  });

  it('follows the server’s rules: removing a started step is refused', async () => {
    const w = createWorkFixtures();
    const refused = await call(w, 'DELETE', '/plans/pln_invoice-pdf/steps/stp_pdf-2');
    expect(refused.status).toBe(409);
  });

  it('makes a plan, adds and starts a step, and blocks steps show in the Work view', async () => {
    const w = createWorkFixtures();
    const made = await call(w, 'POST', '/plans', {
      conversationId: 'cnv_dm-dusty',
      title: 'Ship the PDF',
      steps: [{ title: 'Write the notes' }],
      canvas: false,
    });
    expect(made.status).toBe(201);
    const id = Plan.parse(made.body.plan).id;
    const added = Plan.parse((await call(w, 'POST', `/plans/${id}/steps`, { title: 'Tell Mara' })).body.plan);
    const stepId = added.steps[1]?.id as string;
    const started = Plan.parse((await call(w, 'POST', `/plans/${id}/steps/${stepId}/start`, {})).body.plan);
    expect(started.steps[1]?.stateLabel).toBe('Asked');
    await call(w, 'PATCH', `/plans/${id}/steps/${stepId}`, { state: 'blocked' });
    const work = WorkOverview.parse((await call(w, 'GET', '/work')).body);
    expect(work.counts.blocked).toBe(1);
  });
});
