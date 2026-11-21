/**
 * Incus and Unraid through Whombat against the fake hosts service (incus-unraid.md IU-02…IU-08;
 * incus-unraid-server.md): the new kinds and details on the REST API, the new reads, a parity check whose one message
 * says how it went, stopping the array and updating a container after a yes, autostart with Undo, Incus backups and a
 * rename followed to their end, the guest this Whombat runs in refused before the hub is asked, the question before
 * restarting the server it runs on, and hints with their way out on Watch.
 */
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { approvals, changes, messages, watchOns } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { setServerAsks } from './asks';
import { startHosts } from './index';
import { ensureServersConnection } from './provision';
import { hostsFor } from './service';
import { hintLink, hostsWatch } from './sources';
import { FakeHostsService } from './testing/fake';

const fake = new FakeHostsService();
const t = useTestServer({
  seed: true,
  listen: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});

let personCookie = '';
let whombat = { agentId: '', dmId: '' };

async function call(tool: string, args: Record<string, unknown>) {
  const d = await agentTokenFor(t.services, t.burrowId, whombat.agentId, whombat.dmId, {
    onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
  });
  const mcp = await mcpClient(t.baseUrl, d.token);
  const res = await mcp.client.callTool({
    name: 'connection_call',
    arguments: { connection: 'servers', tool, arguments: args },
  });
  await mcp.close();
  return (res.structuredContent ?? {}) as { status: string; content?: string; message?: string };
}

const content = (res: { content?: string }) => JSON.parse(res.content ?? '{}') as Record<string, unknown>;

/** Whombat's messages in its DM with Mara, oldest first. */
async function said(): Promise<string[]> {
  const rows = await t.services.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, whombat.dmId), eq(messages.authorId, whombat.agentId)));
  // A task's card says what it does, then how it went (task-feedback.md TF-10).
  return rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((m) => (m.card?.kind === 'task' ? (m.card.result ?? m.card.title) : m.text));
}

const saysSoon = (text: string | RegExp) =>
  expect
    .poll(async () => (await said()).some((m) => (typeof text === 'string' ? m === text : text.test(m))), {
      timeout: 10_000,
    })
    .toBe(true);

async function approveLast() {
  const [approval] = await t.services.db.select().from(approvals).orderBy(desc(approvals.number)).limit(1);
  const decided = await t.commit(IDS.mara, decideApproval, {
    number: approval?.number as number,
    decision: 'approve',
  });
  expect(decided.status).toBe('ok');
  return approval;
}

/** Mara sets a server to ask before risky actions (every server starts at Never), so its sensitive calls ask. */
async function asksBeforeRisky(server: string) {
  const set = await t.commit(IDS.mara, setServerAsks, {
    serverId: server,
    serverName: server,
    asksFirst: 'risky',
  });
  expect(set.status).toBe('ok');
}

async function lastChange(kind: string) {
  const [row] = await t.services.db
    .select()
    .from(changes)
    .where(eq(changes.kind, kind))
    .orderBy(desc(changes.createdAt))
    .limit(1);
  return row ?? null;
}

