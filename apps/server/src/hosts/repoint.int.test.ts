/**
 * Pointing servers at this Whombat (backup-file.md BF-15, BF-16; BF-S35…BF-S40) against the fake hosts service and an
 * in-process SSH server: a server with a Vault SSH key for its address is signed in to and its agent updated in place
 * (no `--control`, the hub's switches left as they are, signed as a repoint); one without a key is `no_key`; one whose
 * agent reports elsewhere fails with the sign-in's reason; one that found the Whombat itself is `pointed` at once. And
 * BF-16's Needs you item: the person only, after five minutes, gone when the servers are back.
 *
 * Postgres: the Vault keys and the signed change live there, and Home reads the person's row.
 */
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events } from '../db/schema/index';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { addVaultSshServer } from '../vault/ssh-commands';
import { startHosts } from './index';
import { INSTALL_TIMING, installsFor } from './install';
import { RepointBusy, repointsFor } from './repoint';
import { hostsFor } from './service';
import { hostsNeedsYou } from './sources';
import { FakeHostsService } from './testing/fake';
import { type FakeInstallSsh, fakeInstallSsh } from './testing/fake-install-ssh';

const hub = new FakeHostsService();
const t = useTestServer({
  seed: true,
  listen: true,
  env: {
    WHOMBAT_HOSTS_SOCKET: hub.socket,
    WHOMBAT_HOSTS_TOKEN_FILE: hub.tokenFile,
    WHOMBAT_LOCAL_NETWORK: 'on',
  },
});

let ssh: FakeInstallSsh;
let personCookie = '';

type Card = Record<string, unknown>;
const card = (id: string) => (hub.fleet.servers as Card[]).find((s) => s.id === id) as Card;

/** The server stopped reporting (it dials the old address) and reported its own address before. */
function lost(id: string, address: string): void {
  Object.assign(card(id), { agent_connected: false, status: 'offline', address });
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function vaultKey(name: string, host: string): Promise<{ id: string; publicKey: string }> {
  const res = await t.api.inject({
    method: 'POST',
    url: '/api/v1/burrows/burrow-hq/vault',
    headers: { cookie: personCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ name, kind: 'ssh', sshKey: { mode: 'generate' } }),
  });
  expect(res.statusCode, res.body).toBe(201);
  const entry = (res.json() as { entry: { id: string; auth: { publicKey: string } } }).entry;
  const added = await t.commit(IDS.mara, addVaultSshServer, {
    entryId: entry.id,
    name: `${name} server`,
    host,
    port: ssh.port,
    username: 'root',
  });
  expect(added.status).toBe('ok');
  return { id: entry.id, publicKey: entry.auth.publicKey };
}

const plan = (servers: string[]) => ({
  burrowId: TEST_BURROW_ID,
  personId: IDS.mara,
  actor: { id: IDS.mara, name: 'Mara', role: 'admin' as const },
  servers,
});

beforeAll(async () => {
  await hub.start();
  hub.agents.serve = true;
  ssh = await fakeInstallSsh();
  ssh.users.set('root', { password: null, uid: 0, sudo: 'nopasswd', authorized: [] });
  personCookie = (await sessionFor(t.services, IDS.mara)).cookie;
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (a) => (a.startsWith('10.100.0.') ? '127.0.0.1' : a),
    deadlineMs: 3000,
  });
  installsFor(t.services).timing = { ...INSTALL_TIMING, signInMs: 3000, reportMs: 1500, pollMs: 100 };
  startHosts(t.services);
  await waitFor(() => hub.streams === 1);
});

afterAll(async () => {
  await ssh?.close();
  await hub.stop();
});

