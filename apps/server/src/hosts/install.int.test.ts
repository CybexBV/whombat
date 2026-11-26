/**
 * Add a server by signing in once (server-signin.md SI-01…SI-11; server-signin-server.md SI-S01…) against an in-process
 * SSH server (`fake-install-ssh.ts`) and the fake hosts service: root with a password, a sudo user with a password
 * (keyboard-interactive only), a Vault key with passwordless sudo, sudo wanting a password, a wrong password, sudo
 * refused, a host key that differs from the Vault's trusted one, a server that can't reach Whombat, another Whombat's
 * agent, an agent already there (kept), a first report that doesn't come, SI-09's key left behind, the routes (limits,
 * refused addresses), pre-approved enrollments, and `server_add`'s card through `/mcp`. The password
 * appears nowhere but on the server's stdin.
 */
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changes,
  connectionTools,
  events,
  messages,
  vaultEntries,
  vaultSshServers,
} from '../db/schema/index';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { startHosts } from './index';
import { INSTALL_TIMING, installsFor } from './install';
import { ensureServersConnection } from './provision';
import { FakeHostsService } from './testing/fake';
import { type FakeInstallRun, type FakeInstallSsh, fakeInstallSsh } from './testing/fake-install-ssh';

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
const frames: BusFrame[] = [];
const ROOT_PASSWORD = 'correct-horse-root-7731';
const DEPLOY_PASSWORD = 'deploy-pass-0451';
const OPS_SUDO = 'ops-sudo-9902';
const MAC_PASSWORD = 'mac-login-pass-6610';

const base = '/api/v1/burrows/burrow-hq/hosts';

