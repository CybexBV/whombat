/**
 * Test helpers for the GitHub integration: the fake, a poll cycle on demand, linked logins, a person's sign-in, and a
 * burrow's GitHub connected as someone's own sign-in (what agents' git and `gh` run on, HE-S166).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureCredentialHome,
  githubTokenLogin,
  writeCredentialMeta,
} from '@whombat/agent-runtime/providers';
import { eq } from 'drizzle-orm';
import { githubConnections, githubIdentities, principals } from '../db/schema/index';
import type { FakeGitHub } from '../github/fake';
import type { PollReport } from '../github/poller';
import { providerLogins } from '../managed/providers/service';
import { TEST_BURROW_ID } from '../seed/test-world';
import type { Services } from '../services';
import type { TestServer } from './harness';

/** A fake `gh` (agent-runtime's): `auth login --with-token` keeps the token in the home, `auth token` prints it. */
export const FAKE_GH = fileURLToPath(
  new URL('../../../../packages/agent-runtime/src/providers/testing/fake-gh.mjs', import.meta.url),
);

export function fakeOf(t: TestServer): FakeGitHub {
  const fake = t.services.github.fake;
  if (!fake) throw new Error('the test server runs without FakeGitHub');
  return fake;
}

/** One poll cycle for the test burrow — what the server does every 30 seconds. Fails on a repo error. */
export async function syncGitHub(t: TestServer, burrowId = t.burrowId): Promise<PollReport> {
  const report = await t.services.github.poller.pollNow({ burrowId });
  if (report.errors.length) throw new Error(`poll failed: ${report.errors.join('; ')}`);
  return report;
}

/** Links a GitHub login to a principal of the test burrow (connecting links the gh login this way). */
export async function linkLogin(t: TestServer, login: string, principalId: string) {
  await t.services.db
    .insert(githubIdentities)
    .values({ burrowId: t.burrowId, login: login.toLowerCase(), principalId })
    .onConflictDoNothing();
}

/**
 * A person's own GitHub sign-in (what connecting a burrow needs, essentials-agents.md EA-10): its record in the
 * suite's credentials root (`WHOMBAT_CREDENTIALS_ROOT`, read with `WHOMBAT_SIGNIN_EXECUTOR=local`). With the fake, the
 * token itself is never used.
 */
export async function signInToGitHub(root: string, _accountId: string, login = 'whombat') {
  const home = await ensureCredentialHome(root, 'github');
  await writeCredentialMeta(home, {
    v: 1,
    provider: 'github',
    authMode: 'token',
    createdAt: '2026-09-25T10:00:00.000Z',
    expiresAt: null,
    verified: 'valid',
    verifiedAt: null,
    creatorAttested: false,
    login,
    signal: null,
  });
}

/**
 * A suite's provider sign-ins in a folder of its own, read in this process (no runner relays them): with
 * `connectGitHubAs`, what agents' git and `gh` need.
 */
export function signInsEnv(): Record<string, string> {
  return {
    WHOMBAT_CREDENTIALS_ROOT: mkdtempSync(join(tmpdir(), 'wb-signins-')),
    WHOMBAT_SIGNIN_EXECUTOR: 'local',
  };
}

/**
 * The burrow's GitHub connected as `principalId`'s own GitHub sign-in (EA-10, HE-S166): their token in their credential
 * home (through the fake gh, which the in-process sign-ins use from here on) and the burrow's connection. Agents' git
 * fetches and pushes and their `gh` then run on it (`managedGitToken`). Needs `signInsEnv()`; call it before anything
 * else reads sign-ins.
 */
export async function connectGitHubAs(
  services: Services,
  principalId: string,
  options: { login?: string; token?: string; burrowId?: string } = {},
): Promise<void> {
  const root = services.config.WHOMBAT_CREDENTIALS_ROOT;
  if (!root) throw new Error('connectGitHubAs: the suite has no WHOMBAT_CREDENTIALS_ROOT (signInsEnv)');
  const login = options.login ?? 'whombat';
  providerLogins(services, { commands: { gh: FAKE_GH } });
  const [person] = await services.db.select().from(principals).where(eq(principals.id, principalId));
  if (!person?.accountId) throw new Error(`${principalId} has no account`);
  const home = await ensureCredentialHome(root, 'github');
  mkdirSync(join(home, 'home'), { recursive: true });
  const signedIn = await githubTokenLogin({ command: FAKE_GH, home }, options.token ?? 'github_pat_test');
  if (!signedIn.ok) throw new Error(`connectGitHubAs: ${signedIn.message}`);
  await writeCredentialMeta(home, {
    v: 1,
    provider: 'github',
    authMode: 'token',
    createdAt: '2026-09-25T10:00:00.000Z',
    expiresAt: null,
    verified: 'valid',
    verifiedAt: null,
    creatorAttested: false,
    login,
    signal: null,
  });
  const burrowId = options.burrowId ?? TEST_BURROW_ID;
  const values = { login, githubUserId: null, connectedById: principalId };
  await services.db
    .insert(githubConnections)
    .values({ burrowId, ...values })
    .onConflictDoUpdate({ target: githubConnections.burrowId, set: values });
  await services.db
    .insert(githubIdentities)
    .values({ burrowId, login: login.toLowerCase(), principalId })
    .onConflictDoNothing();
}