describe('pointing servers here', () => {
  it('signs in with the Vault key for each address, updates the agent in place and says how each went', async () => {
    lost('basalt', '10.100.0.31');
    lost('shale', '10.100.0.32');
    lost('blackbox', '10.100.0.33');
    const key = await vaultKey('Servers', '10.100.0.31');
    await vaultKey('Blackbox', '10.100.0.33');
    (ssh.users.get('root') as { authorized: string[] }).authorized.push(key.publicKey);
    // The blackbox key isn't on the server, so the sign-in is refused; basalt's agent is updated in place.
    ssh.installer = () => {
      hub.report('basalt');
      return { stdout: 'whombat-agent: os Ubuntu 24.04 LTS · amd64\nwhombat-agent: kept basalt\n', code: 0 };
    };
    const patchesBefore = hub.calls('PATCH', '/api/v1/servers/basalt').length;
    const started = await repointsFor(t.services).start(plan(['basalt', 'shale', 'blackbox', 'quartz']));
    expect(started.state).toBe('running');
    await expect(repointsFor(t.services).start(plan(['basalt']))).rejects.toThrow(RepointBusy);
    const done = await repointsFor(t.services).finished(started.id);
    const by = Object.fromEntries((done?.servers ?? []).map((s) => [s.id, s]));
    expect(done?.state).toBe('done');
    expect(done?.to).toBe('10.100.0.2');
    expect(by.basalt).toMatchObject({ state: 'pointed', error: null, address: '10.100.0.31' });
    expect(by.shale).toMatchObject({ state: 'no_key', address: '10.100.0.32' });
    expect(by.blackbox?.state).toBe('failed');
    expect(by.blackbox?.error?.code).toBe('sign_in_failed');
    // Found this Whombat by itself (BF-17): nothing to sign in to.
    expect(by.quartz?.state).toBe('pointed');
    expect(by.quartz?.installId).toBeNull();

    // The installer ran without a level (the agent's own lock stays) and the hub's switches weren't touched.
    expect(ssh.runs.at(-1)?.control).toBe('');
    expect(hub.calls('PATCH', '/api/v1/servers/basalt')).toHaveLength(patchesBefore);
    const [signed] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'hosts.change'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(signed?.text).toContain('Pointed basalt');
    expect((signed?.payload as { op?: string } | undefined)?.op).toBe('repoint');

    expect(repointsFor(t.services).get(started.id, IDS.mara)?.servers).toHaveLength(4);
  });
});

describe('the routes', () => {
  const base = '/api/v1/burrows/burrow-hq/hosts';
  const as = async (cookie: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await t.api.inject({
      method,
      url: `${base}${path}`,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  it('starts a repoint for the person and answers the job', async () => {
    const started = await as(personCookie, 'POST', '/repoints', { servers: ['shale'] });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ state: 'running', to: '10.100.0.2' });
    expect(started.body).not.toHaveProperty('servers.0.installId');
    const id = String(started.body.id);
    await repointsFor(t.services).finished(id);
    const read = await as(personCookie, 'GET', `/repoints/${id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ state: 'done', servers: [{ id: 'shale', state: 'no_key' }] });
    expect((await as(personCookie, 'GET', '/repoints/hrp_unknown')).status).toBe(404);
    // Nothing changed address: nothing to say.
    expect((await as(personCookie, 'GET', '/address-change')).body).toBeNull();
  });
});

describe('an address change on the same Whombat (BF-16)', () => {
  const ctx = (personId: string) => ({
    db: t.services.db,
    burrowId: TEST_BURROW_ID,
    personId,
    now: new Date(),
    services: t.services,
  });

  it('asks the person to point the servers here five minutes after, and is gone when they are back', async () => {
    lost('shale', '10.100.0.32');
    lost('marble', '10.100.0.34');
    hub.moveHub('wss://10.100.0.9:8443', new Date(Date.now() - 60_000));
    hostsFor(t.services).forget();
    // Not yet: agents get five minutes to find it themselves.
    expect((await hostsNeedsYou(ctx(IDS.mara))).some((i) => i.ref.kind === 'address_change')).toBe(false);

    const changedAt = new Date(Date.now() - 6 * 60_000);
    hub.hubMeta.agent_url_changed_at = changedAt.toISOString();
    hostsFor(t.services).forget();
    const items = await hostsNeedsYou(ctx(IDS.mara));
    const item = items.find((i) => i.ref.kind === 'address_change');
    expect(item?.ref.id).toBe(changedAt.toISOString());
    expect(item?.title).toContain('10.100.0.2');
    expect(item?.title).toContain('10.100.0.9');
    expect(item?.actions[0]).toMatchObject({ kind: 'open', href: '/things/servers?repoint=1' });

    // The app reads the same change to point them here.
    const read = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/hosts/address-change',
      headers: { cookie: personCookie },
    });
    const change = read.json() as {
      from: string;
      to: string;
      waiting: { id: string; address: string | null }[];
    };
    expect(change).toMatchObject({ from: '10.100.0.2', to: '10.100.0.9' });
    expect(change.waiting.find((w) => w.id === 'shale')?.address).toBe('10.100.0.32');

    for (const s of hub.fleet.servers as Card[]) hub.report(String(s.id));
    hostsFor(t.services).forget();
    expect((await hostsNeedsYou(ctx(IDS.mara))).some((i) => i.ref.kind === 'address_change')).toBe(false);
  });
});
