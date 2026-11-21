/**
 * An automation's places (`maxConcurrentRuns`, automation-recipes.md AR-56) on a real database: a run waiting for a
 * person's yes takes no place, and one that gets its yes while the others fill every place waits its turn again.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { approvals } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { runAutomationNow } from './commands';

const w = useAutomationWorld();

/** Asks for a yes, then works an hour (a `wait` takes its place as an agent would), then says it's done. */
const ASK_THEN_WORK: AutomationDefinitionInput = {
  version: 1,
  conversationId: IDS.billing,
  triggers: [{ kind: 'manual' }],
  steps: [
    { id: 'approve', kind: 'request_approval', title: 'Fix it?', details: 'It works on it for an hour.' },
    { id: 'work', kind: 'wait', minutes: 60 },
    { id: 'note', kind: 'post_message', text: 'Done.' },
  ],
  limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 1, maxRunsPerDay: 20 },
};

async function start(automationId: string) {
  const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId, test: false });
  await w.settle();
  return runId as string;
}

async function approve(runId: string) {
  const step = (await w.run(runId)).steps.find((s) => s.stepId === 'approve');
  const [a] = await w.services.db
    .select()
    .from(approvals)
    .where(eq(approvals.id, step?.approvalId ?? ''));
  if (!a) throw new Error('no approval');
  await w.ok(IDS.mara, decideApproval, { number: a.number, decision: 'approve' });
  await w.settle();
}

describe('an automation’s places (AR-56)', () => {
  it('a run waiting for a yes takes no place; one that gets its yes while the place is taken waits its turn', async () => {
    const id = await w.publish(ASK_THEN_WORK, { name: 'One at a time' });
    const a = await start(id);
    // The first waits for a yes, so the second starts too (before AR-56 it stayed queued behind the card).
    const b = await start(id);
    expect((await w.run(a)).status).toBe('waiting');
    expect((await w.run(b)).status).toBe('waiting');
    expect((await w.run(b)).steps[0]?.state).toBe('waiting');
    const bStarted = (await w.run(b)).startedAt;

    // A's yes: it works and takes the only place.
    await approve(a);
    expect((await w.run(a)).steps.map((s) => s.state)).toEqual(['succeeded', 'waiting', 'pending']);
    // B's yes while A works: B waits its turn, its yes kept.
    await approve(b);
    let run = await w.run(b);
    expect(run.status).toBe('queued');
    expect(run.steps.map((s) => s.state)).toEqual(['succeeded', 'pending', 'pending']);

    // A is done: B goes on from where it was, and keeps when it first started.
    w.advance(61 * 60_000);
    await w.settle();
    expect((await w.run(a)).status).toBe('succeeded');
    run = await w.run(b);
    expect(run.status).toBe('waiting');
    expect(run.steps.map((s) => s.state)).toEqual(['succeeded', 'waiting', 'pending']);
    expect(run.startedAt).toBe(bStarted);
    w.advance(61 * 60_000);
    await w.settle();
    expect((await w.run(b)).status).toBe('succeeded');
  });

  it('a yes with a free place goes straight on', async () => {
    const id = await w.publish(ASK_THEN_WORK, { name: 'Free place' });
    const a = await start(id);
    await approve(a);
    const run = await w.run(a);
    expect(run.status).toBe('waiting');
    expect(run.steps.map((s) => s.state)).toEqual(['succeeded', 'waiting', 'pending']);
  });
});
