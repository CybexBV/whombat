import { newId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { finishRun, runStep, startRun } from '../commands/agent-runs';
import { activities, runSteps } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { agentTokenFor } from '../test/tokens';
import { completionEvidence } from './completion-evidence';

const t = useTestServer({ seed: true });

describe('agent outcomes', () => {
  it('refuses a successful finish until every run step is explicitly complete', async () => {
    const started = await t.commit(IDS.dusty, startRun, {
      conversationId: IDS.billing,
      title: 'Verify delivery',
      repo: 'whombat/billing',
      branch: 'feat/outcomes',
      steps: [{ title: 'Read back result', detail: '' }],
    });
    if (started.status !== 'ok') throw new Error(started.status);
    const { number, runId } = started.result;
    await expect(
      t.commit(IDS.dusty, finishRun, { run: number, outcome: 'done', summary: 'Claim only' }),
    ).rejects.toThrow('step');
    const [step] = await t.services.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(step?.state).not.toBe('done');
    await t.commit(IDS.dusty, runStep, { run: number, step: 0, state: 'done' });
    expect(
      (await t.commit(IDS.dusty, finishRun, { run: number, outcome: 'done', summary: 'Checked' })).status,
    ).toBe('ok');
  });

  it('isolates observed evidence by task and excludes self-reports and failed commands', async () => {
    const turn = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const now = t.services.clock();
    const base = {
      burrowId: t.burrowId,
      dispatchId: turn.dispatchId,
      agentId: IDS.dusty,
      conversationId: IDS.billing,
      attempt: 0,
      seq: 1,
      kind: 'command' as const,
      tool: 'exec_command',
      status: 'done' as const,
      title: 'Read artifact',
      important: false,
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
      exitCode: 0,
    };
    const observed = newId('activity');
    await t.services.pipeline.transact(t.burrowId, async ({ tx }) => {
      await tx.insert(activities).values([
        { ...base, id: observed, key: 'read' },
        { ...base, id: newId('activity'), key: 'other-task', dispatchId: newId('dispatch') },
        { ...base, id: newId('activity'), key: 'failed', exitCode: 1 },
        { ...base, id: newId('activity'), key: 'claim', tool: 'whombat.run_tests' },
      ]);
    });
    expect(
      (
        await completionEvidence(t.services.db, {
          burrowId: t.burrowId,
          agentId: IDS.dusty,
          dispatchId: turn.dispatchId,
        })
      ).map((e) => e.id),
    ).toEqual([observed]);
  });
});
