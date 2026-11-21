/**
 * Servers in a backup file (backup-file.md BF-13…BF-15; BF-S30…BF-S48), two Whombats each with a fake hosts service:
 * the make panel offers servers only where they are watched; a file holds the hosts service's own backup byte for byte
 * and the choices per server; restoring it on the same Whombat is “already here” (choices follow keep/replace); on a
 * Whombat that watches other servers it is “can't come back”; in a burrow without servers “unavailable”; on an empty one
 * the hosts service takes the backup and restarts, the choices come back, and with “Point them here” the servers the
 * restorer has a Vault key for are pointed at the new address (the rest listed to point by hand); “Leave them”
 * changes nothing and Needs you doesn't ask the restorer again.
 *
 * Postgres: the whole backup pipeline (files, uploads, restores, the Vault, server choices) lives there.
 */
import { randomBytes } from 'node:crypto';
import {
  api,
  type BackupCategoryEstimate,
  type BackupRestorePreview,
  type BackupRestoreView,
  type BackupUploadView,
  buildPath,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBurrow } from '../commands/burrows';
import { burrows, needsYouSnoozes, principals, serverAsks } from '../db/schema/index';
import { setServerAsks } from '../hosts/asks';
import { startHosts, stopHosts } from '../hosts/index';
import { INSTALL_TIMING, installsFor } from '../hosts/install';
import { FakeHostsService } from '../hosts/testing/fake';
import { type FakeInstallSsh, fakeInstallSsh } from '../hosts/testing/fake-install-ssh';
import { IDS } from '../seed/test-world';
import { downloadBackup, uploadBackup } from '../test/backups';
import type { TestServer } from '../test/harness';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { addVaultSshServer } from '../vault/ssh-commands';
import { serversTiming } from './restore/servers';
import { backupsFor } from './service';

const hubA = new FakeHostsService();
const hubB = new FakeHostsService();
const env = (hub: FakeHostsService) => ({
  WHOMBAT_MASTER_KEY: randomBytes(32).toString('base64'),
  WHOMBAT_HOSTS_SOCKET: hub.socket,
  WHOMBAT_HOSTS_TOKEN_FILE: hub.tokenFile,
  WHOMBAT_LOCAL_NETWORK: 'on',
});
const a = useTestServer({ seed: true, app: true, env: env(hubA) });
const b = useTestServer({ seed: true, app: true, env: env(hubB) });

const PASSWORD = 'servers, carefully moved';
const url = (path: string, params: Record<string, string>) => `/api/v1${buildPath(path, params)}`;
let ssh: FakeInstallSsh;
let cookieA = '';
let cookieB = '';
let fileBytes: Buffer = Buffer.alloc(0);
const SERVERS = 10;

