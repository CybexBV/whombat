/**
 * The provider sign-in ops over a session (`signins.*`, contracts 1.0.0): allowlisted and routed to the sign-in
 * service; `signins.loginSubmit` is a `secret` op whose receipt keeps no digest of its input.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestDigest } from '@whombat/protocol/session';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { commandReceipts } from '../../db/schema/index';
import { IDS } from '../../seed/test-world';
import { useManagedRuntime } from '../../test/managed';
import type { RequestAnswer } from '../dispatcher';
import { RequestControl } from '../dispatcher';
import type { SessionPrincipal } from '../trust';
import { providerLogins } from './service';

const root = mkdtempSync(join(tmpdir(), 'wb-session-ops-'));
const FAKES = fileURLToPath(
  new URL('../../../../../packages/agent-runtime/src/providers/testing/', import.meta.url),
);
const m = useManagedRuntime({
  seed: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: root, WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
let mara: SessionPrincipal;

beforeAll(async () => {
  providerLogins(m.t.services, {
    commands: { gh: join(FAKES, 'fake-gh.mjs') },
    fetch: async () => ({ status: 200 }),
    drift: async () => null,
  });
  const id = await m.enroll(IDS.mara);
  mara = await m.runtime.trust.identify(id.peerId, id.publicKey);
});

async function run(
  principal: SessionPrincipal,
  id: string,
  op: string,
  input: unknown,
): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    principal,
    { id, op, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    new RequestControl(null),
  );
  return answer as unknown as RequestAnswer;
}

describe('provider ops over a session', () => {
  it('are allowlisted', () => {
    const ops = m.runtime.dispatcher.allowedOps(mara);
    for (const op of [
      'signins.list',
      'signins.loginStart',
      'signins.loginSubmit',
      'signins.loginStatus',
      'signins.loginCancel',
      'signins.logout',
    ])
      expect(ops, op).toContain(op);
  });

  it('sign in with a key; the submit receipt keeps no digest of the secret', async () => {
    const started = await run(mara, 'req_start_1', 'signins.loginStart', {
      body: { provider: 'codex', authMode: 'api_key' },
    });
    expect(started).toMatchObject({ type: 'result', output: { state: 'awaiting_secret' } });
    const loginId = (started as { output: { loginId: string } }).output.loginId;
    const secret = 'sk-test-session-key-000001';
    const done = await run(mara, 'req_submit_1', 'signins.loginSubmit', {
      params: { loginId },
      body: { secret },
    });
    expect(done).toMatchObject({ type: 'result', output: { state: 'completed', verified: 'valid' } });
    const [receipt] = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(
        and(eq(commandReceipts.op, 'signins.loginSubmit'), eq(commandReceipts.requestId, 'req_submit_1')),
      );
    expect(receipt?.digest).toBe(requestDigest('signins.loginSubmit', null));
    expect(receipt?.digest).not.toBe(
      requestDigest('signins.loginSubmit', { params: { loginId }, body: { secret } }),
    );
    expect(JSON.stringify(receipt)).not.toContain(secret);
    const list = await run(mara, 'req_list_1', 'signins.list', {});
    expect(list).toMatchObject({
      type: 'result',
      output: { signIns: [expect.objectContaining({ provider: 'codex' })] },
    });
  });
});