async function as(method: string, path: string, body?: unknown) {
  const res = await t.api.inject({
    method: method as 'GET',
    url: path.startsWith('/api/') ? path : `${base}${path}`,
    headers: {
      cookie: personCookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return {
    status: res.statusCode,
    raw: res.body,
    body: res.json() as Record<string, unknown> & {
      error?: { code: string; message: string; fields?: Record<string, string[]> };
    },
  };
}

type Job = {
  id: string;
  state: string;
  hostKey: { algorithm: string; fingerprint: string } | null;
  hostKeyNew: boolean;
  serverId: string | null;
  serverName: string | null;
  system: string | null;
  already: boolean;
  keptKey: boolean;
  error: { code: string; message: string } | null;
  detail: string | null;
  finishedAt: string | null;
};

async function waitFor<T>(fn: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Starts a job and waits until it ends. */
async function install(body: Record<string, unknown>): Promise<Job> {
  const started = await as('POST', '/installs', body);
  expect(started.status, started.raw).toBe(202);
  const id = (started.body as unknown as Job).id;
  return waitFor(async () => {
    const res = await as('GET', `/installs/${id}`);
    const job = res.body as unknown as Job;
    return job.state === 'ready' || job.state === 'failed' ? job : null;
  });
}

const at = (n: number) => `10.100.0.${n}:${ssh.port}`;
/** A server reached only over the tailnet, and the box's own tailnet address it is reached from. */
const overTailnet = (n: number) => `100.101.0.${n}:${ssh.port}`;
const TAILNET_SOURCE = '100.64.0.3';

/** The real installer's lines for a server added as `hostname`. */
function added(hostname: string, options: { report?: boolean } = {}) {
  return (run: FakeInstallRun) => {
    const id = hub.claim(run.token, hostname, { report: options.report ?? true });
    return {
      stdout: `Installing whombat-agent…\nAdded to Whombat as ${id}.\nwhombat-agent: os Debian GNU/Linux 13 (trixie) · amd64 · Proxmox VE 9.0\nwhombat-agent: added ${id}\n`,
      code: 0,
    };
  };
}

async function newVaultKey(name: string): Promise<{ id: string; publicKey: string }> {
  const res = await as('POST', '/api/v1/burrows/burrow-hq/vault', {
    name,
    kind: 'ssh',
    sshKey: { mode: 'generate' },
  });
  expect(res.status, res.raw).toBe(201);
  const entry = res.body.entry as { id: string; auth: { publicKey: string } };
  return { id: entry.id, publicKey: entry.auth.publicKey };
}

beforeAll(async () => {
  await hub.start();
  ssh = await fakeInstallSsh();
  ssh.users.set('root', { password: ROOT_PASSWORD, uid: 0, sudo: 'nopasswd', authorized: [] });
  ssh.users.set('deploy', { password: DEPLOY_PASSWORD, uid: 1000, sudo: 'password', authorized: [] });
  ssh.users.set('ops', { password: null, uid: 1001, sudo: 'nopasswd', authorized: [] });
  ssh.users.set('keyonly', {
    password: null,
    uid: 1002,
    sudo: 'password',
    sudoPassword: OPS_SUDO,
    authorized: [],
  });
  ssh.users.set('guest', { password: 'guest-pass', uid: 1003, sudo: 'refused', authorized: [] });
  ssh.users.set('john', { password: MAC_PASSWORD, uid: 501, sudo: 'password', authorized: [] });
  hub.macos.password = MAC_PASSWORD;
  personCookie = (await sessionFor(t.services, IDS.mara)).cookie;
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (a) => (/^(10\.100\.0|100\.10[12]\.0)\./.test(a) ? '127.0.0.1' : a),
    // Servers at 100.101.0.x are reached over the tailnet: the box's end of the connection is its tailnet address.
    // At 100.102.0.x the box's end is in the same range but isn't one of the hub's addresses (another VPN).
    sourceAddress: (a) =>
      a.startsWith('100.101.0.') ? TAILNET_SOURCE : a.startsWith('100.102.0.') ? '100.70.0.9' : undefined,
    deadlineMs: 3000,
  });
  installsFor(t.services).timing = { ...INSTALL_TIMING, signInMs: 3000, reportMs: 1500, pollMs: 100 };
  t.services.bus.onFrame((f) => {
    if (f.topic.startsWith('hosts:')) frames.push(f);
  });
  startHosts(t.services);
  await waitFor(() => hub.streams === 1);
});

afterAll(async () => {
  await ssh?.close();
  await hub.stop();
});

describe('signing in once', () => {
  it('adds a server as root with a password, step by step, and signs it', async () => {
    ssh.installer = added('pve-03');
    const before = frames.length;
    const job = await install({
      address: at(14),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    });
    expect(job).toMatchObject({
      state: 'ready',
      serverId: 'pve-03',
      serverName: 'pve-03',
      system: 'Proxmox VE 9.0 · Debian GNU/Linux 13 (trixie) · amd64',
      already: false,
      keptKey: false,
      error: null,
      detail: null,
      hostKeyNew: true,
      hostKey: ssh.hostKey(),
    });
    // Each step a frame; clients refetch.
    const states = frames
      .slice(before)
      .map((f) => f.event as unknown as { type: string; installId: string; state: string })
      .filter((e) => e.type === 'hosts.install' && e.installId === job.id)
      .map((e) => e.state);
    expect([...new Set(states)]).toEqual(['connecting', 'installing', 'waiting', 'ready']);
    // The enrollment came only after the sign-in, pre-approved with the level, as Mara (admin).
    const enroll = hub.calls('POST', '/api/v1/enrollments').at(-1);
    expect(enroll?.body).toEqual({ approve: true, control: 'full' });
    expect(enroll?.actor).toBe('prn_mara|Mara Okafor');
    expect(enroll?.role).toBe('admin');
    // The installer ran as root from a mktemp file, the token on stdin, and the file is gone.
    const run = ssh.runs.at(-1);
    expect(run).toMatchObject({ user: 'root', way: 'root', control: 'full', script: hub.installScript });
    expect([...ssh.files.keys()].filter((f) => f.startsWith('/tmp/'))).toEqual([]);
    expect(hub.switchesOf('pve-03')).toMatchObject({ console: true, manage: true, host_shell: true });
    // Signed as Mara, for Done recently.
    const [signed] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'hosts.change'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(signed).toMatchObject({ actorId: IDS.mara, text: 'Added pve-03 with full control' });
    const [change] = await t.services.db
      .select()
      .from(changes)
      .where(eq(changes.kind, 'hosts.install'))
      .orderBy(desc(changes.createdAt))
      .limit(1);
    expect(change?.title).toBe('Added pve-03 with full control');
  });

  it('becomes root through sudo -S with the password on stdin, keyboard-interactive only', async () => {
    ssh.passwordMethod = false;
    ssh.installer = added('web-1');
    try {
      const job = await install({
        address: at(15),
        username: 'deploy',
        auth: { kind: 'password', password: DEPLOY_PASSWORD },
        control: 'operate',
        name: 'web-one',
      });
      expect(job).toMatchObject({ state: 'ready', serverId: 'web-one' });
    } finally {
      ssh.passwordMethod = true;
    }
    expect(ssh.tries.some((x) => x.user === 'deploy' && x.method === 'keyboard-interactive')).toBe(true);
    const run = ssh.runs.at(-1);
    expect(run).toMatchObject({ user: 'deploy', way: 'sudo_password', control: 'operate' });
    const ran = ssh.commands.filter((c) => c.user === 'deploy');
    const installer = ran.find((c) => c.command.includes('--token -'));
    expect(installer?.command).toMatch(/^sudo -k -S -p '' sh \/tmp\/tmp\.\w+ --token - --control operate$/);
    expect(installer?.stdin).toBe(`${DEPLOY_PASSWORD}\n${run?.token}\n`);
    expect(hub.calls('POST', '/api/v1/enrollments').at(-1)?.body).toEqual({
      approve: true,
      control: 'operate',
      name: 'web-one',
    });
    expect(hub.switchesOf('web-one')).toMatchObject({
      console: true,
      power: true,
      manage: false,
      host_shell: false,
    });
  });

  it('signs in with a Vault key and passwordless sudo', async () => {
    const key = await newVaultKey('Ops key');
    (ssh.users.get('ops') as { authorized: string[] }).authorized.push(key.publicKey);
    ssh.installer = added('ops-box');
    const job = await install({
      address: at(16),
      username: 'ops',
      auth: { kind: 'vault', entryId: key.id },
      control: 'watch',
    });
    expect(job).toMatchObject({ state: 'ready', serverId: 'ops-box' });
    expect(ssh.runs.at(-1)).toMatchObject({ user: 'ops', way: 'sudo', control: 'watch' });
    expect(ssh.tries.filter((x) => x.user === 'ops').map((x) => x.method)).toContain('publickey');
    expect(hub.switchesOf('ops-box')).toMatchObject({ console: false, power: false, diagnose: true });
  });

  it('says sudo wants a password when a key signed in, and makes no enrollment', async () => {
    const key = await newVaultKey('Key only');
    (ssh.users.get('keyonly') as { authorized: string[] }).authorized.push(key.publicKey);
    const enrollments = hub.enrollments.length;
    const job = await install({
      address: at(17),
      username: 'keyonly',
      auth: { kind: 'vault', entryId: key.id },
      control: 'full',
    });
    expect(job.error).toEqual({
      code: 'sudo_password_needed',
      message: `Signed in, but sudo on ${at(17)} asks for a password. Add it under “Password for sudo”.`,
    });
    expect(hub.enrollments.length).toBe(enrollments);
    // With the password for sudo it goes through; a wrong one is said plainly.
    const wrong = await install({
      address: at(17),
      username: 'keyonly',
      auth: { kind: 'vault', entryId: key.id, password: 'not-it' },
      control: 'full',
    });
    expect(wrong.error).toEqual({
      code: 'sudo_password_needed',
      message: `Signed in, but sudo on ${at(17)} didn’t take that password.`,
    });
    ssh.installer = added('keyonly-box');
    const right = await install({
      address: at(17),
      username: 'keyonly',
      auth: { kind: 'vault', entryId: key.id, password: OPS_SUDO },
      control: 'full',
    });
    expect(right).toMatchObject({ state: 'ready', serverId: 'keyonly-box' });
  });

  it('refuses a wrong password before any token exists', async () => {
    const enrollments = hub.enrollments.length;
    const job = await install({
      address: at(18),
      username: 'root',
      auth: { kind: 'password', password: 'wrong-password' },
      control: 'full',
    });
    expect(job).toMatchObject({
      state: 'failed',
      error: {
        code: 'sign_in_failed',
        message: `Couldn’t sign in to ${at(18)}: the user name or password isn’t right.`,
      },
      hostKey: ssh.hostKey(),
      detail: null,
    });
    expect(hub.enrollments.length).toBe(enrollments);
  });

  it('says when the user may not use sudo', async () => {
    const job = await install({
      address: at(19),
      username: 'guest',
      auth: { kind: 'password', password: 'guest-pass' },
      control: 'full',
    });
    expect(job.error?.code).toBe('sudo_refused');
  });

  it('enforces a key the Vault trusts for that address, and sends nothing to another', async () => {
    const key = await newVaultKey('Pinned');
    const add = await as('POST', `/api/v1/burrows/burrow-hq/vault/${key.id}/servers`, {
      name: 'pinned',
      host: '10.100.0.20',
      port: ssh.port,
      username: 'root',
    });
    expect(add.status, add.raw).toBe(201);
    const serverId = String(add.body.serverId);
    const trust = async (fingerprint: string) =>
      t.services.db
        .update(vaultSshServers)
        .set({
          hostKeyAlgorithm: 'ssh-ed25519',
          hostKeyFingerprint: fingerprint,
          hostKeyTrustedAt: new Date(),
        })
        .where(eq(vaultSshServers.id, serverId));
    await trust('SHA256:somebodyElsesKeyAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const tries = ssh.tries.length;
    const changed = await install({
      address: at(20),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    });
    expect(changed).toMatchObject({
      state: 'failed',
      error: { code: 'host_key_changed' },
      hostKey: ssh.hostKey(),
      hostKeyNew: false,
    });
    expect(changed.error?.message).toContain('showed a different key than the one your Vault trusts');
    // Not even the user name went: no sign-in was tried.
    expect(ssh.tries.length).toBe(tries);
    await trust(ssh.hostKey().fingerprint);
    ssh.installer = added('pinned');
    const matched = await install({
      address: at(20),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    });
    expect(matched).toMatchObject({ state: 'ready', hostKeyNew: false, hostKey: ssh.hostKey() });
  });
});

describe('what the installer says', () => {
  it('says the server can’t reach this Whombat, with More detail and no secrets', async () => {
    let token = '';
    ssh.installer = (run) => {
      token = run.token;
      return {
        stdout: `Installing whombat-agent with token ${run.token}…\n`,
        stderr: `install.sh: cannot reach https://10.100.0.2:8443/download/whombat-agent-linux-amd64 (${ROOT_PASSWORD})\n`,
        code: 1,
      };
    };
    const job = await install({
      address: at(21),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    });
    expect(job.error).toEqual({
      code: 'cant_reach_whombat',
      message: `${at(21)} can’t reach this Whombat at 10.100.0.2:8443. Is it on another network?`,
    });
    expect(job.detail).toContain('install.sh: cannot reach https://10.100.0.2:8443/download/');
    expect(token).not.toBe('');
    expect(job.detail).not.toContain(token);
    expect(job.detail).not.toContain(ROOT_PASSWORD);
    expect(hub.tokens.has(token)).toBe(false);
  });

  it('gives a server reached over the tailnet the box’s tailnet address to call home on', async () => {
    ssh.installer = added('far-1');
    const job = await install({
      address: overTailnet(14),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'watch',
    });
    expect(job).toMatchObject({ state: 'ready', serverId: 'far-1', error: null });
    expect(hub.calls('GET', '/api/v1/agent-install.sh').at(-1)?.query.get('via')).toBe('100.64.0.3');

    // One that can't download from there says so with that address.
    ssh.installer = () => ({
      stdout: '',
      stderr: 'install.sh: cannot reach https://100.64.0.3:8443/download/whombat-agent-linux-amd64\n',
      code: 1,
    });
    const failed = await install({
      address: overTailnet(15),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'watch',
    });
    expect(failed.error?.code).toBe('cant_reach_whombat');
    expect(failed.error?.message).toContain('100.64.0.3:8443');

    // A server on the box's own network keeps the box's LAN address (the hub's own choice).
    ssh.installer = added('near-1');
    const near = await install({
      address: at(16),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'watch',
    });
    expect(near).toMatchObject({ state: 'ready', serverId: 'near-1' });
    expect(hub.calls('GET', '/api/v1/agent-install.sh').at(-1)?.query.has('via')).toBe(false);
  });

  it('asks for the tailnet installer on the hub’s own listener, whatever port the agents’ address names', async () => {
    // The agents' address is a forwarded port; the hub's listener on the tailnet is its own 8443.
    const agentsUrl = hub.hubMeta.agents_url;
    hub.hubMeta.agents_url = 'wss://hosts.example:443';
    try {
      ssh.installer = () => ({
        stdout: '',
        stderr: 'install.sh: cannot reach https://100.64.0.3:8443/download/whombat-agent-linux-amd64\n',
        code: 1,
      });
      const job = await install({
        address: overTailnet(17),
        username: 'root',
        auth: { kind: 'password', password: ROOT_PASSWORD },
        control: 'watch',
      });
      expect(job.error?.code).toBe('cant_reach_whombat');
      expect(job.error?.message).toContain('at 100.64.0.3:8443.');
    } finally {
      hub.hubMeta.agents_url = agentsUrl;
    }
  });

  it('keeps the hub’s own address when the hub doesn’t have the one the connection came from', async () => {
    ssh.installer = added('vpn-1');
    const before = hub.calls('GET', '/api/v1/agent-install.sh').length;
    const job = await install({
      address: `100.102.0.14:${ssh.port}`,
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'watch',
    });
    expect(job).toMatchObject({ state: 'ready', serverId: 'vpn-1', error: null });
    const asked = hub.calls('GET', '/api/v1/agent-install.sh').slice(before);
    expect(asked.map((c) => c.query.get('via'))).toEqual(['100.70.0.9', null]);
  });

  it('leaves a server of another Whombat alone', async () => {
    ssh.installer = () => ({ stdout: 'whombat-agent: other-whombat\n', code: 3 });
    const job = await install({
      address: at(22),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    });
    expect(job.error).toEqual({
      code: 'other_whombat',
      message: 'This server reports to another Whombat. Remove Whombat’s helper there first.',
    });
  });

  it('updates an agent that was already there and sets its switches to the level', async () => {
    expect(hub.switchesOf('basalt')).toMatchObject({ console: true });
    ssh.installer = () => {
      hub.report('basalt');
      return { stdout: 'whombat-agent: os Ubuntu 24.04 LTS · amd64\nwhombat-agent: kept basalt\n', code: 0 };
    };
    const job = await install({
      address: at(23),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'watch',
    });
    expect(job).toMatchObject({ state: 'ready', serverId: 'basalt', already: true });
    const patch = hub.calls('PATCH', '/api/v1/servers/basalt').at(-1);
    expect(patch?.body).toEqual({
      remote_control: {
        console: false,
        power: false,
        host_shell: false,
        host_power: false,
        manage: false,
        diagnose: true,
      },
    });
    expect(hub.switchesOf('basalt')).toMatchObject({ console: false, power: false, diagnose: true });
    // Its token was never used: it is turned away at once rather than staying good for an hour.
    const reject = hub.requests.filter(
      (r) => r.method === 'POST' && /\/enrollments\/[^/]+\/reject$/.test(r.path),
    );
    expect(hub.enrollments.find((e) => reject.at(-1)?.path.includes(String(e.id)))?.state).toBe('rejected');
    const [signed] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'hosts.change'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(signed?.text).toBe('Updated basalt’s agent and set watch only');
  });

  it('says so when the first report doesn’t come, with the server added', async () => {
    ssh.installer = added('quiet-box', { report: false });
    const job = await install({
      address: at(24),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    });
    expect(job).toMatchObject({
      state: 'failed',
      serverId: 'quiet-box',
      error: {
        code: 'timed_out',
        message: 'It’s installed, but its first report hasn’t come in yet. It shows up once it does.',
      },
    });
  });

  it('names a taken name with -2, never taking the old server over', async () => {
    ssh.installer = added('pve-03');
    const job = await install({
      address: at(25),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    });
    expect(job).toMatchObject({ state: 'ready', serverId: 'pve-03-2', serverName: 'pve-03-2' });
  });
});

describe('a Vault key left on it (SI-09)', () => {
  it('makes a new key, puts it in authorized_keys once and trusts the key the server showed', async () => {
    ssh.installer = added('kept-key');
    const job = await install({
      address: at(26),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
      keepKey: { create: true },
    });
    expect(job).toMatchObject({ state: 'ready', keptKey: true, hostKeyNew: true });
    const [entry] = await t.services.db
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.ownerId, IDS.mara), eq(vaultEntries.name, 'Servers')));
    const publicKey = (entry?.auth as { publicKey: string } | undefined)?.publicKey ?? '';
    expect(ssh.users.get('root')?.authorized).toContain(publicKey);
    const [server] = await t.services.db
      .select()
      .from(vaultSshServers)
      .where(eq(vaultSshServers.entryId, entry?.id as string));
    expect(server).toMatchObject({
      name: 'kept-key',
      host: '10.100.0.26',
      port: ssh.port,
      username: 'root',
      hostKeyFingerprint: ssh.hostKey().fingerprint,
    });
    expect(server?.hostKeyTrustedAt).toBeTruthy();
    // Next time the key signs in, the host key is the trusted one, and the key isn't added twice.
    ssh.installer = () => ({ stdout: 'whombat-agent: kept kept-key\n', code: 0 });
    hub.report('kept-key');
    const again = await install({
      address: at(26),
      username: 'root',
      auth: { kind: 'vault', entryId: entry?.id },
      control: 'full',
      keepKey: { entryId: entry?.id },
    });
    expect(again).toMatchObject({ already: true, keptKey: true, hostKeyNew: false });
    expect(ssh.users.get('root')?.authorized.filter((k) => k === publicKey)).toHaveLength(1);
  });
});

