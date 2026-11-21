/**
 * Connecting GitHub (S-07, S-10, essentials-agents.md EA-10): the status says as whom; the person with their own GitHub
 * sign-in connects a burrow (signed "Connected GitHub as @login"), and every repository that account owns comes with it,
 * then and later (agent-repos.md AGR-08…AGR-11); older apps' picker and switch still answer. Without a GitHub sign-in of
 * their own they are told to sign in first.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, buildPath } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBurrow as createBurrowFor } from '../commands/burrows';
import { burrows, events, githubConnections, githubIdentities, repos } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { fakeOf, signInToGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { accountOf, sessionFor } from '../test/tokens';

// People's GitHub sign-ins in a folder of this suite's, read in this process.
const signIns = mkdtempSync(join(tmpdir(), 'wb-github-connect-'));
const t = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: signIns, WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
let mara = '';
let fresh = '';

beforeAll(async () => {
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

const url = (ep: { base: string; path: string }, burrow: string, query = '') =>
  `${ep.base}${buildPath(ep.path, { burrow })}${query}`;

async function call(method: 'GET' | 'POST' | 'PATCH', path: string, cookie: string, payload?: object) {
  const res = await t.api.inject({ method, url: path, headers: { cookie }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() };
}

/** Another burrow beside the box's own (one-agent.md OA-01), owned by `principalId`'s account: its slug. */
async function createBurrow(principalId: string, name: string): Promise<string> {
  const { burrowId } = await createBurrowFor(t.services, await accountOf(t.services, principalId), name, {
    besideOwn: true,
  });
  const [row] = await t.services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  if (!row) throw new Error('no burrow');
  return row.slug;
}

describe('who may', () => {
  it('the person without a GitHub sign-in of their own is told to sign in first, then connects', async () => {
    // Mara hasn't signed in to GitHub yet.
    const hers = await createBurrow(IDS.mara, 'Mara Lab');
    const status = await call('GET', url(api.github.status, hers), mara);
    expect(status.body).toMatchObject({ connected: false, canConnect: false, signInNeeded: true });
    const refused = await call('POST', url(api.github.connect, hers), mara);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ fix: 'sign in to GitHub' });
    const reposOfHers = await t.services.db
      .select()
      .from(repos)
      .innerJoin(burrows, eq(burrows.id, repos.burrowId))
      .where(eq(burrows.slug, hers));
    expect(reposOfHers).toEqual([]);
    // Her own GitHub sign-in (as the fake's account, `whombat`): signed in, she may.
    await signInToGitHub(signIns, await accountOf(t.services, IDS.mara));
    expect((await call('POST', url(api.github.connect, hers), mara)).status).toBe(200);
    // She may connect another burrow of hers with the same sign-in.
    const second = await createBurrow(IDS.mara, 'Moss Two');
    expect((await call('POST', url(api.github.connect, second), mara)).status).toBe(200);
  });
});

describe('status', () => {
  it('the seeded burrow is on the fake; the person with a GitHub sign-in may connect', async () => {
    const owner = await call('GET', url(api.github.status, 'burrow-hq'), mara);
    expect(owner.body).toMatchObject({
      mode: 'fake',
      connected: true,
      error: null,
      fix: null,
      canConnect: true,
      signInNeeded: false,
    });
  });
});

