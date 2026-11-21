/**
 * GitHub just works once a person signs in (resourceful-agents.md RA-DS52; John: “We should not have to assign a
 * developer agent to GitHub, this should be the default setting”):
 *
 *  - the person's own GitHub sign-in connects every burrow of theirs that nobody connected yet, from any client, signed
 *    “Connected GitHub as @…” by them; a burrow connected already keeps its connection;
 *  - a repository added to the burrow by name is on for agents (agent-repos.md AGR-11).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { events, githubConnections, principals, repos } from '../db/schema/index';
import type { RequestAnswer } from '../managed/dispatcher';
import { RequestControl } from '../managed/dispatcher';
import { providerLogins } from '../managed/providers/service';
import type { SessionPrincipal } from '../managed/trust';
import { IDS } from '../seed/test-world';
import { extraBurrow, useManagedRuntime } from '../test/managed';
import { addRepo } from './commands';

const root = mkdtempSync(join(tmpdir(), 'wb-gh-autoconnect-'));
const FAKES = fileURLToPath(
  new URL('../../../../packages/agent-runtime/src/providers/testing/', import.meta.url),
);
const m = useManagedRuntime({
  seed: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: root, WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
let mara: SessionPrincipal;
/** Mara owns both. Fern Ltd was connected by someone already. */
let moss: { burrowId: string; principalId: string };
let fern: { burrowId: string; principalId: string };

beforeAll(async () => {
  providerLogins(m.t.services, {
    commands: { gh: join(FAKES, 'fake-gh.mjs') },
    fetch: async () => ({ status: 200 }),
    drift: async () => null,
  });
  const [maraRow] = await m.t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const maraAccount = maraRow?.accountId as string;
  moss = await extraBurrow(m.t.services, maraAccount, 'Moss Co');
  fern = await extraBurrow(m.t.services, maraAccount, 'Fern Ltd');
  await m.t.services.db.insert(githubConnections).values({
    burrowId: fern.burrowId,
    login: 'fern-gh',
    githubUserId: null,
    connectedById: fern.principalId,
  });
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

/** Signs `who` in to GitHub with a token (the card's “Use a token instead”). */
async function signInWithToken(who: SessionPrincipal, token: string) {
  const started = await run(who, 'signins.loginStart', { body: { provider: 'github', authMode: 'token' } });
  const loginId = (started as { output: { loginId: string } }).output.loginId;
  const done = await run(who, 'signins.loginSubmit', { params: { loginId }, body: { secret: token } });
  expect(done).toMatchObject({ type: 'result', output: { state: 'completed' } });
}

const connectionOf = async (burrowId: string) =>
  (
    await m.t.services.db.select().from(githubConnections).where(eq(githubConnections.burrowId, burrowId))
  )[0] ?? null;

describe('signing in to GitHub connects (RA-DS52)', () => {
  it('the person’s sign-in connects the burrows nobody connected, and leaves a connected one alone', async () => {
    await signInWithToken(mara, 'gho_mara_token');
    const conn = await connectionOf(moss.burrowId);
    expect(conn).toMatchObject({ connectedById: moss.principalId });
    const [signed] = await m.t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, moss.burrowId), eq(events.type, 'github.connected')));
    expect(signed).toMatchObject({ actorId: moss.principalId, text: `Connected GitHub as @${conn?.login}` });
    expect(signed?.payload).toMatchObject({ via: 'signin' });
    // Fern Ltd keeps the connection it had.
    expect(await connectionOf(fern.burrowId)).toMatchObject({ login: 'fern-gh' });
  });

  it('a repository added by name is on for agents', async () => {
    const added = await m.t.services.pipeline.commit(
      addRepo,
      {
        repo: {
          id: 4242,
          fullName: 'acme/whombat-website',
          description: null,
          language: 'HTML',
          defaultBranch: 'main',
          pushedAt: null,
          private: true,
        },
      },
      { burrowId: moss.burrowId, actorId: moss.principalId },
    );
    expect(added.status).toBe('ok');
    const [row] = await m.t.services.db
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, moss.burrowId), eq(repos.fullName, 'acme/whombat-website')));
    expect(row?.enabled).toBe(true);
  });
});
