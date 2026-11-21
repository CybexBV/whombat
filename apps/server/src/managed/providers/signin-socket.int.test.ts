/**
 * The runner's sign-in routes on a unix socket (review I-1; docs/decisions/managed-runtime.md MR-34): with
 * `WHOMBAT_SIGNIN_SOCKET` the loopback port answers 404 for them, and a real `SignInWorker` completes a key sign-in
 * over the socket after checking who owns it.
 */
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignInWorker } from '@whombat/runner/signin';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, principals } from '../../db/schema/index';
import { IDS } from '../../seed/test-world';
import { useTestServer } from '../../test/harness';
import type { SessionPrincipal } from '../trust';
import { providerLogins } from './service';
import { listenSignInSocket } from './signin-socket';

const FAKES = fileURLToPath(
  new URL('../../../../../packages/agent-runtime/src/providers/testing/', import.meta.url),
);
const root = mkdtempSync(join(tmpdir(), 'wb-signin-sock-'));
const run = mkdtempSync(join(tmpdir(), 'wb-signin-run-'));
chmodSync(run, 0o711);
const socket = join(run, 'signin.sock');
const TOKEN = 'signin-socket-runner-token-000000000';
const t = useTestServer({
  seed: true,
  listen: true,
  // As on the appliance (NX-20): the credentials root is the runner's alone; the server reaches it only through the
  // sign-in bridge, and still offers sign-ins (SUB-56).
  env: {
    RUNNER_TOKEN: TOKEN,
    WHOMBAT_SIGNIN_SOCKET: socket,
  },
});

let listener: FastifyInstance;
let worker: SignInWorker;
let mara: SessionPrincipal;
beforeAll(async () => {
  providerLogins(t.services, { drift: async () => null });
  listener = await listenSignInSocket(t.services, socket);
  worker = new SignInWorker({
    serverUrl: 'http://signin.invalid',
    socketPath: socket,
    token: TOKEN,
    root,
    commands: { gh: join(FAKES, 'fake-gh.mjs') },
    verifyFetch: async () => ({ status: 200 }),
  });
  worker.start();
  const [p] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const [account] = await t.services.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, p?.accountId as string));
  mara = {
    peerId: 'peer-mara',
    publicKey: '00',
    endpoint: null,
    account: account as SessionPrincipal['account'],
    authzGeneration: 0,
  };
});
afterAll(async () => {
  await worker.stop();
  await listener.close();
});

describe('sign-in socket', () => {
  it('the loopback port no longer serves the runner’s sign-in routes', async () => {
    const res = await fetch(`${t.baseUrl}/internal/runner/signin/poll`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ waitMs: 0 }),
    });
    expect(res.status).toBe(404);
  });

  it('a key sign-in completes through the runner over the socket', async () => {
    const svc = providerLogins(t.services);
    const started = await svc.start(mara, { provider: 'codex', authMode: 'api_key' });
    const done = await svc.submit(mara, {
      loginId: started.loginId,
      secret: 'sk-test-socket-key-000000001',
    });
    expect(done).toMatchObject({ state: 'completed' });
    expect(await svc.record('codex')).not.toBeNull();
  });
});