async function call(
  t: TestServer,
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
) {
  const res = await t.api.inject({
    method,
    url: path,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

async function upload(t: TestServer, cookie: string, slug: string): Promise<string> {
  const staged = await call(t, cookie, 'POST', url(api.backups.stage.path, { burrow: slug }), {
    fileName: 'servers.wbk',
    size: fileBytes.length,
  });
  expect(staged.status, JSON.stringify(staged.body)).toBe(201);
  const up = staged.body.upload as BackupUploadView;
  await uploadBackup(t.services, slug, cookie, up.id, fileBytes);
  return up.id;
}

async function inspect(
  t: TestServer,
  cookie: string,
  slug: string,
  id: string,
): Promise<BackupRestorePreview> {
  const res = await call(
    t,
    cookie,
    'POST',
    url(api.backups.inspect.path, { burrow: slug, stagedBackupId: id }),
    {
      password: PASSWORD,
    },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as BackupRestorePreview;
}

async function restore(
  t: TestServer,
  cookie: string,
  slug: string,
  id: string,
  body: Record<string, unknown>,
): Promise<BackupRestoreView> {
  const res = await call(
    t,
    cookie,
    'POST',
    url(api.backups.restore.path, { burrow: slug, stagedBackupId: id }),
    {
      password: PASSWORD,
      ...body,
    },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await backupsFor(t.services).settle();
  const done = await call(
    t,
    cookie,
    'GET',
    url(api.backups.getRestore.path, { burrow: slug, restoreId: (res.body.restore as BackupRestoreView).id }),
  );
  return done.body.restore as BackupRestoreView;
}

async function estimate(
  t: TestServer,
  cookie: string,
  slug: string,
): Promise<BackupCategoryEstimate | undefined> {
  const res = await call(t, cookie, 'GET', url(api.backups.estimate.path, { burrow: slug }));
  expect(res.status).toBe(200);
  return (res.body.categories as BackupCategoryEstimate[]).find((c) => c.id === 'servers');
}

const asksOf = async (t: TestServer, server: string) =>
  (
    await t.services.db
      .select({ asksFirst: serverAsks.asksFirst })
      .from(serverAsks)
      .where(eq(serverAsks.serverId, server))
  )[0]?.asksFirst ?? null;

/** An empty hub at the new box's address, with its own authority. */
function freshHubB(): void {
  hubB.clearServers();
  hubB.hubMeta.ca_sha256 = randomBytes(32).toString('hex');
  hubB.hubMeta.agents_url = 'wss://10.100.1.158:8443';
  hubB.hubMeta.agent_url_previous = null;
  hubB.hubMeta.agent_url_changed_at = null;
}

beforeAll(async () => {
  await hubA.start();
  await hubB.start();
  hubA.agents.serve = true;
  hubB.agents.serve = true;
  hubB.restartMs = 50;
  freshHubB();
  serversTiming.pollMs = 50;
  const basalt = (hubA.fleet.servers as Record<string, unknown>[]).find((s) => s.id === 'basalt');
  if (basalt) basalt.address = '10.100.0.31';
  ssh = await fakeInstallSsh();
  ssh.users.set('root', { password: null, uid: 0, sudo: 'nopasswd', authorized: [] });
  cookieA = (await sessionFor(a.services, IDS.mara)).cookie;
  cookieB = (await sessionFor(b.services, IDS.mara)).cookie;
  useVaultNetForTests(b.services, {
    resolve: async (host) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (addr) => (addr.startsWith('10.100.0.') ? '127.0.0.1' : addr),
    deadlineMs: 3000,
  });
  installsFor(b.services).timing = { ...INSTALL_TIMING, signInMs: 3000, reportMs: 1500, pollMs: 100 };
  startHosts(a.services);
  startHosts(b.services);

  // On A: Mara's Vault key for basalt (it travels in the file), and Whombat asks before risky actions on basalt (not
  // the default, Never, so the choice is a row that travels in the file).
  const made = await call(a, cookieA, 'POST', '/api/v1/burrows/burrow-hq/vault', {
    name: 'Servers',
    kind: 'ssh',
    sshKey: { mode: 'generate' },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const entry = made.body.entry as { id: string; auth: { publicKey: string } };
  expect(
    (
      await a.commit(IDS.mara, addVaultSshServer, {
        entryId: entry.id,
        name: 'basalt',
        host: '10.100.0.31',
        port: ssh.port,
        username: 'root',
      })
    ).status,
  ).toBe('ok');
  (ssh.users.get('root') as { authorized: string[] }).authorized.push(entry.auth.publicKey);
  expect(
    (
      await a.commit(IDS.mara, setServerAsks, {
        serverId: 'basalt',
        serverName: 'basalt',
        asksFirst: 'risky',
      })
    ).status,
  ).toBe('ok');

  const file = await call(a, cookieA, 'POST', url(api.backups.create.path, { burrow: 'burrow-hq' }), {
    categories: ['vault', 'servers'],
    password: PASSWORD,
  });
  expect(file.status, JSON.stringify(file.body)).toBe(201);
  await backupsFor(a.services).settle();
  const view = (
    await call(
      a,
      cookieA,
      'GET',
      url(api.backups.get.path, { burrow: 'burrow-hq', backupFileId: (file.body.file as { id: string }).id }),
    )
  ).body.file as { id: string; status: string; includesSecrets: boolean; error: unknown };
  expect(view.status, JSON.stringify(view.error)).toBe('ready');
  expect(view.includesSecrets).toBe(true);
  fileBytes = await downloadBackup(a.services, 'burrow-hq', cookieA, view.id);
});

afterAll(async () => {
  stopHosts(a.services);
  stopHosts(b.services);
  await ssh?.close();
  await hubA.stop();
  await hubB.stop();
});

describe('making a file with the servers', () => {
  it('offers the servers where they are watched, counted from the hosts service', async () => {
    expect(await estimate(a, cookieA, 'burrow-hq')).toMatchObject({ offered: true, count: SERVERS });
    const defaults = await call(a, cookieA, 'GET', url(api.backups.defaults.path, { burrow: 'burrow-hq' }));
    expect(defaults.body.categories).toContain('servers');
  });

  it('took the hosts service’s backup as admin', () => {
    const asked = hubA.calls('GET', '/api/v1/hub/backup');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.at(-1)?.role).toBe('admin');
  });

  it('isn’t offered in a burrow that doesn’t watch the servers, and is left out of its file', async () => {
    const [mara] = await a.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    const other = await createBurrow(a.services, mara?.accountId as string, 'Side Project', {
      besideOwn: true,
    });
    const [burrow] = await a.services.db.select().from(burrows).where(eq(burrows.id, other.burrowId));
    const cookie = (await sessionFor(a.services, other.principalId)).cookie;
    const slug = burrow?.slug as string;
    expect(await estimate(a, cookie, slug)).toMatchObject({ offered: false, count: 0 });
    const defaults = await call(a, cookie, 'GET', url(api.backups.defaults.path, { burrow: slug }));
    expect(defaults.body.categories).not.toContain('servers');
    const asked = await call(a, cookie, 'POST', url(api.backups.create.path, { burrow: slug }), {
      categories: ['servers'],
      password: PASSWORD,
    });
    expect(asked.status).toBeGreaterThanOrEqual(400);
    expect((asked.body.error as { details?: { code?: string } }).details?.code).toBe(
      'backup_file.nothing_chosen',
    );
  });
});

describe('restoring the servers', () => {
  it('is already here on the Whombat that made it; a changed choice follows keep or replace', async () => {
    const id = await upload(a, cookieA, 'burrow-hq');
    const same = await inspect(a, cookieA, 'burrow-hq', id);
    expect(same.servers).toMatchObject({ state: 'here', count: SERVERS, address: null });
    expect(same.categories.find((c) => c.id === 'servers')).toMatchObject({ here: SERVERS, different: 0 });

    await a.commit(IDS.mara, setServerAsks, { serverId: 'basalt', serverName: 'basalt', asksFirst: 'never' });
    expect(await asksOf(a, 'basalt')).toBe('never');
    const changed = await inspect(a, cookieA, 'burrow-hq', id);
    expect(changed.categories.find((c) => c.id === 'servers')).toMatchObject({
      here: SERVERS - 1,
      different: 1,
    });
    const kept = await restore(a, cookieA, 'burrow-hq', id, { categories: ['servers'] });
    expect(kept.summary?.categories.find((c) => c.id === 'servers')).toMatchObject({ kept: 1 });
    expect(kept.summary?.servers ?? null).toBeNull();
    expect(await asksOf(a, 'basalt')).toBe('never');

    const again = await upload(a, cookieA, 'burrow-hq');
    const replaced = await restore(a, cookieA, 'burrow-hq', again, {
      categories: ['servers'],
      onDifferent: 'replace',
    });
    expect(replaced.summary?.categories.find((c) => c.id === 'servers')).toMatchObject({ updated: 1 });
    expect(await asksOf(a, 'basalt')).toBe('risky');
    // Nothing went to the hosts service.
    expect(hubA.calls('POST', '/api/v1/hub/restore')).toHaveLength(0);
  });

  it('can’t come back where other servers are watched, nor in a burrow without servers', async () => {
    hubB.fleet.servers = [{ id: 'pve-09', hostname: 'pve-09', agent_connected: true, status: 'online' }];
    const id = await upload(b, cookieB, 'burrow-hq');
    expect((await inspect(b, cookieB, 'burrow-hq', id)).servers).toMatchObject({
      state: 'blocked',
      count: SERVERS,
      blockedBy: 1,
      address: null,
    });
    const blocked = await restore(b, cookieB, 'burrow-hq', id, { categories: ['servers'] });
    expect(blocked.summary?.categories.find((c) => c.id === 'servers')).toMatchObject({ skipped: SERVERS });
    expect(hubB.calls('POST', '/api/v1/hub/restore')).toHaveLength(0);
    freshHubB();

    const [mara] = await b.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    const other = await createBurrow(b.services, mara?.accountId as string, 'Elsewhere', {
      besideOwn: true,
    });
    const [burrow] = await b.services.db.select().from(burrows).where(eq(burrows.id, other.burrowId));
    const cookie = (await sessionFor(b.services, other.principalId)).cookie;
    const there = await upload(b, cookie, burrow?.slug as string);
    expect((await inspect(b, cookie, burrow?.slug as string, there)).servers).toMatchObject({
      state: 'unavailable',
      count: SERVERS,
    });
  });

  it('leaves them out at once when the hosts service can’t apply the backup', async () => {
    hubB.failNextRestore = true;
    const started = Date.now();
    const id = await upload(b, cookieB, 'burrow-hq');
    const failed = await restore(b, cookieB, 'burrow-hq', id, { categories: ['servers'] });
    expect(failed.status).toBe('done');
    expect(failed.summary?.categories.find((c) => c.id === 'servers')).toMatchObject({ skipped: SERVERS });
    expect(failed.summary?.servers ?? null).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    freshHubB();
    hubB.hubMeta.restore_error = null;
  });

  it('brings them back to an empty hosts service, and points the ones it has a key for here', async () => {
    const id = await upload(b, cookieB, 'burrow-hq');
    const preview = await inspect(b, cookieB, 'burrow-hq', id);
    expect(preview.servers).toEqual({
      state: 'new',
      count: SERVERS,
      blockedBy: null,
      address: { from: '10.100.0.2', to: '10.100.1.158' },
    });
    expect(preview.categories.find((c) => c.id === 'servers')).toMatchObject({ new: SERVERS });

    ssh.installer = () => {
      hubB.report('basalt');
      return { stdout: 'whombat-agent: kept basalt\n', code: 0 };
    };
    const done = await restore(b, cookieB, 'burrow-hq', id, { categories: ['vault', 'servers'] });
    expect(done.status).toBe('done');
    // The hosts service got A's backup byte for byte, as admin, and came back with A's authority.
    expect(hubB.restored.at(-1)?.equals(hubA.hubBackupBytes())).toBe(true);
    expect(hubB.calls('POST', '/api/v1/hub/restore').at(-1)?.role).toBe('admin');
    expect(hubB.hubMeta.ca_sha256).toBe(hubA.hubMeta.ca_sha256);
    expect(done.summary?.categories.find((c) => c.id === 'servers')).toMatchObject({ added: SERVERS });
    expect(await asksOf(b, 'basalt')).toBe('risky');
    // basalt is pointed here with the restored Vault key, its agent's own lock left as it was; the rest by hand.
    const servers = done.summary?.servers;
    expect(servers).toMatchObject({ back: SERVERS, pointed: 1 });
    expect(servers?.toPoint).toHaveLength(SERVERS - 1);
    expect(servers?.toPoint.map((s) => s.id)).not.toContain('basalt');
    expect(ssh.runs.at(-1)?.control).toBe('');
  });

  it('changes nothing with Leave them, and Needs you doesn’t ask the restorer again', async () => {
    freshHubB();
    const runs = ssh.runs.length;
    const id = await upload(b, cookieB, 'burrow-hq');
    const done = await restore(b, cookieB, 'burrow-hq', id, {
      categories: ['servers'],
      servers: { pointHere: false },
    });
    expect(done.summary?.servers).toEqual({ back: SERVERS, pointed: 0, toPoint: [] });
    expect(ssh.runs).toHaveLength(runs);
    const ignored = await b.services.db
      .select()
      .from(needsYouSnoozes)
      .where(and(eq(needsYouSnoozes.personId, IDS.mara), eq(needsYouSnoozes.refKind, 'address_change')));
    expect(ignored.map((r) => [r.refId, r.state])).toEqual([[hubB.hubMeta.agent_url_changed_at, 'ignored']]);
  });
});
