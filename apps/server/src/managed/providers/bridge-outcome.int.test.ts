/**
 * A sign-in step without the runner's answer, over a session (docs/decisions/command-safety.md CS-04b): one the runner
 * took may have happened — `unknown_outcome`, a receipt that never runs it again and a `status` that never says
 * `not_found`; one it never took wasn't done — `unavailable`, and the same id may run again.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { commandReceipts } from '../../db/schema/index';
import { IDS } from '../../seed/test-world';
import { useManagedRuntime } from '../../test/managed';
import { type RequestAnswer, RequestControl } from '../dispatcher';
import type { SessionPrincipal } from '../trust';
import { providerLogins } from './service';

const root = mkdtempSync(join(tmpdir(), 'wb-bridge-outcome-'));
const m = useManagedRuntime({ seed: true, env: { WHOMBAT_CREDENTIALS_ROOT: root } });
let mara: SessionPrincipal;

beforeAll(async () => {
  const id = await m.enroll(IDS.mara);
  mara = await m.runtime.trust.identify(id.peerId, id.publicKey);
});

async function run(
  id: string,
  op: string,
  input: unknown,
  control = new RequestControl(null),
): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    mara,
    { id, op, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    control,
  );
  return answer as unknown as RequestAnswer;
}

async function receiptState(requestId: string) {
  const [row] = await m.t.services.db
    .select({ state: commandReceipts.state })
    .from(commandReceipts)
    .where(eq(commandReceipts.requestId, requestId));
  return row?.state;
}

const consoleInput = {
  params: {},
  body: { provider: 'claude', authMode: 'subscription_cli', cols: 80, rows: 24 },
};

describe('sign-in steps the runner never answered (CS-04b)', () => {
  it('a console start cancelled before the runner was asked: cancelled, not a failed console (CS-14)', async () => {
    const control = new RequestControl(null);
    control.cancelled = true;
    const id = 'req_console_cancel_0001';
    expect(await run(id, 'signins.consoleStart', consoleInput, control)).toMatchObject({
      type: 'error',
      code: 'cancelled',
    });
    expect(await receiptState(id)).toBe('not_executed');
  });

  it('taken: unknown, never run again; never taken: not done', async () => {
    const bridge = providerLogins(m.t.services).bridge;
    if (!bridge) throw new Error('this runtime signs in through the runner');
    const takenId = 'req_logout_taken_000001';
    const queuedId = 'req_logout_queued_00001';
    const taken = run(takenId, 'signins.logout', { params: { provider: 'codex' } });
    // The runner takes the first sign-out…
    expect((await bridge.poll(5_000)).map((r) => r.method)).toEqual(['logout']);
    // …and a console start (CS-14)…
    const consoleId = 'req_console_taken_00001';
    const consoleStart = run(consoleId, 'signins.consoleStart', consoleInput);
    expect((await bridge.poll(5_000)).map((r) => r.method)).toEqual(['consoleStart']);
    const queued = run(queuedId, 'signins.logout', { params: { provider: 'claude' } });
    await expect
      .poll(() => (bridge as unknown as { queue: unknown[] }).queue.length, { timeout: 5_000 })
      .toBe(1);
    // …and the server stops before either is answered.
    bridge.close();
    const [a, b, started] = await Promise.all([taken, queued, consoleStart]);
    // The runner may be running that console: unknown, never a completed “failed” console.
    expect(started).toMatchObject({ type: 'error', code: 'unknown_outcome' });
    expect(await receiptState(consoleId)).toBe('rejected');

    expect(a).toMatchObject({
      type: 'error',
      code: 'unknown_outcome',
      details: { code: 'provider.signin_unavailable' },
    });
    expect(await receiptState(takenId)).toBe('rejected');
    expect(await m.runtime.dispatcher.status(mara, takenId)).toMatchObject({
      state: 'rejected',
      outcome: { kind: 'error', code: 'unknown_outcome' },
    });
    expect(await run(takenId, 'signins.logout', { params: { provider: 'codex' } })).toMatchObject({
      type: 'error',
      code: 'unknown_outcome',
      replayed: true,
    });

    expect(b).toMatchObject({ type: 'error', code: 'unavailable', retryable: true });
    expect(await receiptState(queuedId)).toBe('not_executed');
    expect(await m.runtime.dispatcher.status(mara, queuedId)).toEqual({ state: 'not_found' });
  });
});
