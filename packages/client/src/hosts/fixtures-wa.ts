/**
 * Stream WA's part of the fixture world (proxmox-wa.md): guests with an EFI disk, TPM state, unused disks, a second
 * network device, CD/DVD drives with images from two ISO storages, mount points, a bind mount, keys only Proxmox may
 * change, and high availability on a cluster guest; and the rules Proxmox has for them — a detached disk becomes
 * `unusedN`, deleting one needs `confirm`, restricted keys are refused, a network that isn't there is a field error, a
 * running guest takes some changes (and removals) at its next restart, disks grow and move (not a running
 * container's), `ha.set` / `ha.remove`. Wraps `createHostsFixtures`' routes (one line there); not production code.
 */
import type { HostGuestConfig } from '@whombat/core/domain';
import { diskFile, diskSize, isCdrom, isCloudInitDrive, keyOrder, NET_RE, volumeStorage } from './config';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';
import { editProps, getProp, parseProps } from './props';

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

/** The world's routes with WA's guests and rules in front of them. */
export function withWaFixtures(world: HostsFixtureWorld, base: Handle): Handle {
  seed(world);
  let seq = 0;
  return (req) => handleWa(world, req, base, () => ++seq) ?? base(req);
}

/* Seed ---------------------------------------------------------------------------------------------- */

const SEED: Record<
  string,
  { values?: Record<string, string>; drop?: string[]; extra?: Partial<HostGuestConfig> }
> = {
  // A running cluster VM: a data disk, an unused disk, a second network on a VLAN, a GPU passed through, HA.
  'pve-02/pve:118': {
    values: {
      scsi1: 'local-zfs:vm-118-disk-2,discard=on,iothread=1,size=200G',
      unused0: 'local-zfs:vm-118-disk-3',
      net1: 'virtio=BC:24:11:3A:18:02,bridge=vmbr1,tag=20',
      vga: 'qxl,memory=32',
      hostpci0: '0000:01:00.0,pcie=1,x-vga=1',
      smbios1: 'uuid=6f1c2e4a-1b2c-4d5e-8f90-a1b2c3d4e518',
      vmgenid: '3b0c7e1d-2a4f-4c6b-9d8e-118118118118',
      startup: 'order=2,up=30,down=120',
    },
    extra: {
      restricted: ['hostpci0', 'smbios1', 'vmgenid'],
      ha: { state: 'started', maxRestart: 1, maxRelocate: 1, status: 'started', comment: 'Production nest' },
    },
  },
  // A running Windows VM: TPM, two ISOs from two storages, a USB device passed through, no cloud-init, and the
  // guest agent's other settings (PX-08); one change waits for a restart.
  'pve-02/pve:123': {
    values: {
      ostype: 'win11',
      cpu: 'host',
      machine: 'pc-q35-9.2+pve1',
      tpmstate0: 'local-zfs:vm-123-disk-2,size=4M,version=v2.0',
      ide0: 'nas-iso:iso/Win11_24H2_English_x64.iso,media=cdrom,size=5683M',
      ide1: 'local:iso/virtio-win-0.1.271.iso,media=cdrom,size=709474K',
      scsi0: 'local-zfs:vm-123-disk-0,cache=writeback,discard=on,iothread=1,ssd=1,size=128G',
      agent: '1,fstrim_cloned_disks=1',
      usb0: 'host=046d:c52b,usb3=1',
      smbios1: 'uuid=0c9a8b7e-6d5f-4e3d-a2c1-b0a9f8e7d123',
      boot: 'order=scsi0;ide0;net0',
      tablet: '1',
    },
    drop: ['ide2', 'ciuser', 'ipconfig0', 'nameserver', 'sshkeys'],
    extra: { pending: { cores: '6' }, restricted: ['usb0', 'smbios1'] },
  },
  // A stopped VM: two unused disks, a serial socket and raw QEMU arguments.
  'pve-02/pve:124': {
    values: {
      unused0: 'local-zfs:vm-124-disk-2',
      unused1: 'local-zfs:vm-124-disk-3',
      serial0: 'socket',
      args: '-cpu host,+invtsc',
      protection: '1',
    },
    extra: { restricted: ['args'] },
  },
  // A running container: a data mount point, a bind mount from the host, an unused volume, a second network with a
  // fixed address, its own DNS, and HA.
  'pve-02/pve:132': {
    values: {
      mp0: 'local-zfs:subvol-132-disk-1,mp=/mnt/data,backup=1,size=200G',
      mp1: '/tank/media,mp=/mnt/media,ro=1',
      unused0: 'local-zfs:subvol-132-disk-2',
      net1: 'name=eth1,bridge=vmbr1,hwaddr=BC:24:11:5C:32:03,ip=10.20.0.32/24,gw=10.20.0.1,ip6=auto,tag=20,type=veth',
      nameserver: '10.100.1.1 1.1.1.1',
      searchdomain: 'lab.example',
      features: 'nesting=1,keyctl=1',
      timezone: 'Europe/Amsterdam',
      cmode: 'tty',
      tty: '2',
    },
    extra: {
      restricted: ['mp1'],
      ha: { state: 'started', maxRestart: 2, maxRelocate: 1, status: 'started' },
    },
  },
  // A container with the GPU's render node passed through (only in Proxmox).
  'pve-02/pve:134': {
    values: { dev0: '/dev/dri/renderD128,gid=104', features: 'nesting=1,mount=nfs' },
    extra: { restricted: ['dev0', 'features'] },
  },
  // A stopped container: its disks can move.
  'pve-02/pve:144': {
    values: { mp0: 'local-zfs:subvol-144-disk-1,mp=/srv/minecraft,backup=1,size=32G' },
  },
};

