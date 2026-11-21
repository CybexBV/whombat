/**
 * Run controls and who may use them: a person's Pause holds until a person resumes; the run's own agent
 * may resume only a pause of its own.
 */
import { api, buildPath } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { dispatches, runs } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { agentTokenFor } from '../test/tokens';
import { pauseRun, resumeRun } from './runs';

const t = useTestServer({ seed: true, app: true });

async function run1907() {
  const [row] = await t.services.db.select().from(runs).where(eq(runs.number, 1907));
  if (!row) throw new Error('no run #1907');
  return row;
}

async function runControls() {
  const rows = await t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.runId, (await run1907()).id), eq(dispatches.trigger, 'run_control')));
  return rows.filter((d) => d.state === 'queued');
}

describe('resume', () => {
  it('an agent cannot undo a person’s Pause, over REST or as a command', async () => {
    expect((await t.commit(IDS.mara, pauseRun, { number: 1907 })).status).toBe('ok');
    const banjo = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const res = await t.api.inject({
      method: 'POST',
      url: `${api.runs.resume.base}${buildPath(api.runs.resume.path, { burrow: 'burrow-hq', number: 1907 })}`,
      headers: { authorization: banjo.bearer },
    });
    // Agent tokens are refused on REST altogether (security-fixes auth-tokens); the command path is the real guard.
    expect(res.statusCode).toBe(401);
    await expect(t.commit(IDS.dusty, resumeRun, { number: 1907 })).rejects.toThrow(/person/);
    expect(await run1907()).toMatchObject({ status: 'paused', pausedById: IDS.mara });
    expect(await runControls()).toEqual([]);

    // The person who paused it (or any person in the room) resumes it.
    expect((await t.commit(IDS.mara, resumeRun, { number: 1907 })).status).toBe('ok');
    expect(await run1907()).toMatchObject({ status: 'live', pausedById: null });
  });
});