describe('the routes', () => {
  it('start a job and answer it; an unknown job is not found', async () => {
    const body = {
      address: at(30),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    };
    expect((await as('GET', '/installs/hin_nothing')).status).toBe(404);
    ssh.installer = added('route-box');
    const started = await as('POST', '/installs', body);
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      state: 'connecting',
      address: at(30),
      username: 'root',
      control: 'full',
    });
    expect(started.raw).not.toContain(ROOT_PASSWORD);
    const id = String(started.body.id);
    await waitFor(async () => (await as('GET', `/installs/${id}`)).body.state === 'ready');
  });

  it('refuses an address that isn’t one, or one Whombat may not reach, before anything starts', async () => {
    const body = { username: 'root', auth: { kind: 'password', password: 'x' }, control: 'full' };
    const bad = await as('POST', '/installs', { ...body, address: 'not an address' });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.fields?.address).toEqual([
      'Type the server’s address, like 10.100.0.14 or pve-03.lan:2222.',
    ]);
    const loop = await as('POST', '/installs', { ...body, address: '127.0.0.1' });
    expect(loop.status).toBe(403);
    expect(loop.body.error?.code).toBe('not_allowed');
    expect(loop.body.error?.fields?.address?.[0]).toBe(loop.body.error?.message);
  });

  it('runs at most one job per server, two per person, four per box', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    ssh.installer = async (run) => {
      await gate;
      return added(`held-${run.token.slice(0, 4)}`)(run);
    };
    const body = (n: number) => ({
      address: at(n),
      username: 'root',
      auth: { kind: 'password', password: ROOT_PASSWORD },
      control: 'full',
    });
    const a = await as('POST', '/installs', body(40));
    expect(a.status).toBe(202);
    const same = await as('POST', '/installs', body(40));
    expect(same.status).toBe(429);
    expect(same.body.error?.message).toBe(`Whombat is adding ${at(40)} already. Wait for it to finish.`);
    expect((await as('POST', '/installs', body(41))).status).toBe(202);
    const third = await as('POST', '/installs', body(42));
    expect(third.status).toBe(429);
    expect(third.body.error?.message).toBe(
      'You’re adding two servers already. Wait for one of them to finish.',
    );
    release();
    await waitFor(() => installsFor(t.services).running().length === 0);
  });

  it('adds a Mac, and gives its screen the password of the user at its screen', async () => {
    ssh.kernel = 'Darwin';
    ssh.consoleUser = 'john';
    ssh.installer = (r) => {
      const result = added('studio')(r);
      hub.macos.makeMac('studio');
      return {
        ...result,
        stdout: result.stdout.replace(/os .*\n/, 'os arm64 · macOS 27.2.1\n'),
      };
    };
    try {
      const job = await install({
        address: at(9),
        username: 'john',
        auth: { kind: 'password', password: MAC_PASSWORD },
        control: 'full',
      });
      expect(job).toMatchObject({ state: 'ready', serverId: 'studio', system: 'macOS 27.2.1 · arm64' });
      expect(ssh.runs.at(-1)).toMatchObject({ user: 'john', way: 'sudo_password', control: 'full' });
      // The screen account is set after the first report, as Mara, with the Mac's own password only on the way.
      await waitFor(() => hub.macos.macs.get('studio')?.screen.account === 'john');
      const set = hub.macos.steps.find((x) => x.server === 'studio' && x.body.op === 'account.set');
      expect(set).toMatchObject({ body: { account: { user: 'john' } }, role: 'admin' });
      expect(set?.actor).toBe('prn_mara|Mara Okafor');
      const everything = JSON.stringify([
        await t.services.db.select().from(events),
        await t.services.db.select().from(changes),
      ]);
      expect(everything).not.toContain(MAC_PASSWORD);
      expect(ssh.commands.some((c) => c.command.includes(MAC_PASSWORD))).toBe(false);
    } finally {
      ssh.kernel = 'Linux';
      ssh.consoleUser = 'root';
    }
  });

  it('refuses a Mac older than macOS 13, in Mac words, and makes no enrollment', async () => {
    ssh.kernel = 'Darwin';
    ssh.macVersion = '12.7.6';
    const enrollments = hub.calls('POST', '/api/v1/enrollments').length;
    try {
      const job = await install({
        address: at(10),
        username: 'john',
        auth: { kind: 'password', password: MAC_PASSWORD },
        control: 'full',
      });
      expect(job.state).toBe('failed');
      expect(job.error?.code).toBe('unsupported');
      expect(job.error?.message).toContain('12.7.6');
      expect(hub.calls('POST', '/api/v1/enrollments')).toHaveLength(enrollments);
    } finally {
      ssh.kernel = 'Linux';
      ssh.macVersion = '27.2.1';
    }
  });

  it('never puts the password in an event, a change, a request to the hub or a command line', async () => {
    const rows = await t.services.db.select().from(events);
    const changeRows = await t.services.db.select().from(changes);
    const everything = JSON.stringify([rows, changeRows, hub.requests.map((r) => [r.path, r.body])]);
    for (const secret of [ROOT_PASSWORD, DEPLOY_PASSWORD, OPS_SUDO]) {
      expect(everything).not.toContain(secret);
      expect(ssh.commands.some((c) => c.command.includes(secret))).toBe(false);
    }
  });
});