/** What a container's configuration keeps from its creation (only Proxmox changes it). */
const CT_CREATE_ONLY = ['arch', 'ostype', 'unprivileged'];

function seed(world: HostsFixtureWorld) {
  for (const [key, cfg] of world.configs) {
    const s = SEED[key];
    const values = { ...cfg.values, ...(s?.values ?? {}) };
    for (const k of s?.drop ?? []) delete values[k];
    const restricted = [
      ...new Set([
        ...(cfg.kind === 'container' ? CT_CREATE_ONLY.filter((k) => k in values) : []),
        ...(s?.extra?.restricted ?? []),
      ]),
    ].sort(keyOrder);
    const next: HostGuestConfig = {
      ...cfg,
      ...(s?.extra ?? {}),
      values,
      ...(restricted.length ? { restricted } : {}),
    };
    world.configs.set(key, { ...next, disks: disksOf(next) });
    if (s?.extra?.pending) setPendingCount(world, key, next);
  }
}

/* Routes -------------------------------------------------------------------------------------------- */

const ISOS = [
  {
    volume: 'local:iso/debian-13.1.0-amd64-netinst.iso',
    storage: 'local',
    name: 'debian-13.1.0-amd64-netinst.iso',
    size: 784_334_848,
  },
  {
    volume: 'local:iso/ubuntu-24.04.3-live-server-amd64.iso',
    storage: 'local',
    name: 'ubuntu-24.04.3-live-server-amd64.iso',
    size: 3_213_064_192,
  },
  {
    volume: 'local:iso/virtio-win-0.1.271.iso',
    storage: 'local',
    name: 'virtio-win-0.1.271.iso',
    size: 726_501_376,
  },
  {
    volume: 'nas-iso:iso/Win11_24H2_English_x64.iso',
    storage: 'nas-iso',
    name: 'Win11_24H2_English_x64.iso',
    size: 5_959_151_616,
  },
  {
    volume: 'nas-iso:iso/TrueNAS-SCALE-25.04.iso',
    storage: 'nas-iso',
    name: 'TrueNAS-SCALE-25.04.iso',
    size: 1_870_659_584,
  },
];

/** Keys a running guest takes at once: names, notes, start order, cloud-init, and devices it can hot-plug. */
const LIVE_RE =
  /^(name|hostname|description|tags|onboot|startup|protection|ciuser|cipassword|sshkeys|nameserver|searchdomain|ciupgrade|ipconfig\d+|unused\d+|(scsi|virtio|sata)\d+|net\d+|ide\d+)$/;
const DETACH_RE = /^((ide|sata|scsi|virtio|mp)\d+|efidisk0|tpmstate0)$/;

type Params = { set?: Record<string, string>; delete?: string[]; revert?: string[] };

const API_CODES: Record<number, string> = {
  400: 'bad_request',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
};