async function rest(method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await t.api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq/hosts${url}`,
    headers: { cookie: personCookie },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  await fake.start();
  fake.manage.taskMs = 30;
  personCookie = (await sessionFor(t.services, IDS.mara)).cookie;
  const made = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { name: 'Dusty', services: null });
  whombat = { agentId: made.agentId, dmId: made.dmId };
  await setConnectionKeys(t.services, whombat.agentId, { read: 'can', write: 'can' });
  startHosts(t.services);
  for (const until = Date.now() + 4000; fake.streams !== 1 && Date.now() < until; )
    await new Promise((r) => setTimeout(r, 20));
  await ensureServersConnection(t.services);
});

afterAll(async () => {
  await fake.stop();
});

describe('the new kinds on the REST API', () => {
  it('serves Incus and Unraid details with their kind and the server this Whombat runs on', async () => {
    const fleet = await rest('GET', '/fleet');
    const servers = fleet.body.servers as { id: string; platform: string; hostsThisWhombat?: boolean }[];
    expect(servers.find((s) => s.id === 'basalt')).toMatchObject({
      platform: 'incus',
      hostsThisWhombat: true,
    });
    expect(servers.find((s) => s.id === 'blackbox')?.platform).toBe('unraid');
    const blackbox = await rest('GET', '/servers/blackbox');
    expect(blackbox.status).toBe(200);
    expect((blackbox.body.unraid as { name: string }).name).toBe('BlackBox');
    const basalt = await rest('GET', '/servers/basalt');
    expect(basalt.status).toBe(200);
    expect((basalt.body.incus as { version: string }).version).toBe('6.0.4');
    expect((basalt.body.server as { hostsThisWhombat?: boolean }).hostsThisWhombat).toBe(true);
  });

  it('reads a profile, a network’s leases and an instance’s log', async () => {
    const profile = await rest('GET', '/servers/basalt/manage?op=profile.get&profile=default');
    expect(profile.status).toBe(200);
    expect((profile.body.profile as { name: string; digest: string }).name).toBe('default');
    const leases = await rest('GET', '/servers/basalt/manage?op=network.leases&network=incusbr0');
    expect(leases.status).toBe(200);
    expect(Array.isArray(leases.body.items)).toBe(true);
    const log = await rest('GET', '/servers/basalt/manage?op=log.get&guestId=incus:dns&lines=20');
    expect(log.status).toBe(200);
    expect(fake.calls('GET', '/api/v1/servers/basalt/guests/incus:dns/log').at(-1)?.query.get('lines')).toBe(
      '20',
    );
  });

  it('refuses changing the guest this Whombat runs in before the hub is asked', async () => {
    const before = fake.calls('POST', '/api/v1/servers/basalt/guests/incus:whombat-dev-box/actions').length;
    const stop = await rest('POST', '/servers/basalt/guests/incus:whombat-dev-box/actions', {
      action: 'force_stop',
      confirm: true,
    });
    expect(stop.status).toBe(409);
    expect(stop.body.error).toMatchObject({
      message: 'That’s this Whombat itself.',
      details: { code: 'self_guest' },
    });
    expect(fake.calls('POST', '/api/v1/servers/basalt/guests/incus:whombat-dev-box/actions').length).toBe(
      before,
    );
    const config = await rest('POST', '/servers/basalt/manage', {
      op: 'config.set',
      guestId: 'incus:whombat-dev-box',
      params: { set: { 'limits.cpu': '2' } },
      digest: 'd1',
    });
    expect(config.status).toBe(409);
    expect(fake.calls('PUT', '/api/v1/servers/basalt/guests/incus:whombat-dev-box/config')).toHaveLength(0);
    // A snapshot stays allowed.
    const snap = await rest('POST', '/servers/basalt/guests/incus:whombat-dev-box/actions', {
      action: 'snapshot_create',
    });
    expect(snap.status).toBeLessThan(300);
  });

  it('runs an Unraid change for the person and signs it in words', async () => {
    const res = await rest('POST', '/servers/blackbox/manage', {
      op: 'disk.spin_down',
      params: { disk: 'disk1' },
    });
    expect(res.status).toBeLessThan(300);
    expect(String((res.body.task as { id: string }).id)).toMatch(/^unraid:/);
    expect((await lastChange('hosts.manage_disk_spin_down'))?.title).toBe('Spun down disk1 on blackbox');
  });
});

describe('hints with a way out on Watch', () => {
  it('links Unraid and Incus hints to where they are fixed; heads-ups come marked, for the folded group (NYL-03)', async () => {
    const watch = () =>
      hostsWatch({
        db: t.services.db,
        burrowId: t.burrowId,
        personId: IDS.mara,
        now: new Date(),
        services: t.services,
      });
    hostsFor(t.services).forget();
    // Updates start off (watch-defaults.md): nowhere until someone turns them on.
    const calm = await watch();
    expect(calm.some((i) => i.id.startsWith('hosts.hint:blackbox:unraid.plugin_updates'))).toBe(false);
    for (const check of ['host.hint.unraid.plugin_updates', 'host.hint.docker.update_available'])
      await t.services.db.insert(watchOns).values({
        ownerId: t.burrowId,
        thingId: 'server:blackbox',
        checkId: check,
        byId: IDS.mara,
        at: new Date(),
      });
    hostsFor(t.services).forget();
    const items = await watch();
    // Waiting plugin and container updates are heads-ups: the Needs you list folds them, `watch.list` leaves them out.
    const fyi = (prefix: string) => items.find((i) => i.id.startsWith(prefix))?.nature;
    expect(fyi('hosts.hint:blackbox:unraid.plugin_updates')).toBe('fyi');
    expect(fyi('hosts.hint:blackbox:docker.update_available')).toBe('fyi');
    const hints = (await hostsFor(t.services).fleet()).hints;
    const guests = (await hostsFor(t.services).guestsRaw('blackbox')) as { id: string; name: string }[];
    const plugins = hints.find((h) => h.serverId === 'blackbox' && h.kind === 'unraid.plugin_updates');
    expect(plugins && hintLink(plugins, guests, 'unraid')).toEqual({
      href: '/things/server%3Ablackbox?tab=plugins',
      wayOut: 'Update them under Plugins.',
    });
    const plex = hints.find((h) => h.serverId === 'blackbox' && h.kind === 'docker.update_available');
    expect(plex && hintLink(plex, guests, 'unraid').href).toBe(
      '/things/server%3Ablackbox?guest=docker%3Aplex',
    );
    // Guests without snapshots need a person: on Watch, linking to the guest.
    const snapshots = items.find((i) => i.id.startsWith('hosts.hint:basalt:incus.no_snapshots'));
    expect(snapshots?.href).toBe('/things/server%3Abasalt?guest=incus%3Amqtt-bridge&gtab=snapshots');
    expect(snapshots?.nature).toBe('you');
  });
});

describe('Unraid through the assistant', () => {
  beforeAll(() => asksBeforeRisky('blackbox'));

  it('reads the array and checks parity, saying how it went in one message', async () => {
    const overview = content(await call('unraid_overview', { server: 'blackbox' }));
    expect(overview).toMatchObject({ name: 'BlackBox', version: '7.3.1', newerVersion: '7.3.2' });
    expect((overview.array as { state: string }).state).toBe('started');
    expect(overview.containersWithUpdates).toContain('docker:plex');
    fake.unraid.parityErrors = 0;
    const res = await call('unraid_array', { server: 'blackbox', action: 'parity_check' });
    expect(res.status).toBe('ok');
    expect(fake.calls('POST', '/api/v1/servers/blackbox/unraid/parity/start').at(-1)?.body).toEqual({
      correct: false,
    });
    await saysSoon('The parity check on blackbox is done. No errors.');
    fake.unraid.parityErrors = 3;
    await call('unraid_array', { server: 'blackbox', action: 'parity_check' });
    await saysSoon('The parity check on blackbox is done. It found 3 errors.');
    expect((await said()).join('\n')).not.toContain('unraid:');
  });

  it('asks before stopping the array, then says it is stopped', async () => {
    const asked = await call('unraid_array', { server: 'blackbox', action: 'stop' });
    expect(asked.status).toBe('pending_approval');
    const approval = await approveLast();
    expect(approval?.question).toBe('Stop the array of blackbox?');
    // The task's card says it (its running words, then how it went), not a line of its own (TF-10).
    expect((await said()).join('\n')).not.toContain('Stopping the array of blackbox now.');
    expect(fake.calls('POST', '/api/v1/servers/blackbox/unraid/array/stop').at(-1)?.body).toEqual({
      confirm: true,
    });
    await saysSoon('The array of blackbox is stopped.');
    await call('unraid_array', { server: 'blackbox', action: 'start' });
    await saysSoon('The array of blackbox is started.');
  });

  it('updates a container from its template after a yes', async () => {
    const asked = await call('container_update', { server: 'blackbox', action: 'update', guest: 'plex' });
    expect(asked.status).toBe('pending_approval');
    expect((await approveLast())?.title).toBe('Update plex on blackbox');
    await saysSoon('plex on blackbox is up to date now.');
    expect(fake.guest('blackbox', 'docker:plex')?.update_available).toBe(false);
    // A check looks at every container: it takes no guest.
    const check = await call('container_update', { server: 'blackbox', action: 'check', guest: 'plex' });
    expect(check.status).not.toBe('ok');
  });

  it('turns autostart off, with Undo turning it back on', async () => {
    const res = await call('guest_autostart', { server: 'blackbox', guest: 'pbs', on: false });
    expect(res.status).toBe('ok');
    expect(fake.calls('PUT', '/api/v1/servers/blackbox/guests/libvirt:pbs/autostart').at(-1)?.body).toEqual({
      on: false,
    });
    const change = await lastChange('hosts.guest_autostart');
    expect(change).toMatchObject({
      title: 'pbs on blackbox no longer starts by itself',
      undoKind: 'hosts.tool_inverse',
    });
    // An Incus instance keeps it in its settings.
    const incus = await call('guest_autostart', { server: 'basalt', guest: 'dns', on: true });
    expect(incus.status).not.toBe('ok');
  });

  it('refuses an Unraid tool on a server that isn’t Unraid', async () => {
    const res = content(await call('unraid_overview', { server: 'shale' }));
    expect(res.error).toBe('shale doesn’t run Unraid, so this tool doesn’t work there.');
  });
});

describe('Incus through the assistant', () => {
  it('reads Incus’s own things', async () => {
    const res = content(await call('incus_overview', { server: 'basalt' }));
    expect(res.version).toBe('6.0.4');
    expect((res.projects as { name: string }[]).map((p) => p.name)).toContain('default');
    expect((res.pools as { name: string }[]).map((p) => p.name)).toContain('default');
  });

  it('backs up an instance with an expiry and says when it is done', async () => {
    const res = await call('guest_backup', {
      server: 'basalt',
      guest: 'git-mirror',
      action: 'create',
      expires_days: 3,
    });
    expect(res.status).toBe('ok');
    const body = fake.calls('POST', '/api/v1/servers/basalt/guests/incus:git-mirror/backups').at(-1)
      ?.body as {
      expires_at: string;
    };
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
    await saysSoon('git-mirror on basalt is backed up.');
  });

  it('renames a stopped instance and says its new name', async () => {
    const res = await call('guest_rename', { server: 'basalt', guest: 'scratch', name: 'scratch2' });
    expect(res.status).toBe('ok');
    await saysSoon('scratch on basalt is called scratch2 now.');
    expect((await lastChange('hosts.guest_rename'))?.undoKind).toBe('hosts.tool_inverse');
  });

  it('refuses changing the guest this Whombat runs in, and keeps its backups', async () => {
    const res = content(
      await call('guest_config_set', {
        server: 'basalt',
        guest: 'whombat-dev-box',
        digest: 'd1',
        set: { 'limits.memory': '8GiB' },
      }),
    );
    expect(res).toMatchObject({ error: 'That’s this Whombat itself.', code: 'self_guest' });
    expect(fake.calls('PUT', '/api/v1/servers/basalt/guests/incus:whombat-dev-box/config')).toHaveLength(0);
    const backup = await call('guest_backup', {
      server: 'basalt',
      guest: 'whombat-dev-box',
      action: 'create',
    });
    expect(backup.status).toBe('ok');
  });

  it('asks before restarting the server this Whombat runs on, and says it goes down too', async () => {
    hostsFor(t.services).forget('fleet');
    await hostsFor(t.services).fleetRaw();
    const asked = await call('server_power', { server: 'basalt', action: 'reboot' });
    expect(asked.status).toBe('pending_approval');
    const [approval] = await t.services.db.select().from(approvals).orderBy(desc(approvals.number)).limit(1);
    expect(approval?.question).toBe('Reboot basalt, the server this Whombat runs on?');
    expect((await said()).some((m) => m.includes('This Whombat goes down too.'))).toBe(true);
  });
});

describe('QEMU/KVM through the assistant (IU-13)', () => {
  beforeAll(() => asksBeforeRisky('kvm-lab'));

  it('serves the kind and reads libvirt’s own things', async () => {
    const detail = await rest('GET', '/servers/kvm-lab');
    expect(detail.status).toBe(200);
    expect((detail.body.server as { platform: string }).platform).toBe('libvirt');
    const res = content(await call('libvirt_overview', { server: 'kvm-lab' }));
    expect(res.libvirt).toBe('12.2.0');
    expect((res.pools as { pool: string }[]).map((p) => p.pool)).toContain('default');
    const unraid = content(await call('libvirt_overview', { server: 'blackbox' }));
    expect(unraid.storages).toEqual(['folder:domains', 'folder:isos']);
  });

  it('changes a VM’s settings with Proxmox-like keys and inserts an ISO', async () => {
    const config = content(await call('guest_config', { server: 'kvm-lab', guest: 'debian-web' }));
    expect((config.values as Record<string, string>).vcpus).toBeTruthy();
    const res = await call('guest_config_set', {
      server: 'kvm-lab',
      guest: 'debian-web',
      digest: config.digest,
      set: { memory_mb: '4096', cdrom0: 'source=isos/debian-13.1.0-amd64-netinst.iso,bus=sata' },
    });
    expect(res.status).toBe('ok');
    const sent = fake.calls('PUT', '/api/v1/servers/kvm-lab/guests/libvirt:debian-web/config').at(-1);
    expect(sent?.body).toMatchObject({ set: { memory_mb: '4096' } });
    expect((await lastChange('hosts.guest_config'))?.title).toBe(
      'Changed 2 settings of debian-web on kvm-lab',
    );
  });

  it('creates a VM from an OS type and says when it is ready', async () => {
    const res = await call('guest_create', {
      server: 'kvm-lab',
      kind: 'vm',
      name: 'win11-new',
      os_variant: 'win11',
      cores: 4,
      memory_mb: 8192,
      disk_gb: 64,
      network: 'default',
    });
    expect(res.status).toBe('ok');
    expect(fake.calls('POST', '/api/v1/servers/kvm-lab/guests').at(-1)?.body).toEqual({
      platform: 'libvirt',
      kind: 'vm',
      name: 'win11-new',
      set: { vcpus: '4', memory_mb: '8192' },
      os_variant: 'win11',
      disk_gb: 64,
      network: 'default',
    });
    await saysSoon('The VM win11-new on kvm-lab is ready.');
    // What only Incus takes is refused in words.
    const wrong = await call('guest_create', { server: 'kvm-lab', kind: 'vm', name: 'x', project: 'lab' });
    expect(wrong.status).not.toBe('ok');
  });

  it('backs up a running VM and restores it as a new one after a yes', async () => {
    const backup = await call('guest_backup', { server: 'kvm-lab', guest: 'debian-web', action: 'create' });
    expect(backup.status).toBe('ok');
    await saysSoon('debian-web on kvm-lab is backed up.');
    const list = content(await call('guest_backups', { server: 'kvm-lab', guest: 'debian-web' }));
    const made = (list.backups as { backup: string }[]).at(0)?.backup as string;
    expect(made).toMatch(/^\d{8}-\d{6}$/);
    const asked = await call('guest_backup', {
      server: 'kvm-lab',
      guest: 'debian-web',
      action: 'restore',
      backup: made,
      name: 'debian-web-2',
    });
    expect(asked.status).toBe('pending_approval');
    await approveLast();
    expect(fake.calls('POST', '/api/v1/servers/kvm-lab/backups/restore').at(-1)?.body).toMatchObject({
      platform: 'libvirt',
      guest: 'libvirt:debian-web',
      volume: made,
      name: 'debian-web-2',
    });
    await saysSoon(/^debian-web-2 is ready on kvm-lab, restored from /);
  });

  it('lists ISO images and the leases of a libvirt network', async () => {
    const isos = content(await call('storage_contents', { server: 'kvm-lab' }));
    expect((isos.items as unknown[]).length).toBeGreaterThan(0);
    const leases = content(await call('network_leases', { server: 'kvm-lab', network: 'default' }));
    expect(fake.calls('GET', '/api/v1/servers/kvm-lab/libvirt/networks/default/leases')).toHaveLength(1);
    expect(Array.isArray(leases.leases)).toBe(true);
  });
});
