/**
 * Repositories created on the Whombat (docs/decisions/repositories.md, contracts CT-192): `repos.create` makes a bare
 * origin under the workspaces root with a first commit by the person, records it switched on with a signed event, and
 * refuses names in use and bad names without leaving anything on disk. Agents get the origin as their remote
 * without a token; GitHub's poller leaves it alone.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accounts, dispatches, events, principals, repos } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-local-repos-')));
const workspaces = join(base, 'workspaces');
const t = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_WORKSPACES: workspaces, WHOMBAT_HOME: join(base, '.whombat') },
});
const RUNNER = { authorization: 'Bearer dev-runner-token' };

async function create(principalId: string, payload: Record<string, unknown>) {
  const { cookie } = await sessionFor(t.services, principalId);
  return t.api.inject({
    method: 'POST',
    url: '/api/v1/burrows/burrow-hq/repos/local',
    headers: { cookie },
    payload,
  });
}

async function list(principalId: string) {
  const { cookie } = await sessionFor(t.services, principalId);
  const res = await t.api.inject({
    method: 'GET',
    url: '/api/v1/burrows/burrow-hq/repos',
    headers: { cookie },
  });
  return res.json() as {
    repos: { fullName: string; source?: string; path?: string | null; enabled: boolean }[];
    create?: { allowed: boolean; reason: string | null; author: { name: string; email: string } | null };
  };
}

const origins = () => {
  const dir = join(workspaces, '.origins', t.burrowId);
  return existsSync(dir) ? readdirSync(dir) : [];
};

async function maraEmail() {
  const [row] = await t.services.db
    .select({ email: accounts.email })
    .from(principals)
    .innerJoin(accounts, eq(accounts.id, principals.accountId))
    .where(eq(principals.id, IDS.mara));
  return row?.email ?? '';
}

describe('repos.create', () => {
  it('makes the repository on the Whombat, by the person, switched on', async () => {
    const before = await list(IDS.mara);
    expect(before.create).toEqual({
      allowed: true,
      reason: null,
      author: { name: 'Mara Okafor', email: await maraEmail() },
    });

    const res = await create(IDS.mara, { name: 'Whombat_Website', description: 'The public website.' });
    expect(res.statusCode).toBe(201);
    const { repo } = res.json() as { repo: Record<string, unknown> };
    expect(repo).toMatchObject({
      fullName: 'local/Whombat_Website',
      source: 'local',
      enabled: true,
      defaultBranch: 'main',
      description: 'The public website.',
    });
    expect(String(repo.path)).toMatch(/\.origins\/.+\/Whombat_Website\.git$/);

    const [row] = await t.services.db
      .select()
      .from(repos)
      .where(eq(repos.id, String(repo.id)));
    const origin = row?.originPath ?? '';
    expect(origin).toBe(join(workspaces, '.origins', t.burrowId, 'Whombat_Website.git'));
    const author = execFileSync('git', ['--git-dir', origin, 'log', '-1', '--format=%an <%ae>', 'main'], {
      encoding: 'utf8',
    }).trim();
    expect(author).toBe(`Mara Okafor <${await maraEmail()}>`);

    const [event] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'repo.created')));
    expect(event?.text).toBe('Created Whombat_Website on this Whombat');

    expect((await list(IDS.mara)).repos.map((r) => r.fullName)).toContain('local/Whombat_Website');
  });

  it.each([
    ['the same name', 'Whombat_Website', /already has a repository called Whombat_Website/],
    ['the same name in other letters', 'whombat_website', /already has a repository called whombat_website/],
    ['a GitHub repo’s name', 'billing', /whombat\/billing is already on this Whombat/],
  ])('refuses %s on the field, leaving nothing behind', async (_what, name, reason) => {
    const had = origins();
    const res = await create(IDS.mara, { name });
    expect(res.statusCode).toBe(400);
    const error = (res.json() as { error: { code: string; fields: Record<string, string[]> } }).error;
    expect(error.code).toBe('validation_failed');
    expect(error.fields.name?.[0]).toMatch(reason);
    expect(origins()).toEqual(had);
  });

  it('refuses names that aren’t a plain folder', async () => {
    for (const name of ['../escape', '.hidden', 'a b', 'site.git'])
      expect((await create(IDS.mara, { name })).statusCode).toBe(400);
    expect(origins()).toEqual(['Whombat_Website.git']);
  });

  it('gives agents its origin to fetch from, without a token, and GitHub’s poller leaves it alone', async () => {
    const [queued] = await enqueueDispatches(t.services, {
      burrowId: t.burrowId,
      causedById: IDS.mara,
      conversationId: IDS.billing,
      messageId: null,
      threadRootId: null,
      requests: [{ agentId: IDS.dusty, trigger: 'mention', mode: 'reply' }],
      at: new Date(),
    });
    const dispatchId = queued?.dispatchId ?? '';
    // Held by a runner: every runner call carries its lease whole (managed-sandbox.md MSB-10).
    const lease = { runnerId: 'rnr_local-repos-test', attempt: 1 };
    await t.services.db
      .update(dispatches)
      .set({ state: 'running', runnerId: lease.runnerId, attempts: lease.attempt })
      .where(eq(dispatches.id, dispatchId));
    const res = await t.api.inject({
      method: 'POST',
      url: `/internal/runner/dispatches/${dispatchId}/git-credentials`,
      headers: RUNNER,
      payload: { ...lease, repo: 'local/Whombat_Website', branch: 'feat/landing', operation: 'fetch' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      token: '',
      remoteUrl: join(workspaces, '.origins', t.burrowId, 'Whombat_Website.git'),
    });

    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    if (!row) throw new Error('no dispatch');
    const context = await buildDispatchContext(t.services, row);
    expect(JSON.stringify(context)).toMatch(/local\/Whombat_Website is a repository kept on this Whombat/);

    const targets = await t.services.github.poller.targets();
    expect(targets.map((x) => x.repo)).not.toContain('local/Whombat_Website');
  });
});
