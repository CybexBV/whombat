/**
 * Managed Whombats connect GitHub with the person's own GitHub sign-in (docs/decisions/essentials-agents.md EA-10,
 * contracts CT-181), over a session as the web does it:
 *
 *  - `github.status` tells the person without a GitHub sign-in to sign in (`signInNeeded`), never the
 *    host `gh` text;
 *  - `github.connect` refuses until the person signed in (409, “Sign in to GitHub … first”);
 *  - the person signs in with GitHub's device flow (the fake `gh`: the code and github.com's link, then approved);
 *  - signing in connects the burrow as that person (RA-DS52): its GitHub runs as their sign-in, named in the status, and
 *    the page's own connect after it changes and signs nothing;
 *  - their sign-in gone, the status says so and asks them to sign in again.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { events, githubConnections, principals } from '../../db/schema/index';
import { IDS } from '../../seed/test-world';
import { extraBurrow, useManagedRuntime } from '../../test/managed';
import { waitFor } from '../../test/runner';
import type { RequestAnswer } from '../dispatcher';
import { RequestControl } from '../dispatcher';
import type { SessionPrincipal } from '../trust';
import { providerLogins } from './service';

const root = mkdtempSync(join(tmpdir(), 'wb-gh-signin-'));
const FAKES = fileURLToPath(
  new URL('../../../../../packages/agent-runtime/src/providers/testing/', import.meta.url),
);
const m = useManagedRuntime({
  seed: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: root, WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
let mara: SessionPrincipal;
let maraAccount = '';
/** A burrow of Mara's with no GitHub yet. */
const BURROW = 'moss-co';

beforeAll(async () => {
  providerLogins(m.t.services, {
    commands: { gh: join(FAKES, 'fake-gh.mjs') },
    fetch: async () => ({ status: 200 }),
    drift: async () => null,
  });
  const [row] = await m.t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  maraAccount = row?.accountId as string;
  await extraBurrow(m.t.services, maraAccount, 'Moss Co');
  mara = await m.runtime.trust.identify(...(await ids(IDS.mara)));
});

async function ids(principalId: string): Promise<[string, string]> {
  const id = await m.enroll(principalId);
  return [id.peerId, id.publicKey];
}

async function run(principal: SessionPrincipal, op: string, input: unknown): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    principal,
    { id: `req_${Math.random().toString(36).slice(2, 10)}`, op, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    new RequestControl(null),
  );
  return answer as unknown as RequestAnswer;
}

const status = async (who: SessionPrincipal) => {
  const answer = await run(who, 'github.status', { params: { burrow: BURROW } });
  expect(answer.type).toBe('result');
  return (answer as { output: Record<string, unknown> }).output;
};

describe('GitHub on a managed Whombat', () => {
  it('the person without a GitHub sign-in is asked to sign in, not to run gh', async () => {
    expect(await status(mara)).toMatchObject({
      connected: false,
      signInNeeded: true,
      canConnect: false,
      error: null,
      login: null,
    });
    expect(JSON.stringify(await status(mara))).not.toMatch(/gh auth|on the host/);
  });

  it('connect refuses until the person has their own GitHub sign-in', async () => {
    const answer = await run(mara, 'github.connect', { params: { burrow: BURROW } });
    expect(answer).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/^Sign in to GitHub with your own GitHub account first/),
    });
  });

  it('signs in with GitHub’s device flow, then connects as that person', async () => {
    const started = await run(mara, 'signins.loginStart', {
      body: { provider: 'github', authMode: 'device' },
    });
    expect(started).toMatchObject({
      type: 'result',
      output: {
        state: 'awaiting_user',
        device: { verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234' },
      },
    });
    const loginId = (started as { output: { loginId: string } }).output.loginId;
    const staging = readdirSync(root).find((n) => n.startsWith('.staging-github'));
    writeFileSync(join(root, staging as string, '.fake-device'), 'approve');
    await waitFor(
      async () => {
        const s = await run(mara, 'signins.loginStatus', { params: { loginId } });
        return (s as { output?: { state?: string } }).output?.state === 'completed' || null;
      },
      10_000,
      'the device sign-in',
    );
    // Signing in connected the burrow she owns, which nobody had connected (RA-DS52): no second button to find.
    expect(await status(mara)).toMatchObject({
      signInNeeded: false,
      canConnect: true,
      connected: true,
      note: 'GitHub runs as Mara Okafor’s own GitHub sign-in.',
    });
    const signedBefore = await m.t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'github.connected'));

    // The page connects too (app AP-543): the same connection, nothing signed twice.
    const connected = await run(mara, 'github.connect', { params: { burrow: BURROW } });
    expect(connected).toMatchObject({
      type: 'result',
      output: {
        connected: true,
        signInNeeded: false,
        note: 'GitHub runs as Mara Okafor’s own GitHub sign-in.',
      },
    });
    const [conn] = await m.t.services.db.select().from(githubConnections);
    const [connectedBy] = await m.t.services.db
      .select()
      .from(principals)
      .where(eq(principals.id, conn?.connectedById ?? ''));
    expect(connectedBy?.accountId).toBe(maraAccount);
    const signed = await m.t.services.db.select().from(events).where(eq(events.type, 'github.connected'));
    expect(signed).toHaveLength(signedBefore.length);
    expect(signed[0]?.payload).toMatchObject({ via: 'signin' });
  });

  it('when the connector’s sign-in is gone, the status says so and asks them to sign in again', async () => {
    rmSync(join(root, 'github'), { recursive: true, force: true });
    expect(await status(mara)).toMatchObject({
      connected: true,
      signInNeeded: true,
      canConnect: false,
      fix: 'sign in to GitHub',
      error: expect.stringContaining('sign-in is gone'),
    });
  });
});
