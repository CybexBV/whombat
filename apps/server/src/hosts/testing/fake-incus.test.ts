/**
 * The fake hosts service's Incus side (`fake-incus.ts`) answers like the hub: basalt's Incus in the detail, choices,
 * profiles, leases, backups as tasks, rename and the guest this Whombat runs in refused, the hub's problem codes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostsClient, type HostsError, type HostsRequest } from '../client';
import { type FakeHostsService, startFakeHosts } from './fake';

type J = Record<string, unknown>;

const S = '/api/v1/servers/basalt';
const G = (id: string) => `${S}/guests/${encodeURIComponent(id)}`;

describe('the fake hosts service’s Incus side', () => {
  let fake: FakeHostsService;
  let client: HostsClient;

  beforeAll(async () => {
    fake = await startFakeHosts();
    fake.manage.taskMs = 5;
    client = new HostsClient({ socket: fake.socket, tokenFile: fake.tokenFile });
  });
  afterAll(() => fake.stop());

  const call = <T = J>(req: HostsRequest) =>
    client.json<T>({ actor: { id: 'prn_tess', name: 'Tess', role: 'admin' }, ...req });
  const refusal = (req: HostsRequest) =>
    call(req).then(
      () => null,
      (e: unknown) => e as HostsError,
    );
  const finished = async (id: string): Promise<J> => {
    const until = Date.now() + 3000;
    for (;;) {
      const t = await call({ path: `${S}/tasks/${encodeURIComponent(id)}` });
      if (t.status !== 'running') return t;
      if (Date.now() > until) throw new Error(`task ${id} still running`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('has basalt’s Incus in the detail, with the counts that follow from the instances', async () => {
    const d = await call({ path: S });
    const incus = d.incus as J;
    expect(incus.version).toBe('6.0.4');
    expect((incus.projects as J[]).map((p) => [p.name, p.instances, p.running])).toEqual([
      ['default', 8, 7],
      ['ci-platform', 0, 0],
    ]);
    expect((incus.profiles as J[]).find((p) => p.name === 'gpu')?.used_by).toBe(1);
    expect((incus.networks as J[]).map((n) => [n.name, n.used_by])).toEqual([
      ['incusbr0', 9],
      ['br0', 1],
    ]);
    expect((incus.volumes as J[]).find((v) => v.name === 'media')?.used_by).toEqual(['incus:dev-shell']);
    expect((d.server as J).hosts_this_whombat).toBe(true);
    const guests = ((d.workloads as J).incus as J).guests as J[];
    expect(guests.find((g) => g.self === true)?.id).toBe('incus:whombat-dev-box');
    expect(guests.every((g) => g.project === 'default' && (g.macs as string[]).length === 1)).toBe(true);
    expect((d.hints as J[]).find((h) => h.kind === 'incus.no_snapshots')).toMatchObject({
      entity: 'incus:mqtt-bridge',
      detail: 'mqtt-bridge',
    });
    const tasks = await call<{ items: J[] }>({ path: `${S}/tasks`, query: { platform: 'incus' } });
    expect(tasks.items.map((t) => t.status).sort()).toEqual(['error', 'ok']);
  });

  it('offers the project’s choices, the common images and the projects', async () => {
    const c = await call({ path: `${S}/manage/choices`, query: { platform: 'incus' } });
    expect(c.platform).toBe('incus');
    expect((c.storages as J[]).map((s) => s.id)).toEqual(['default', 'fast']);
    expect(c.bridges).toEqual(['incusbr0', 'br0']);
    expect(c.profiles).toEqual(['default', 'gpu']);
    expect(c.projects).toEqual(['default', 'ci-platform']);
    expect(c.remote_images).toContainEqual({
      alias: 'debian/13/cloud',
      description: 'Debian 13 (trixie) with cloud-init',
      type: 'virtual-machine',
    });
    const ci = await call({
      path: `${S}/manage/choices`,
      query: { platform: 'incus', project: 'ci-platform' },
    });
    expect(ci.profiles).toEqual(['default', 'ci']);
    expect((await refusal({ path: `${S}/manage/choices`, query: { project: 'nope' } }))?.code).toBe(
      'invalid_value',
    );
  });

  it('reads a profile, a network’s leases and an instance’s settings and log', async () => {
    const gpu = await call({ path: `${S}/incus/profiles/gpu` });
    expect(gpu).toMatchObject({
      project: 'default',
      used_by: ['incus:nixbuild'],
      restricted: ['device.gpu0'],
    });
    expect((gpu.devices as J).gpu0).toMatchObject({ type: 'gpu' });
    const leases = await call<{ items: J[] }>({ path: `${S}/incus/networks/incusbr0/leases` });
    expect(leases.items).toContainEqual(
      expect.objectContaining({ guest: 'incus:dns', address: '10.94.12.53', type: 'static' }),
    );
    expect(leases.items.some((l) => l.guest === null)).toBe(true);
    expect((await call<{ items: J[] }>({ path: `${S}/incus/networks/br0/leases` })).items).toEqual([]);
    expect((await refusal({ path: `${S}/incus/networks/nope/leases` }))?.code).toBe('not_found');
    const cfg = await call({ path: `${G('incus:nixbuild')}/config` });
    expect(cfg).toMatchObject({ platform: 'incus', kind: 'vm', profiles: ['default', 'gpu'] });
    expect(cfg.restricted).toContain('device.gpu0');
    expect(cfg.inherited).toContain('device.eth0');
    expect((cfg.values as J)['device.root']).toBe('type=disk,path=/,pool=default,size=200GiB');
    expect(cfg.disks).toContainEqual(
      expect.objectContaining({ key: 'root', storage: 'default', size_bytes: 200 * 1024 ** 3 }),
    );
    const log = await call({ path: `${G('incus:dev-shell')}/log`, query: { lines: 5 } });
    expect(log.file).toBe('lxc.log');
    expect(log.lines).toHaveLength(5);
    expect(
      (await refusal({ path: `${G('incus:dev-shell')}/log`, query: { lines: 5000 } }))?.fieldErrors,
    ).toEqual({
      lines: 'A number of lines from 1 to 2000.',
    });
  });

  it('backs up as a task, lists the backup and drops the hint', async () => {
    const started = await call<{ task: { id: string } }>({
      method: 'POST',
      path: `${G('incus:mqtt-bridge')}/backups`,
      body: { name: 'before-upgrade', compression: 'zstd' },
    });
    expect(started.task.id).toMatch(/^incus:[0-9a-f-]{36}$/);
    expect(await finished(started.task.id)).toMatchObject({ status: 'ok', type: 'Backing up instance' });
    const list = await call<{ items: J[] }>({ path: `${G('incus:mqtt-bridge')}/backups` });
    expect(list.items).toContainEqual(
      expect.objectContaining({ volume: 'before-upgrade', storage: 'incus', format: 'tar' }),
    );
    const d = await call({ path: S });
    expect((d.hints as J[]).some((h) => h.kind === 'incus.no_snapshots')).toBe(false);
    expect((d.hints as J[]).some((h) => h.kind === 'disk.space')).toBe(true);
  });

  it('renames only a stopped instance, and refuses fields the route doesn’t take', async () => {
    const running = await refusal({
      method: 'POST',
      path: `${G('incus:dev-shell')}/rename`,
      body: { name: 'devbox' },
    });
    expect(running).toMatchObject({ status: 409, code: 'guest_running' });
    const unknown = await refusal({
      method: 'POST',
      path: `${G('incus:scratch')}/rename`,
      body: { name: 'scratch2', bogus: 1 },
    });
    expect(unknown).toMatchObject({ status: 400, code: 'bad_request' });
    const started = await call<{ task: { id: string }; new_id: string }>({
      method: 'POST',
      path: `${G('incus:scratch')}/rename`,
      body: { name: 'scratch2' },
    });
    expect(started.new_id).toBe('incus:scratch2');
    await finished(started.task.id);
    expect(fake.guest('basalt', 'incus:scratch2')?.name).toBe('scratch2');
    expect(fake.guest('basalt', 'incus:scratch')).toBeNull();
  });

  it('refuses changes to the guest this Whombat runs in, but backs it up', async () => {
    const box = G('incus:whombat-dev-box');
    for (const req of [
      { method: 'PUT', path: `${box}/config`, body: { set: { 'limits.cpu': '8' } } },
      { method: 'DELETE', path: box, query: { confirm_name: 'whombat-dev-box' } },
      { method: 'POST', path: `${box}/rename`, body: { name: 'other' } },
      { method: 'POST', path: `${box}/disks/root/resize`, body: { size: '+8G' } },
      { method: 'POST', path: `${box}/publish`, body: {} },
    ] as HostsRequest[])
      expect(await refusal(req)).toMatchObject({
        status: 409,
        code: 'self_guest',
        detail: 'That’s this Whombat itself.',
      });
    const backup = await call<{ task: { id: string } }>({ method: 'POST', path: `${box}/backups`, body: {} });
    expect(await finished(backup.task.id)).toMatchObject({ status: 'ok' });
  });

  it('changes settings through the allowlist and the digest', async () => {
    const path = `${G('incus:dev-shell')}/config`;
    const { digest } = await call<{ digest: string }>({ path });
    expect((await refusal({ method: 'PUT', path, body: { set: { 'raw.lxc': 'x' } } }))?.code).toBe(
      'not_allowed',
    );
    const hostPath = await refusal({
      method: 'PUT',
      path,
      body: { devices: { srv: { type: 'disk', source: '/srv', path: '/srv' } } },
    });
    expect(hostPath?.code).toBe('not_allowed');
    const changed = await call<{ changes: J[] }>({
      method: 'PUT',
      path,
      body: {
        digest,
        set: { 'limits.memory': '6GiB' },
        devices: { data: { type: 'disk', pool: 'default', source: 'media', path: '/data' } },
      },
    });
    expect(changed.changes).toContainEqual({
      key: 'limits.memory',
      old: '4GiB',
      new: '6GiB',
      pending: false,
    });
    expect(changed.changes.map((c) => c.key)).toContain('device.data');
    expect((await refusal({ method: 'PUT', path, body: { digest, set: { 'limits.cpu': '2' } } }))?.code).toBe(
      'digest_mismatch',
    );
  });

  it('keeps profiles, images and volumes that are in use', async () => {
    const del = (path: string, query: J = {}) =>
      refusal({ method: 'DELETE', path, query: query as HostsRequest['query'] });
    expect(await del(`${S}/incus/profiles/gpu`, { confirm: 1 })).toMatchObject({
      status: 409,
      code: 'in_use',
    });
    expect(await del(`${S}/incus/profiles/default`, { confirm: 1 })).toMatchObject({
      status: 403,
      code: 'not_allowed',
    });
    expect(await del(`${S}/incus/profiles/ci`, { project: 'ci-platform' })).toMatchObject({
      code: 'confirm_required',
    });
    expect(await del(`${S}/incus/profiles/ci`, { project: 'ci-platform', confirm: 1 })).toBeNull();
    const d = await call({ path: S });
    const alpine = ((d.incus as J).images as J[]).find((i) =>
      (i.aliases as string[]).includes('alpine/3.22'),
    );
    expect(await del(`${S}/incus/images/${String(alpine?.fingerprint)}`)).toMatchObject({ code: 'in_use' });
    expect(await del(`${S}/incus/pools/default/volumes/media`, { confirm: 1 })).toMatchObject({
      code: 'in_use',
    });
    expect(await del(`${S}/incus/pools/fast/volumes/scratch-data`, { confirm: 1 })).toBeNull();
  });

  it('creates an instance in another project with its own id', async () => {
    const started = await call<{ task: { id: string }; new_id: string }>({
      method: 'POST',
      path: `${S}/guests`,
      body: {
        platform: 'incus',
        kind: 'container',
        name: 'runner-1',
        image: 'images:debian/13',
        project: 'ci-platform',
        pool: 'fast',
        network: 'incusbr0',
        set: { 'limits.cpu': '2' },
        start: true,
      },
    });
    expect(started.new_id).toBe('incus:ci-platform/runner-1');
    await finished(started.task.id);
    const d = await call({ path: S });
    expect(((d.incus as J).projects as J[]).find((p) => p.name === 'ci-platform')).toMatchObject({
      instances: 1,
      running: 1,
    });
    const cfg = await call({ path: `${G('incus:ci-platform/runner-1')}/config` });
    expect((cfg.values as J)['device.root']).toBe('type=disk,path=/,pool=fast');
  });
});