describe('connecting a new burrow', () => {
  it('starts not connected: no picker yet', async () => {
    fresh = await createBurrow(IDS.mara, 'Moss Works');
    const status = await call('GET', url(api.github.status, fresh), mara);
    expect(status.body).toMatchObject({ connected: false, login: null, canConnect: true });
    const picker = await call('GET', url(api.github.repos, fresh), mara);
    expect(picker.status).toBe(409);
    expect(picker.body.error.message).toBe('Connect GitHub first.');
  });

  it('connects as the person’s own GitHub account, signed by them, and links the login to them', async () => {
    // A repository of someone else's the account reaches: it doesn't come with the connection.
    await fakeOf(t).addRepo({ fullName: 'acme/site' });
    const res = await call('POST', url(api.github.connect, fresh), mara);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: true, login: 'whombat', error: null });
    const [burrow] = await t.services.db.select().from(burrows).where(eq(burrows.slug, fresh));
    if (!burrow) throw new Error('no burrow');
    expect(burrow.onboarding.githubConnected).toBe(true);
    const [row] = await t.services.db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.burrowId, burrow.id));
    expect(row).toMatchObject({ login: 'whombat', githubUserId: 4242 });
    const [identity] = await t.services.db
      .select()
      .from(githubIdentities)
      .where(eq(githubIdentities.burrowId, burrow.id));
    expect(identity).toMatchObject({ login: 'whombat', principalId: row?.connectedById });
    const [connected] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, burrow.id), eq(events.type, 'github.connected')));
    expect(connected).toMatchObject({ text: 'Connected GitHub as @whombat', actorId: row?.connectedById });

    // Every repository the account owns came with it, switched on, in one event signed by the person (AGR-08).
    const own = (await fakeOf(t).listRepos(300, { owned: true })).repos.map((r) => r.fullName);
    expect(own.length).toBeGreaterThan(1);
    const rows = await reposOf(fresh);
    expect(rows.map((r) => r.fullName).sort()).toEqual([...own].sort());
    expect(rows.every((r) => r.enabled)).toBe(true);
    const synced = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, burrow.id), eq(events.type, 'github.repos_synced')));
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ actorId: row?.connectedById, payload: { count: own.length } });
  });

  it('older apps: the picker lists, adding by name works and is always on, switching off is refused', async () => {
    const picker = await call('GET', url(api.github.repos, fresh, '?limit=50'), mara);
    expect(picker.status).toBe(200);
    expect(picker.body.repos.find((r: { fullName: string }) => r.fullName === 'whombat/web')).toMatchObject({
      added: true,
      enabled: true,
    });

    // Someone else's repository by name: added, on.
    const added = await call('POST', url(api.repos.add, fresh), mara, { fullName: 'acme/site' });
    expect(added.status).toBe(200);
    expect(added.body.repo).toMatchObject({ fullName: 'acme/site', enabled: true });
    // “Add switched off”: on all the same (AGR-11).
    const off = await call('POST', url(api.repos.add, fresh), mara, {
      fullName: 'whombat/web',
      enabled: false,
    });
    expect(off.body.repo).toMatchObject({ fullName: 'whombat/web', enabled: true });
    const repoId = off.body.repo.id as string;
    const update = `${api.repos.update.base}${buildPath(api.repos.update.path, { burrow: fresh, repoId })}`;
    const refused = await call('PATCH', update, mara, { enabled: false });
    expect(refused.status).toBe(409);
    expect((await reposOf(fresh)).find((r) => r.id === repoId)?.enabled).toBe(true);

    const unknown = await call('POST', url(api.repos.add, fresh), mara, { fullName: 'whombat/nope' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toContain('whombat/nope');
  });

  it('Sync repos re-reads them, brings in one made on GitHub since, and switches one that was off back on', async () => {
    const fake = fakeOf(t);
    const web = fake.repos.get('whombat/web');
    if (!web) throw new Error('no fake repo');
    web.language = 'Svelte';
    await fake.addRepo({ fullName: 'whombat/made-since' });
    // Switched off before this build (the migration switches these on; an older binary could do it again).
    const [docs] = (await reposOf(fresh)).filter((r) => r.fullName === 'whombat/docs');
    if (!docs) throw new Error('no docs repo');
    await t.services.db.update(repos).set({ enabled: false }).where(eq(repos.id, docs.id));

    const res = await call('POST', url(api.repos.sync, fresh), mara);
    expect(res.status).toBe(200);
    expect(res.body.githubConnected).toBe(true);
    const byName = (name: string) => res.body.repos.find((r: { fullName: string }) => r.fullName === name);
    expect(byName('whombat/web')).toMatchObject({ language: 'Svelte' });
    expect(byName('whombat/made-since')).toMatchObject({ enabled: true });
    expect(byName('whombat/docs')).toMatchObject({ enabled: true });
  });

  it('the poller brings in a repository made on GitHub later by itself', async () => {
    await fakeOf(t).addRepo({ fullName: 'whombat/made-later' });
    expect((await reposOf(fresh)).some((r) => r.fullName === 'whombat/made-later')).toBe(false);
    await t.services.github.poller.pollDue();
    const row = (await reposOf(fresh)).find((r) => r.fullName === 'whombat/made-later');
    expect(row).toMatchObject({ enabled: true, source: 'github' });
  });
});

/** The repos of the burrow `slug`. */
async function reposOf(slug: string) {
  const rows = await t.services.db
    .select({ repo: repos })
    .from(repos)
    .innerJoin(burrows, eq(burrows.id, repos.burrowId))
    .where(eq(burrows.slug, slug));
  return rows.map((r) => r.repo);
}
