/**
 * GitHub in managed mode (PV-06): a burrow's GitHub work runs as the person who connected it, with their own GitHub
 * sign-in (read through the sign-in executor); a departed connector stops it; calls without a repo run as the
 * scope's account. The transport is a fake fetch that records whose token each request carried.
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
import { beforeAll, describe, expect, it } from 'vitest';
import { githubConnections, principals } from '../../db/schema/index';
import { GitHubNotConnectedError } from '../../github/adapter';
import { IDS, TEST_BURROW_ID } from '../../seed/test-world';
import { useTestServer } from '../../test/harness';
import { githubScope, ManagedGitHub } from './github-adapter';
import { providerLogins } from './service';

const root = mkdtempSync(join(tmpdir(), 'wb-mgh-'));
const t = useTestServer({
  seed: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: root, WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
const gh = fileURLToPath(
  new URL('../../../../../packages/agent-runtime/src/providers/testing/fake-gh.mjs', import.meta.url),
);
const seen: string[] = [];
const accounts: Record<string, string> = {};

const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  seen.push(auth.replace(/^Bearer /, ''));
  const path = new URL(String(url)).pathname;
  const body =
    path === '/user' ? { login: 'someone', id: 1 } : { number: 1, state: 'open', head: {}, base: {} };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

async function signInGitHub(_accountId: string, token: string) {
  const home = await ensureCredentialHome(root, 'github');
  mkdirSync(join(home, 'home'), { recursive: true });
  expect(await githubTokenLogin({ command: gh, home }, token)).toEqual({ ok: true });
  await writeCredentialMeta(home, {
    v: 1,
    provider: 'github',
    authMode: 'token',
    createdAt: '2026-09-25T10:00:00.000Z',
    expiresAt: null,
    verified: 'valid',
    verifiedAt: null,
    creatorAttested: false,
    login: 'octo',
    signal: null,
  });
}

beforeAll(async () => {
  providerLogins(t.services, { commands: { gh } });
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  accounts.mara = row?.accountId as string;
  await signInGitHub(accounts.mara as string, 'gho_mara');
  await t.services.db
    .insert(githubConnections)
    .values({ burrowId: TEST_BURROW_ID, login: 'mara-gh', githubUserId: 1, connectedById: IDS.mara })
    .onConflictDoUpdate({ target: githubConnections.burrowId, set: { connectedById: IDS.mara } });
});

describe('ManagedGitHub', () => {
  it('answers the burrow’s connection login outside a request scope (MA-03)', async () => {
    // A command's apply runs without githubScope: the burrow has to be named.
    expect(await t.services.github.connectionLoginFor(TEST_BURROW_ID)).toBe('mara-gh');
    expect(await t.services.github.connectionLogin()).not.toBe('mara-gh');
  });

  it('reads a burrow’s repo as the person who connected it', async () => {
    const adapter = new ManagedGitHub(t.services, { fetch: fakeFetch });
    await adapter.getPullRequest('whombat/billing', 1).catch(() => null);
    expect(seen.at(-1)).toBe('gho_mara');
    // A git token never comes from the adapter (agents use their credential owner's).
    await expect(adapter.gitToken()).rejects.toBeInstanceOf(GitHubNotConnectedError);
  });

  it('acts as the scope’s account without a repo (connecting)', async () => {
    const adapter = new ManagedGitHub(t.services, { fetch: fakeFetch });
    seen.length = 0;
    await githubScope.run({ accountId: accounts.mara as string }, () => adapter.whoami()).catch(() => null);
    expect(seen.at(-1)).toBe('gho_mara');
    await expect(adapter.whoami()).rejects.toBeInstanceOf(GitHubNotConnectedError);
  });

  it('stops when the connector left the burrow', async () => {
    const adapter = new ManagedGitHub(t.services, { fetch: fakeFetch });
    await t.services.db.update(principals).set({ accountId: null }).where(eq(principals.id, IDS.mara));
    const before = seen.length;
    await expect(adapter.getPullRequest('whombat/billing', 1)).rejects.toThrow(/isn’t on this Whombat/);
    expect(seen.length).toBe(before);
  });
});
