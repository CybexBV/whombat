/**
 * End to end, deterministic (work-supervision WS-11, WS-12, WS-15): the real runner with the scripted Hermes over
 * HTTP (hermes-engine.md HE-33). The provider's own MCP calls become activity rows from the calls the server ran
 * (`activity-mcp.ts`; the runner reports only other tools) — one row per call, finished, on the run — and a turn that
 * makes no tool calls reports nothing.
 */
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { pauseRun, resumeRun } from '../commands/runs';
import { activities, dispatches, runs } from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { checkoutEnv, startTestRunner, type TestRunner, waitFor } from '../test/runner';
import { SCRIPTED_ENV } from '../test/scripted';
import { sessionFor } from '../test/tokens';

const t = useTestServer({
  seed: true,
  listen: true,
  env: { ...checkoutEnv(), ...SCRIPTED_ENV, ...signInsEnv() },
});
// Runs check their branch out on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));
let runner: TestRunner;
const frames: BusFrame[] = [];
let mara = '';

beforeAll(async () => {
  t.services.bus.onFrame((f) => frames.push(f));
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
  runner = await startTestRunner(t.baseUrl, { thinkMs: 30, tickMs: 15 });
});

afterAll(async () => {
  await runner?.stop();
});

const list = async (query: string) => {
  const res = await t.api.inject({
    method: 'GET',
    url: `/api/v1/burrows/burrow-hq/activity?${query}`,
    headers: { cookie: mara },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    activities: {
      key: string;
      kind: string;
      tool: string;
      status: string;
      title: string;
      runId: string | null;
    }[];
    reported: boolean;
  };
};

describe('scripted Hermes → runner → server', () => {
  it('a resumed run’s MCP calls become finished rows of the run, framed live', async () => {
    expect((await t.commit(IDS.mara, pauseRun, { number: 1907 })).status).toBe('ok');
    expect((await t.commit(IDS.mara, resumeRun, { number: 1907 })).status).toBe('ok');
    await waitFor(
      async () => {
        const [run] = await t.services.db.select().from(runs).where(eq(runs.id, 'run_1907'));
        return run?.status === 'done';
      },
      20_000,
      'run #1907 to finish',
    );
    const [turn] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.runId, 'run_1907'), eq(dispatches.trigger, 'run_control')));
    if (!turn) throw new Error('no turn');
    await waitFor(async () => {
      const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, turn.id));
      return d?.state === 'done';
    });
    const rows = await t.services.db
      .select()
      .from(activities)
      .where(eq(activities.dispatchId, turn.id))
      .orderBy(asc(activities.startedAt), asc(activities.seq));
    // One row per call, keyed <attempt>:mcp-<the server's id for the call>, all finished, all on the run.
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows.every((r) => /^1:mcp-[A-Za-z0-9_-]+$/.test(r.key))).toBe(true);
    expect(rows.every((r) => r.status === 'done' && r.runId === 'run_1907' && r.kind === 'whombat')).toBe(
      true,
    );
    expect(rows.map((r) => r.tool)).toEqual(
      expect.arrayContaining([
        'whombat.run_log',
        'whombat.run_step',
        'whombat.finish_run',
        'whombat.post_message',
      ]),
    );
    expect(rows.find((r) => r.tool === 'whombat.finish_run')?.title).toBe('Finished the run');
    // Whombat tools carry no evidence (their arguments may be another room's).
    expect(rows.every((r) => r.evidence === null && r.object === null)).toBe(true);

    const page = await list('runNumber=1907&limit=500');
    expect(page.reported).toBe(true);
    expect(page.activities.length).toBe(rows.length);
    expect(frames.some((f) => f.topic === 'run:run_1907' && f.event.type === 'activity.updated')).toBe(true);
    const states = frames.flatMap((f) =>
      f.event.type === 'dispatch.updated' && f.event.dispatch.id === turn.id ? [f.event.dispatch.state] : [],
    );
    expect(states).toEqual(['queued', 'claimed', 'running', 'done']);
  });

  it('a turn that calls no tool of its own reports only the Whombat calls the server ran', async () => {
    const res = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text: '@Dusty hello' });
    if (res.status !== 'ok') throw new Error('send failed');
    const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, res.result.id));
    if (!d) throw new Error('no dispatch');
    await waitFor(async () => {
      const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, d.id));
      return row?.state === 'done';
    });
    const { activities: rows } = (await list(`dispatchId=${d.id}`)) as {
      activities: { key: string; kind: string }[];
    };
    // Its reply goes out through post_message: the server's record of that call, nothing from the runner.
    expect(rows.every((r) => /^1:mcp-/.test(r.key) && r.kind === 'whombat')).toBe(true);
  });
});
