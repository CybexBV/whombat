import { and, asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBurrowChain } from '../audit/verify';
import { decideApproval } from '../commands/approvals';
import { events, messages, plans, pullRequests } from '../db/schema/index';
import { approvalByNumber, loadRun, runByNumber, toApproval } from '../read/work';
import { IDS } from '../seed/test-world';
import { BUSY_POOL_SIZE } from '../test/db';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { checkoutEnv, startTestRunner, type TestRunner, waitFor } from '../test/runner';
import { SCRIPTED_ENV } from '../test/scripted';

const t = useTestServer({
  seed: true,
  listen: true,
  poolSize: BUSY_POOL_SIZE,
  env: { ...checkoutEnv(), ...SCRIPTED_ENV, ...signInsEnv() },
});
let runner: TestRunner;

beforeAll(async () => {
  // The demo's run checks its branch out on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
  await connectGitHubAs(t.services, IDS.mara);
  Object.assign(t.services.demo.options, { deployDelayMs: 50 });
  runner = await startTestRunner(t.baseUrl, { thinkMs: 30, tickMs: 25 });
});

afterAll(async () => {
  await runner?.stop();
});

const DEMO_HEADERS = { authorization: 'Bearer dev-runner-token' };

async function approval12() {
  const row = await approvalByNumber(t.services.db, t.burrowId, 12);
  if (!row) throw new Error('no approval #12');
  return toApproval(row);
}

async function storylineDone() {
  const a = await approval12();
  return a.execution.state === 'succeeded' ? a : null;
}

async function _eventText(type: string, actorId: string) {
  const rows = await t.services.db
    .select()
    .from(events)
    .where(and(eq(events.type, type), eq(events.actorId, actorId)))
    .orderBy(desc(events.seq));
  return rows[0];
}

async function roomMessages() {
  return t.services.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, IDS.pr482))
    .orderBy(asc(messages.createdAt), asc(messages.ord));
}

describe('the demo storyline', () => {
  it('rewinds to 11:22 and replays', async () => {
    const reset = await t.api.inject({
      method: 'POST',
      url: '/internal/demo/reset',
      headers: DEMO_HEADERS,
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    const runRow = await runByNumber(t.services.db, t.burrowId, 1907);
    expect(runRow).toMatchObject({
      status: 'live',
      progress: 55,
      // The seed world's line (the fixtures' world, which reads a person's review).
      activity: expect.stringContaining('review on PR #482'),
    });
    const run = await loadRun(t.services.db, runRow?.id ?? '');
    expect(run?.steps.map((s) => s.state)).toEqual(['active', 'queued', 'queued', 'queued', 'queued']);
    expect(run?.tests).toEqual({ passed: 38, total: 41 });
    const [prRow] = await t.services.db.select().from(pullRequests).where(eq(pullRequests.number, 482));
    expect(prRow?.headSha).toBe('e9f114');
    const a = await approval12();
    expect(a).toMatchObject({ state: 'pending', executedAt: null });
    const room = await roomMessages();
    expect(room.some((m) => m.text === 'Approved. Rounding order is right.')).toBe(false);
    const [plan] = await t.services.db.select().from(plans).where(eq(plans.id, 'pln_invoice-pdf'));
    expect(plan?.steps.map((s) => s.stateLabel)).toEqual(['Done', 'In progress', 'Reviewing', 'Needs you']);
    expect((await verifyBurrowChain(t.services.db, t.burrowId)).ok).toBe(true);

    // Replay: this time nobody approved in advance, so the deploy waits for a person.
    const play = await t.services.demo.play();
    expect(play.status).toBe('started');
    await waitFor(
      async () => {
        const r = await runByNumber(t.services.db, t.burrowId, 1907);
        return r?.status === 'done';
      },
      30_000,
      'the replayed run',
    );
    await t.services.demo.settled();
    await waitFor(
      async () => {
        const room2 = await roomMessages();
        return room2.at(-1)?.text === 'Approved. Rounding order is right.';
      },
      15_000,
      'the reviewer’s approval',
    );
    const waiting = await approval12();
    expect(waiting.state).toBe('pending');
    expect(waiting.conditions.filter((c) => c.kind !== 'person_approves').every((c) => c.met)).toBe(true);
    // Approving now deploys at once.
    await t.commit(IDS.mara, decideApproval, { number: 12, decision: 'approve' });
    const deployed = await waitFor(storylineDone, 10_000, 'the deploy');
    expect(deployed.execution.durationMs).toBe(134_000);
  });
});