describe('enrollments (SI-07)', () => {
  it('pre-approves every command with its level and name', async () => {
    const made = await as('POST', '/enrollments', { control: 'watch', name: 'pve-09' });
    expect(made.status, made.raw).toBe(201);
    expect(made.body).toMatchObject({ control: 'watch', preApproved: true });
    expect(String(made.body.installCommand)).toMatch(/--control watch$/);
    expect(hub.calls('POST', '/api/v1/enrollments').at(-1)?.body).toEqual({
      approve: true,
      control: 'watch',
      name: 'pve-09',
    });
    const empty = await as('POST', '/enrollments');
    expect(empty.body).toMatchObject({ control: 'full', preApproved: true });
    expect((await as('POST', '/enrollments', { control: 'all' })).status).toBe(400);
    const list = await as('GET', '/enrollments?state=issued');
    const items = list.body.items as { id: string; control: string | null; name: string | null }[];
    expect(items.find((e) => e.id === made.body.id)).toMatchObject({ control: 'watch', name: 'pve-09' });
  });
});

describe('server_add (SI-10)', () => {
  async function call(
    agent: { agentId: string; dmId: string },
    person: string,
    args: Record<string, unknown>,
  ) {
    const d = await agentTokenFor(t.services, t.burrowId, agent.agentId, agent.dmId, {
      onBehalfOfAccountId: await accountOf(t.services, person),
    });
    const mcp = await mcpClient(t.baseUrl, d.token);
    const res = await mcp.client.callTool({
      name: 'connection_call',
      arguments: { connection: 'servers', tool: 'server_add', arguments: args },
    });
    await mcp.close();
    return (res.structuredContent ?? {}) as { status: string; content?: string };
  }

  it('puts a card in the person’s conversation', async () => {
    const id = await ensureServersConnection(t.services);
    const tools = await t.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, id as string));
    expect(tools.find((x) => x.name === 'server_add')?.tier).toBe('can');
    const mara = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
    await setConnectionKeys(t.services, mara.agentId, { read: 'can', write: 'can' });
    const res = await call(mara, IDS.mara, { address: '10.100.0.40', username: 'root', control: 'full' });
    expect(res.status, JSON.stringify(res)).toBe('ok');
    expect(JSON.parse(res.content ?? '{}')).toEqual({ asked: true });
    const [posted] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, mara.dmId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(posted?.authorId).toBe(mara.agentId);
    expect(posted?.card).toMatchObject({
      kind: 'guide',
      guide: 'add_server',
      title: 'Add 10.100.0.40 as a server',
      blocks: [
        {
          type: 'actions',
          actions: [
            { label: 'Sign in…', href: '/things/servers?add=1&address=10.100.0.40&user=root&control=full' },
          ],
        },
      ],
    });
  });
});