function problem(status: number, code: string, message: string, fields?: Record<string, string[]>) {
  return {
    status,
    body: {
      error: {
        code: fields ? 'validation_failed' : (API_CODES[status] ?? 'conflict'),
        message,
        ...(fields ? { fields } : {}),
        details: { code },
      },
    },
  };
}

function handleWa(
  world: HostsFixtureWorld,
  req: HostsFixtureRequest,
  base: Handle,
  next: () => number,
): HostsFixtureAnswer | null {
  const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
  const [, serverId = '', , guestId = ''] = seg;
  const route = `${req.method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
  if (route === 'GET servers/:/manage') {
    if (req.query.op === 'choices') {
      const ans = base(req);
      const body = ans?.body as { choices?: { storages?: unknown[] } } | undefined;
      if (!ans || !body?.choices) return ans;
      const storages = [
        ...(body.choices.storages ?? []),
        {
          id: 'nas-iso',
          type: 'nfs',
          content: ['iso'],
          availBytes: 412 * 1024 ** 3,
          totalBytes: 1024 ** 4,
          shared: true,
        },
        {
          id: 'tank',
          type: 'zfspool',
          content: ['images', 'rootdir'],
          availBytes: 3.1 * 1024 ** 4,
          totalBytes: 8 * 1024 ** 4,
          thin: true,
        },
      ];
      return {
        ...ans,
        body: {
          ...body,
          choices: {
            ...body.choices,
            storages,
            isos: ISOS.map((x) => ({ ...x, content: 'iso', sizeBytes: x.size })),
          },
        },
      };
    }
    if (req.query.op === 'content.list' && req.query.storage === 'nas-iso')
      return {
        status: 200,
        body: {
          op: 'content.list',
          items: ISOS.filter((x) => x.storage === 'nas-iso').map((x) => ({
            volid: x.volume,
            format: 'iso',
            size: x.size,
          })),
        },
      };
    return null;
  }
  if (route === 'POST servers/:/guests/:/actions' && req.body.action === 'reboot') {
    const key = `${serverId}/${guestId}`;
    const before = world.configs.get(key);
    const ans = base(req);
    const after = world.configs.get(key);
    if (before?.pendingDelete?.length && after) {
      const values = { ...after.values };
      for (const k of before.pendingDelete) removeKey(values, k, before.values[k]);
      const cfg = { ...after, values, pendingDelete: [] };
      world.configs.set(key, { ...cfg, disks: disksOf(cfg) });
      setPendingCount(world, key, cfg);
    }
    return ans;
  }
  if (route !== 'POST servers/:/manage') return null;
  const op = String(req.body.op ?? '');
  const gid = typeof req.body.guestId === 'string' ? req.body.guestId : '';
  const key = `${serverId}/${gid}`;
  const cfg = world.configs.get(key);
  const p = (req.body.params ?? {}) as Record<string, unknown>;
  if (!cfg) return null;
  const task = () => ({
    status: 200,
    body: { ok: true, task: { id: `UPID:${serverId}:wa${next()}:${op}` } },
  });
  switch (op) {
    case 'config.set':
      return configSet(world, key, cfg, req, base);
    case 'ha.set': {
      const state = String(p.state ?? 'started') as 'started';
      world.configs.set(key, {
        ...cfg,
        ha: {
          state,
          maxRestart: Number(p.maxRestart ?? 1),
          maxRelocate: Number(p.maxRelocate ?? 1),
          ...(typeof p.comment === 'string' && p.comment ? { comment: p.comment } : {}),
          status: state === 'started' ? 'started' : state,
        },
      });
      return { status: 200, body: { ok: true, auditId: `aud_wa${next()}` } };
    }
    case 'ha.remove':
      world.configs.set(key, { ...cfg, ha: null });
      return { status: 200, body: { ok: true, auditId: `aud_wa${next()}` } };
    case 'disk.resize': {
      const disk = String(p.disk ?? '');
      const v = cfg.values[disk];
      const m = /^\+(\d+)G$/.exec(String(p.size ?? ''));
      if (!v || isCdrom(v))
        return problem(400, 'invalid_value', 'That isn’t a disk of this guest.', {
          disk: ['That isn’t a disk of this guest.'],
        });
      if (!m)
        return problem(400, 'invalid_value', 'Give the growth in GB.', { size: ['Give the growth in GB.'] });
      const size = Math.round((diskSize(v) ?? 0) / 1024 ** 3) + Number(m[1]);
      setValues(world, key, cfg, { [disk]: editProps(v, { size: `${size}G` }, 'file') });
      return task();
    }
    case 'disk.move': {
      const disk = String(p.disk ?? '');
      const storage = String(p.storage ?? '');
      const v = cfg.values[disk];
      if (!v) return problem(404, 'not_found', 'That disk isn’t there any more.');
      if (cfg.running && (cfg.kind === 'container' || disk === 'tpmstate0'))
        return problem(409, 'guest_running', 'Stop it first: this disk moves only while the guest is off.');
      const file = diskFile(v);
      const moved = `${storage}:${file.slice(file.indexOf(':') + 1)}`;
      const dk = cfg.kind === 'vm' ? 'file' : 'volume';
      const values: Record<string, string> = { [disk]: editProps(v, { [dk]: moved }, dk) };
      if (!p.deleteSource) values[freeUnused(cfg.values)] = file;
      setValues(world, key, cfg, values);
      return task();
    }
  }
  return null;
}

function configSet(
  world: HostsFixtureWorld,
  key: string,
  cfg: HostGuestConfig,
  req: HostsFixtureRequest,
  base: Handle,
): HostsFixtureAnswer | null {
  if (req.body.digest && req.body.digest !== cfg.digest)
    return problem(409, 'digest_mismatch', 'Changed meanwhile — review again.');
  const params = (req.body.params ?? {}) as Params;
  const vmid = key.split(':').pop() ?? '0';
  const touched = [...Object.keys(params.set ?? {}), ...(params.delete ?? [])];
  const locked = touched.find((k) => cfg.restricted?.includes(k));
  if (locked) return problem(403, 'not_allowed', `${locked} is changed in Proxmox only.`);
  if (params.delete?.some((k) => /^unused\d+$/.test(k)) && req.body.confirm !== true)
    return problem(400, 'confirm_required', 'Deleting an unused disk destroys it: confirm first.');
  const bridges = ['vmbr0', 'vmbr1'];
  const fields: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(params.set ?? {})) {
    const bridge = NET_RE.test(k) ? getProp(parseProps(v), 'bridge') : undefined;
    if (bridge && !bridges.includes(bridge)) fields[k] = [`${bridge} isn’t a network on this server.`];
  }
  if (Object.keys(fields).length) return problem(400, 'invalid_value', 'Check the fields.', fields);

  // New volumes get their names, attached unused disks leave the unused list.
  const set: Record<string, string> = {};
  const names = new Set(Object.values(cfg.values).map((v) => diskFile(v).split(':').pop()));
  const freshVolume = (prefix: string) => {
    let n = 0;
    while (names.has(`${prefix}-${vmid}-disk-${n}`)) n++;
    names.add(`${prefix}-${vmid}-disk-${n}`);
    return `${prefix}-${vmid}-disk-${n}`;
  };
  const attached: string[] = [];
  for (const [k, v] of Object.entries(params.set ?? {})) {
    const file = diskFile(v);
    const m = /^([a-z0-9-]+):(\d+(?:\.\d+)?)$/.exec(file);
    const rest = v.slice(file.length);
    if (/^[a-z0-9-]+:cloudinit$/.test(file))
      set[k] = `${volumeStorage(file)}:vm-${vmid}-cloudinit,media=cdrom`;
    else if (m && (k === 'efidisk0' || k === 'tpmstate0'))
      set[k] = `${m[1]}:${freshVolume('vm')}${rest},size=${k === 'efidisk0' ? '1M' : '4M'}`;
    else if (m && /^((ide|sata|scsi|virtio)\d+)$/.test(k))
      set[k] = `${m[1]}:${freshVolume('vm')}${rest},size=${m[2]}G`;
    else if (m && /^mp\d+$/.test(k)) set[k] = `${m[1]}:${freshVolume('subvol')}${rest},size=${m[2]}G`;
    else set[k] = v;
    const unused = Object.entries(cfg.values).find(([u, x]) => /^unused\d+$/.test(u) && diskFile(x) === file);
    if (unused) attached.push(unused[0]);
  }

  const before = cfg;
  const ans = base({
    ...req,
    body: { ...req.body, params: { ...params, set, delete: params.delete ?? [] } },
  });
  const after = world.configs.get(key);
  if (ans?.status !== 200 || !after) return ans;
  const values = { ...after.values };
  const pending = { ...(after.pending ?? {}) };
  const pendingDelete = [...(after.pendingDelete ?? [])].filter((k) => !params.revert?.includes(k));
  // An IDE drive takes a new disc at once but can't be added to a running VM.
  const live = (k: string) =>
    !before.running ||
    (LIVE_RE.test(k) && !(/^ide\d+$/.test(k) && !(k in before.values))) ||
    (before.kind === 'container' && NET_RE.test(k));
  for (const k of Object.keys(set))
    if (live(k) && k in pending) {
      values[k] = pending[k] as string;
      delete pending[k];
    }
  for (const k of attached) delete values[k];
  for (const k of params.delete ?? []) {
    const old = before.values[k];
    if (!live(k)) {
      values[k] = old as string;
      if (!pendingDelete.includes(k)) pendingDelete.push(k);
    } else removeKey(values, k, old);
  }
  const cfg2: HostGuestConfig = { ...after, values, pending, pendingDelete };
  world.configs.set(key, { ...cfg2, disks: disksOf(cfg2) });
  setPendingCount(world, key, cfg2);
  const body = ans.body as { changes?: { key: string; pending?: boolean }[] };
  return {
    ...ans,
    body: {
      ...body,
      changes: (body.changes ?? []).map((c) => ({
        ...c,
        pending: c.key in pending || pendingDelete.includes(c.key) || undefined,
      })),
    },
  };
}

/** A key taken out: a disk stays on its storage as an unused disk (CD/DVD and cloud-init drives go). */
function removeKey(values: Record<string, string>, k: string, old: string | undefined) {
  delete values[k];
  if (old && DETACH_RE.test(k) && !isCdrom(old) && !isCloudInitDrive(old) && !diskFile(old).startsWith('/'))
    values[freeUnused(values)] = diskFile(old);
}

function freeUnused(values: Record<string, string>): string {
  for (let i = 0; ; i++) if (!(`unused${i}` in values)) return `unused${i}`;
}

function setValues(
  world: HostsFixtureWorld,
  key: string,
  cfg: HostGuestConfig,
  change: Record<string, string>,
) {
  const next = { ...cfg, values: { ...cfg.values, ...change }, digest: `${cfg.digest}+` };
  world.configs.set(key, { ...next, disks: disksOf(next) });
}

function setPendingCount(world: HostsFixtureWorld, key: string, cfg: HostGuestConfig) {
  const [serverId, guestId] = key.split('/');
  const count = Object.keys(cfg.pending ?? {}).length + (cfg.pendingDelete?.length ?? 0);
  world.guests.set(
    serverId ?? '',
    (world.guests.get(serverId ?? '') ?? []).map((g) =>
      g.id === guestId ? { ...g, pendingChanges: count } : g,
    ),
  );
}

/** The configuration's disks as the hosts service lists them. */
function disksOf(cfg: HostGuestConfig): NonNullable<HostGuestConfig['disks']> {
  const re =
    cfg.kind === 'vm'
      ? /^((ide|sata|scsi|virtio|unused)\d+|efidisk0|tpmstate0)$/
      : /^(rootfs|(mp|unused)\d+)$/;
  const boot = getProp(parseProps(cfg.values.boot ?? ''), 'order')?.split(';') ?? [];
  return Object.entries(cfg.values)
    .filter(([k]) => re.test(k))
    .sort(([a], [b]) => keyOrder(a, b))
    .map(([k, v]) => {
      const file = diskFile(v);
      const size = diskSize(v);
      return {
        key: k,
        ...(file.startsWith('/')
          ? { path: file }
          : { storage: volumeStorage(file), volume: file.slice(file.indexOf(':') + 1) }),
        ...(size != null ? { sizeBytes: size } : {}),
        media: isCdrom(v) ? ('cdrom' as const) : ('disk' as const),
        ...(k.startsWith('unused') ? { unused: true } : {}),
        ...(boot.includes(k) ? { boot: true } : {}),
      };
    });
}
