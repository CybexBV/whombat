/**
 * The fake hosts service's libvirt side (`fake-libvirt.ts`) answers like the hub: kvm-lab's libvirt in the detail,
 * settings with pending changes and locked keys, choices, create, clone, rename, backups and restores as tasks, pool
 * volumes and ISO images in use, leases, the QEMU log, unRAID's folders on blackbox, the hub's problem codes.
 */
import { HostServerDetail } from '@whombat/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostsClient, type HostsError, type HostsRequest } from '../client';
import { toHostServerDetail } from '../map';
import { type FakeHostsService, startFakeHosts } from './fake';

type J = Record<string, unknown>;

const S = '/api/v1/servers/kvm-lab';
const G = (id: string, server = S) => `${server}/guests/${encodeURIComponent(id)}`;
const GiB = 1024 ** 3;

describe('the fake hosts service’s libvirt side', () => {
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
  const finished = async (id: string, server = S): Promise<J> => {
    const until = Date.now() + 3000;
    for (;;) {
      const t = await call({ path: `${server}/tasks/${encodeURIComponent(id)}` });
      if (t.status !== 'running') return t;
      if (Date.now() > until) throw new Error(`task ${id} still running`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const boxFirmware = () => ((fake.details.blackbox as J).libvirt as J).firmware as J;
  const pool = async (name: string) =>
    ((((await call({ path: S })).libvirt as J).pools as J[]).find((p) => p.name === name) ?? {}) as J;

  it('has kvm-lab’s libvirt in the detail, with the counts and hints that follow, and it maps to the contract', async () => {
    const d = await call({ path: S });
    const lv = d.libvirt as J;
    expect(lv).toMatchObject({ version: '12.2.0', qemu: '10.1.0', folders: null });
    expect((lv.pools as J[]).map((p) => [p.name, p.type, p.volumes])).toEqual([
      ['default', 'dir', 4],
      ['isos', 'dir', 6],
      ['fast', 'logical', 4],
    ]);
    const fast = (lv.pools as J[])[2] as J;
    expect(Number(fast.used_bytes) / Number(fast.total_bytes)).toBeGreaterThan(0.85);
    expect((lv.networks as J[]).map((n) => [n.name, n.used_by])).toEqual([
      ['default', 5],
      ['lan', 1],
    ]);
    const guests = ((d.workloads as J).libvirt as J).guests as J[];
    expect(guests.map((g) => [g.id, g.state])).toEqual([
      ['libvirt:debian-web', 'running'],
      ['libvirt:win11', 'running'],
      ['libvirt:pfsense', 'running'],
      ['libvirt:alpine-test', 'stopped'],
      ['libvirt:nixos-build', 'stopped'],
    ]);
    const hints = d.hints as J[];
    expect(hints.find((h) => h.kind === 'libvirt.pool_full')).toMatchObject({
      severity: 'warning',
      entity: 'pool:fast',
      title: 'Storage “fast” 88% full',
      link: '#storage',
    });
    expect(hints.find((h) => h.kind === 'libvirt.no_backup')).toMatchObject({
      severity: 'info',
      entity: 'libvirt:pfsense',
      detail: 'pfsense',
      link: '#guests',
    });
    const mapped = toHostServerDetail(d, [], null, new Date('2026-10-11T14:00:00Z'));
    expect(HostServerDetail.safeParse(mapped).error).toBeUndefined();
    expect(mapped.server.platform).toBe('libvirt');
    expect(mapped.libvirt?.firmware).toEqual({ uefi: true, secureBoot: true, tpm: true });
    const tasks = await call<{ items: J[] }>({ path: `${S}/tasks`, query: { platform: 'libvirt' } });
    expect(tasks.items).toEqual([expect.objectContaining({ type: 'backup', status: 'ok' })]);
    const box = await call({ path: '/api/v1/servers/blackbox' });
    expect(box.libvirt).toMatchObject({
      pools: [],
      folders: { domains: '/mnt/user/domains', isos: '/mnt/user/isos' },
      firmware: { uefi: true, secure_boot: false, tpm: true },
    });
    expect(HostServerDetail.safeParse(toHostServerDetail(box, [], null, new Date())).error).toBeUndefined();
  });

  it('reads a VM’s settings with its disks, and locks the machine, firmware and passed-through devices', async () => {
    const cfg = await call({ path: `${G('libvirt:debian-web')}/config` });
    expect(cfg).toMatchObject({ platform: 'libvirt', kind: 'vm', running: true, pending: {} });
    expect(cfg.digest).toMatch(/^x\d+$/);
    expect(cfg.values).toMatchObject({
      name: 'debian-web',
      vcpus: '4',
      vcpus_max: '8',
      memory_mb: '8192',
      autostart: '1',
      boot: 'hd,cdrom',
      disk0: `source=default/debian-web.qcow2,bus=virtio,format=qcow2,target=vda,size=${40 * GiB}`,
      cdrom0: 'source=empty,bus=sata',
      net0: 'model=virtio,network=default,mac=52:54:00:3a:1f:07,link=up',
      machine: 'pc-q35-10.1',
      firmware: 'bios',
    });
    expect(cfg.restricted).toEqual(['machine', 'firmware', 'secure_boot', 'tpm', 'graphics0', 'video']);
    expect(cfg.disks).toEqual([
      {
        key: 'disk0',
        storage: 'default',
        volume: 'debian-web.qcow2',
        size_bytes: 40 * GiB,
        media: 'disk',
        path: '/var/lib/libvirt/images/debian-web.qcow2',
        boot: true,
      },
      { key: 'cdrom0', media: 'cdrom' },
    ]);
    const pf = await call({ path: `${G('libvirt:pfsense')}/config` });
    expect(pf.restricted).toContain('hostdev0');
    const win = await call({ path: `${G('libvirt:win11')}/config` });
    expect(win.values).toMatchObject({ firmware: 'uefi', secure_boot: '1', tpm: '1' });
    expect(win.disks).toContainEqual(
      expect.objectContaining({ key: 'cdrom0', storage: 'isos', volume: 'isos/virtio-win-0.1.271.iso' }),
    );
    // blackbox's VM keeps its disk in unRAID's domains folder.
    const pbs = await call({ path: `${G('libvirt:pbs', '/api/v1/servers/blackbox')}/config` });
    expect(pbs.disks).toContainEqual(
      expect.objectContaining({ key: 'disk0', storage: 'folder:domains', volume: 'pbs/vdisk1.img' }),
    );
  });

  it('changes a running VM at once where libvirt can and the rest at its next start', async () => {
    const path = `${G('libvirt:debian-web')}/config`;
    const { digest } = await call<{ digest: string }>({ path });
    const changed = await call<{ changes: J[] }>({
      method: 'PUT',
      path,
      body: {
        digest,
        set: {
          memory_mb: '10240',
          vcpus_max: '12',
          title: 'Web',
          cdrom0: 'source=isos/debian-13.1.0-amd64-netinst.iso',
        },
      },
    });
    expect(changed.changes).toEqual([
      { key: 'memory_mb', old: '8192', new: '10240', pending: false },
      { key: 'vcpus_max', old: '8', new: '12', pending: true },
      { key: 'title', old: 'Web server', new: 'Web', pending: false },
      {
        key: 'cdrom0',
        old: 'source=empty,bus=sata',
        new: 'source=isos/debian-13.1.0-amd64-netinst.iso,bus=sata',
        pending: false,
      },
    ]);
    const after = await call({ path });
    expect(after.pending).toEqual({ vcpus_max: '12' });
    expect((after.values as J).memory_mb).toBe('10240');
    expect(fake.guest('kvm-lab', 'libvirt:debian-web')?.memory_limit_mb).toBe(10240);
    // A new disk on a pool: created now, attached at the next start.
    const disk = await call<{ changes: J[] }>({
      method: 'PUT',
      path,
      body: { set: { disk1: 'new=20G,storage=default,format=qcow2' } },
    });
    expect(disk.changes[0]).toMatchObject({
      key: 'disk1',
      new: `source=default/debian-web-disk1.qcow2,bus=virtio,format=qcow2,target=vdb,size=${20 * GiB}`,
      pending: true,
    });
    expect((await pool('default')).volumes).toBe(5);
    // Locked and unknown keys, a stale digest, fields the route doesn't take.
    expect(await refusal({ method: 'PUT', path, body: { set: { firmware: 'uefi' } } })).toMatchObject({
      status: 403,
      code: 'not_allowed',
    });
    expect(await refusal({ method: 'PUT', path, body: { set: { hostdev0: 'x' } } })).toMatchObject({
      code: 'not_allowed',
    });
    expect(await refusal({ method: 'PUT', path, body: { digest, set: { title: 'x' } } })).toMatchObject({
      status: 409,
      code: 'digest_mismatch',
    });
    expect(await refusal({ method: 'PUT', path, body: { devices: {} } })).toMatchObject({
      status: 400,
      code: 'bad_request',
    });
    const bad = await refusal({
      method: 'PUT',
      path,
      body: {
        set: { memory_mb: '999999', disk2: 'new=10G,storage=fast,format=qcow2', net1: 'network=nope' },
      },
    });
    expect(bad?.code).toBe('invalid_value');
    expect(Object.keys(bad?.fieldErrors ?? {}).sort()).toEqual(['disk2', 'memory_mb', 'net1']);
    // A stopped VM takes everything at once; detaching a disk keeps its file.
    const nix = `${G('libvirt:nixos-build')}/config`;
    const off = await call<{ changes: J[] }>({
      method: 'PUT',
      path: nix,
      body: { set: { vcpus_max: '24', cpu_mode: 'host-model' }, delete: ['disk1'] },
    });
    expect(off.changes.every((c) => c.pending === false)).toBe(true);
    expect(((await call({ path: nix })).values as J).disk1).toBeUndefined();
    expect((await pool('fast')).volumes).toBe(4);
  });

  it('grows a disk, live while the VM runs, and never shrinks it', async () => {
    const path = `${G('libvirt:alpine-test')}/disks/disk0/resize`;
    const grown = await call<{ changes: J[] }>({ method: 'POST', path, body: { size: '+2G' } });
    expect(grown.changes[0]?.new).toBe(
      `source=default/alpine-test.qcow2,bus=virtio,format=qcow2,target=vda,size=${4 * GiB}`,
    );
    expect(await refusal({ method: 'POST', path, body: { size: '1G' } })).toMatchObject({
      code: 'invalid_value',
    });
    expect(
      await refusal({
        method: 'POST',
        path: `${G('libvirt:alpine-test')}/disks/disk7/resize`,
        body: { size: '+1G' },
      }),
    ).toMatchObject({ status: 404 });
  });

  it('offers the host’s pools, networks, ISO images, OS types and firmware, and unRAID’s folders', async () => {
    const c = await call({ path: `${S}/manage/choices`, query: { platform: 'libvirt' } });
    expect(c.platform).toBe('libvirt');
    expect((c.storages as J[]).map((s) => [s.id, s.type, s.content])).toEqual([
      ['default', 'dir', ['images', 'iso']],
      ['isos', 'dir', ['images', 'iso']],
      ['fast', 'logical', ['images']],
    ]);
    expect(c.bridges).toEqual(['br0']);
    expect(c.networks).toEqual(['default', 'lan']);
    expect(c.isos).toContainEqual({
      volid: 'isos/debian-13.1.0-amd64-netinst.iso',
      name: 'debian-13.1.0-amd64-netinst.iso',
      size_bytes: 754_974_720,
    });
    expect(c.os_variants).toContainEqual({ id: 'win11', label: 'Windows 11', firmware: 'uefi', tpm: true });
    expect(c.firmware).toEqual({ uefi: true, secure_boot: true, tpm: true });
    // Without a platform on a QEMU/KVM server it's libvirt too.
    expect((await call({ path: `${S}/manage/choices` })).platform).toBe('libvirt');
    const box = await call({
      path: '/api/v1/servers/blackbox/manage/choices',
      query: { platform: 'libvirt' },
    });
    expect(box.storages).toEqual([
      { id: 'folder:domains', type: 'dir', content: ['images'] },
      { id: 'folder:isos', type: 'dir', content: ['iso'] },
    ]);
    expect((box.isos as J[]).map((i) => i.volid)).toContain('folder:isos/virtio-win-0.1.271.iso');
    // unRAID's ISO folder takes downloads; it has no pools for volumes.
    const dl = await call<{ task: { id: string } }>({
      method: 'POST',
      path: '/api/v1/servers/blackbox/storage/folder:isos/download',
      body: {
        platform: 'libvirt',
        content: 'iso',
        url: 'https://x.example/debian-13.iso',
        filename: 'debian-13.iso',
      },
    });
    expect(await finished(dl.task.id, '/api/v1/servers/blackbox')).toMatchObject({ status: 'ok' });
    expect(
      await refusal({
        method: 'POST',
        path: '/api/v1/servers/blackbox/libvirt/pools/default/volumes',
        body: { name: 'x.qcow2', size: '1GiB' },
      }),
    ).toMatchObject({ status: 501, code: 'unsupported' });
  });

  it('creates a VM as a task, and refuses Windows 11 on a host without a TPM', async () => {
    const started = await call<{ task: { id: string }; new_id: string }>({
      method: 'POST',
      path: `${S}/guests`,
      body: {
        platform: 'libvirt',
        kind: 'vm',
        name: 'ubuntu-1',
        os_variant: 'ubuntu2404',
        iso: 'isos/ubuntu-24.04.3-live-server-amd64.iso',
        storage: 'default',
        disk_gb: 40,
        network: 'default',
        set: { memory_mb: '4096', vcpus: '2' },
        start: true,
      },
    });
    expect(started.task.id).toMatch(/^libvirt:[0-9a-f]{16}$/);
    expect(started.new_id).toBe('libvirt:ubuntu-1');
    expect(await finished(started.task.id)).toMatchObject({ status: 'ok', type: 'create' });
    expect(fake.guest('kvm-lab', 'libvirt:ubuntu-1')).toMatchObject({
      state: 'running',
      image: 'q35 · OVMF',
    });
    const cfg = await call({ path: `${G('libvirt:ubuntu-1')}/config` });
    expect(cfg.values).toMatchObject({
      memory_mb: '4096',
      memory_max_mb: '4096',
      firmware: 'uefi',
      cdrom0: 'source=isos/ubuntu-24.04.3-live-server-amd64.iso,bus=sata',
      disk0: `source=default/ubuntu-1.qcow2,bus=virtio,format=qcow2,target=vda,size=${40 * GiB}`,
    });
    expect(
      await refusal({
        method: 'POST',
        path: `${S}/guests`,
        body: { platform: 'libvirt', kind: 'vm', name: 'ubuntu-1' },
      }),
    ).toMatchObject({ status: 409, code: 'exists' });
    expect(
      await refusal({
        method: 'POST',
        path: `${S}/guests`,
        body: { platform: 'libvirt', kind: 'container', name: 'ct' },
      }),
    ).toMatchObject({ code: 'invalid_value' });
    expect(
      await refusal({
        method: 'POST',
        path: `${S}/guests`,
        body: { platform: 'libvirt', kind: 'vm', name: '-bad' },
      }),
    ).toMatchObject({ code: 'invalid_value' });
    boxFirmware().tpm = false;
    const win = await refusal({
      method: 'POST',
      path: '/api/v1/servers/blackbox/guests',
      body: {
        platform: 'libvirt',
        kind: 'vm',
        name: 'win11',
        os_variant: 'win11',
        storage: 'folder:domains',
      },
    });
    expect(win?.code).toBe('invalid_value');
    expect(win?.fieldErrors?.os_variant).toMatch(/TPM/);
    boxFirmware().tpm = true;
  });

  it('backs up as a task, lists the backup, restores it as a new VM and deletes it', async () => {
    const before = await call<{ items: J[] }>({ path: `${G('libvirt:debian-web')}/backups` });
    expect(before.items).toEqual([
      {
        volume: '20261009-031500',
        storage: 'libvirt',
        guest: 'libvirt:debian-web',
        kind: 'vm',
        size_bytes: 11_811_160_064,
        created: '2026-10-09T03:15:00Z',
      },
    ]);
    expect(
      await refusal({ method: 'POST', path: `${G('libvirt:pfsense')}/backups`, body: { mode: 'snapshot' } }),
    ).toMatchObject({ code: 'invalid_value' });
    const started = await call<{ task: { id: string } }>({
      method: 'POST',
      path: `${G('libvirt:pfsense')}/backups`,
      body: { compress: true },
    });
    const t = await finished(started.task.id);
    expect(t).toMatchObject({ status: 'ok', type: 'backup' });
    expect(t.log).toContain('Backup job finished');
    const list = await call<{ items: J[] }>({ path: `${G('libvirt:pfsense')}/backups` });
    expect(list.items).toHaveLength(1);
    const volume = String(list.items[0]?.volume);
    expect(volume).toMatch(/^\d{8}-\d{6}$/);
    // The hint names the VM made meanwhile now, not pfsense.
    expect(
      ((await call({ path: S })).hints as J[]).find((h) => h.kind === 'libvirt.no_backup'),
    ).toMatchObject({
      entity: 'libvirt:ubuntu-1',
      detail: 'ubuntu-1',
    });
    const restore = await call<{ task: { id: string }; new_id: string }>({
      method: 'POST',
      path: `${S}/backups/restore`,
      body: {
        platform: 'libvirt',
        guest: 'libvirt:pfsense',
        volume,
        name: 'pfsense-copy',
        storage: 'default',
      },
    });
    expect(restore.new_id).toBe('libvirt:pfsense-copy');
    expect(await finished(restore.task.id)).toMatchObject({ status: 'ok', type: 'restore' });
    const copy = await call({ path: `${G('libvirt:pfsense-copy')}/config` });
    expect((copy.values as J).disk0).toMatch(/^source=default\/pfsense-copy\.img,bus=virtio,format=raw,/);
    expect((copy.values as J).net0).not.toContain('52:54:00:51:0e:aa');
    expect(
      await refusal({
        method: 'POST',
        path: `${S}/backups/restore`,
        body: { platform: 'libvirt', guest: 'libvirt:pfsense', volume, name: 'pfsense-copy' },
      }),
    ).toMatchObject({ status: 409, code: 'exists' });
    expect(
      await call({
        method: 'DELETE',
        path: `${S}/backups`,
        query: { platform: 'libvirt', guest: 'libvirt:pfsense', volume },
      }),
    ).toMatchObject({ ok: true });
    expect((await call<{ items: J[] }>({ path: `${G('libvirt:pfsense')}/backups` })).items).toEqual([]);
  });

  it('keeps pool volumes and ISO images a VM uses', async () => {
    const del = (path: string, query: J = {}) =>
      refusal({ method: 'DELETE', path, query: query as HostsRequest['query'] });
    expect(await del(`${S}/libvirt/pools/fast/volumes/win11`, { confirm: 1 })).toMatchObject({
      status: 409,
      code: 'in_use',
    });
    expect(await del(`${S}/libvirt/pools/default/volumes/debian-13-genericcloud-amd64.qcow2`)).toMatchObject({
      code: 'confirm_required',
    });
    const count = Number((await pool('default')).volumes);
    expect(
      await del(`${S}/libvirt/pools/default/volumes/debian-13-genericcloud-amd64.qcow2`, { confirm: 1 }),
    ).toBeNull();
    expect((await pool('default')).volumes).toBe(count - 1);
    expect(
      await call({
        method: 'POST',
        path: `${S}/libvirt/pools/default/volumes`,
        body: { name: 'data.qcow2', size: '20GiB', format: 'qcow2' },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await refusal({
        method: 'POST',
        path: `${S}/libvirt/pools/fast/volumes`,
        body: { name: 'big', size: '500GiB' },
      }),
    ).toMatchObject({ code: 'invalid_value' });
    expect(
      await call({
        method: 'POST',
        path: `${S}/libvirt/pools/default/volumes/data.qcow2/resize`,
        body: { size: '30GiB' },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await del(`${S}/storage/content`, { platform: 'libvirt', volume: 'isos/virtio-win-0.1.271.iso' }),
    ).toMatchObject({ status: 409, code: 'in_use' });
    const isos = await call<{ items: J[] }>({
      path: `${S}/storage/isos/content`,
      query: { platform: 'libvirt', content: 'iso' },
    });
    expect(isos.items).toContainEqual(
      expect.objectContaining({ volume: 'isos/Win11_25H2_English_x64.iso', content: 'iso', storage: 'isos' }),
    );
    expect(
      await del(`${S}/storage/content`, { platform: 'libvirt', volume: 'isos/Win11_25H2_English_x64.iso' }),
    ).toBeNull();
    const dl = await call<{ task: { id: string } }>({
      method: 'POST',
      path: `${S}/storage/isos/download`,
      body: {
        platform: 'libvirt',
        content: 'iso',
        url: 'https://cdimage.debian.org/debian-13.2.0-amd64-netinst.iso',
        filename: 'debian-13.2.0-amd64-netinst.iso',
      },
    });
    expect(await finished(dl.task.id)).toMatchObject({ status: 'ok', type: 'download' });
    expect(
      (
        await call<{ items: J[] }>({ path: `${S}/storage/isos/content`, query: { content: 'iso' } })
      ).items.map((i) => i.name),
    ).toContain('debian-13.2.0-amd64-netinst.iso');
    expect(
      await refusal({
        method: 'POST',
        path: `${S}/storage/fast/download`,
        body: { platform: 'libvirt', content: 'iso', url: 'https://x.example/a.iso', filename: 'a.iso' },
      }),
    ).toMatchObject({ code: 'invalid_value' });
  });

  it('reads a network’s DHCP leases and a VM’s QEMU log and snapshots', async () => {
    const leases = await call<{ items: J[] }>({ path: `${S}/libvirt/networks/default/leases` });
    expect(leases.items).toContainEqual({
      hostname: 'win11',
      address: '192.168.122.160',
      hwaddr: '52:54:00:9c:41:d2',
      type: 'dynamic',
      guest: 'libvirt:win11',
    });
    expect(leases.items.some((l) => l.guest === null)).toBe(true);
    expect((await call<{ items: J[] }>({ path: `${S}/libvirt/networks/lan/leases` })).items).toEqual([]);
    expect(await refusal({ path: `${S}/libvirt/networks/nope/leases` })).toMatchObject({ status: 404 });
    const log = await call<{ file: string; lines: string[] }>({
      path: `${G('libvirt:win11')}/log`,
      query: { lines: 5 },
    });
    expect(log.file).toBe('win11.log');
    expect(log.lines).toHaveLength(5);
    const full = await call<{ lines: string[] }>({ path: `${G('libvirt:win11')}/log` });
    expect(full.lines.some((l) => l.includes('starting up libvirt version: 12.2.0'))).toBe(true);
    expect(await refusal({ path: `${G('libvirt:win11')}/log`, query: { lines: 5000 } })).toMatchObject({
      fieldErrors: { lines: 'A number of lines from 1 to 2000.' },
    });
    const snaps = await call<{ items: J[] }>({ path: `${G('libvirt:debian-web')}/snapshots` });
    expect(snaps.items.map((s) => s.Name)).toEqual(['before-php84']);
    const tasks = await call<{ items: J[] }>({ path: `${G('libvirt:debian-web')}/tasks` });
    expect(tasks.items[0]).toMatchObject({ type: 'backup', guest: 'libvirt:debian-web', status: 'ok' });
  });

  it('renames and clones only a stopped VM, and refuses changes to the guest this Whombat runs in', async () => {
    expect(
      await refusal({ method: 'POST', path: `${G('libvirt:win11')}/rename`, body: { name: 'win11-old' } }),
    ).toMatchObject({ status: 409, code: 'guest_running' });
    const renamed = await call<{ new_id: string }>({
      method: 'POST',
      path: `${G('libvirt:alpine-test')}/rename`,
      body: { name: 'alpine-3' },
    });
    expect(renamed.new_id).toBe('libvirt:alpine-3');
    expect(fake.guest('kvm-lab', 'libvirt:alpine-test')).toBeNull();
    expect(((await call({ path: `${G('libvirt:alpine-3')}/config` })).values as J).name).toBe('alpine-3');
    expect(
      await refusal({ method: 'POST', path: `${G('libvirt:win11')}/clone`, body: { name: 'win11-2' } }),
    ).toMatchObject({ code: 'guest_running' });
    expect(
      await refusal({
        method: 'POST',
        path: `${G('libvirt:alpine-3')}/clone`,
        body: { name: 'a2', full: true },
      }),
    ).toMatchObject({ code: 'invalid_value' });
    const clone = await call<{ task: { id: string }; new_id: string }>({
      method: 'POST',
      path: `${G('libvirt:alpine-3')}/clone`,
      body: { name: 'alpine-4', storage: 'fast' },
    });
    expect(clone.new_id).toBe('libvirt:alpine-4');
    await finished(clone.task.id);
    expect(((await call({ path: `${G('libvirt:alpine-4')}/config` })).values as J).disk0).toMatch(
      /^source=fast\/alpine-4,bus=virtio,format=raw,/,
    );
    const del = await call<{ task: { id: string } }>({
      method: 'DELETE',
      path: G('libvirt:alpine-4'),
      query: { confirm_name: 'alpine-4', purge: 1 },
    });
    await finished(del.task.id);
    expect(fake.guest('kvm-lab', 'libvirt:alpine-4')).toBeNull();
    expect((await pool('fast')).volumes).toBe(4);
    const pfsense = fake.guest('kvm-lab', 'libvirt:pfsense') as J;
    pfsense.self = true;
    for (const req of [
      { method: 'PUT', path: `${G('libvirt:pfsense')}/config`, body: { set: { vcpus: '3' } } },
      { method: 'POST', path: `${G('libvirt:pfsense')}/disks/disk0/resize`, body: { size: '+1G' } },
      { method: 'POST', path: `${G('libvirt:pfsense')}/rename`, body: { name: 'fw' } },
      { method: 'DELETE', path: G('libvirt:pfsense'), query: { confirm_name: 'pfsense' } },
    ] as HostsRequest[])
      expect(await refusal(req)).toMatchObject({
        status: 409,
        code: 'self_guest',
        detail: 'That’s this Whombat itself.',
      });
    pfsense.self = undefined;
  });
});
