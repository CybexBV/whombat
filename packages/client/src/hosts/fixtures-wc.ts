/**
 * Stream WC's part of the fixture world (Whombat proxmox.md, the host and fleet pages): what the create dialog, the
 * templates, bulk power, the fleet-wide guests list, storage contents and the System tab need. Hooked into
 * `createHostsFixtures`' `handle` (one line); answers what it knows and leaves the rest (null) to the main handler.
 *
 * The world gets, once: ISO images, container templates and VM templates in the choices (downloads off on pve-01),
 * Proxmox's template catalogue, storage contents that change with downloads and deletes, tags across servers, guests
 * without a backup job, the Proxmox hints with their guests, failed tasks and replication on pve-02, a third cluster
 * node that isn't added, and pve-01's agent older than the service with the shell and server power blocked on it.
 * Creates, clones and deletes change the world. Not imported by production code.
 */
import type {
  HostChoices,
  HostGuest,
  HostGuestPage,
  HostHint,
  HostServerDetail,
  HostServerSettings,
  HostTask,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';

const H = 3600_000;
const DAY = 24 * H;
const GIB = 1024 ** 3;

interface Volume {
  node: string;
  volume: string;
  storage: string;
  content: 'iso' | 'vztmpl' | 'import';
  name: string;
  sizeBytes: number;
  created: string;
}

interface Template {
  id: string;
  name: string;
  kind: 'vm' | 'container';
  node: string;
}

interface WcState {
  volumes: Volume[];
  templates: Map<string, Template[]>;
  nextId: Map<string, number>;
  seq: number;
}

const states = new WeakMap<HostsFixtureWorld, WcState>();

export const WC_APPLIANCES = [
  {
    template: 'debian-13-standard_13.1-2_amd64.tar.zst',
    package: 'debian-13-standard',
    headline: 'Debian 13 (standard)',
    description: 'A small Debian Trixie system',
    version: '13.1-2',
    section: 'system',
    os: 'debian-13',
  },
  {
    template: 'ubuntu-24.04-standard_24.04-2_amd64.tar.zst',
    package: 'ubuntu-24.04-standard',
    headline: 'Ubuntu 24.04 (standard)',
    description: 'A small Ubuntu Noble system',
    version: '24.04-2',
    section: 'system',
    os: 'ubuntu-24.04',
  },
  {
    template: 'alpine-3.22-default_20250617_amd64.tar.xz',
    package: 'alpine-3.22-default',
    headline: 'Alpine 3.22',
    description: 'A tiny Alpine Linux system',
    version: '20250617',
    section: 'system',
    os: 'alpine-3.22',
  },
  {
    template: 'debian-13-turnkey-nextcloud_19.0-1_amd64.tar.gz',
    package: 'turnkey-nextcloud',
    headline: 'TurnKey Nextcloud',
    description: 'Your own file sharing and calendar',
    version: '19.0-1',
    section: 'turnkeylinux',
    os: 'debian-13',
  },
  {
    template: 'debian-13-turnkey-wordpress_19.0-1_amd64.tar.gz',
    package: 'turnkey-wordpress',
    headline: 'TurnKey WordPress',
    description: 'A blog and website builder',
    version: '19.0-1',
    section: 'turnkeylinux',
    os: 'debian-13',
  },
  {
    template: 'proxmox-mail-gateway-9.0-standard_9.0-1_amd64.tar.zst',
    package: 'proxmox-mailgateway-9.0',
    headline: 'Proxmox Mail Gateway 9.0',
    description: 'Mail filtering in front of your mail server',
    version: '9.0-1',
    section: 'mail',
    os: 'debian-13',
  },
];

const TAGS: Record<string, Record<string, string[]>> = {
  'pve-01': { 'backup-proxy': ['prod', 'backup'], 'lab-vm-1': ['lab'], 'lab-vm-2': ['lab'] },
  'pve-02': { 'old-wp-staging': ['lab', 'web'], 'test-ct': ['lab'], minecraft: ['games'] },
};
const NO_BACKUP_JOB: Record<string, string[]> = { 'pve-02': ['minecraft', 'test-ct', 'old-wp-staging'] };

function seed(world: HostsFixtureWorld, now: number, refresh: (serverId: string) => void): WcState {
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const vol = (node: string, volume: string, sizeBytes: number, daysAgo: number): Volume => {
    const [storage = '', rest = ''] = volume.split(':');
    const [kind = 'iso', name = ''] = rest.split('/');
    return {
      node,
      volume,
      storage,
      content: kind as Volume['content'],
      name,
      sizeBytes,
      created: at(daysAgo * DAY),
    };
  };
  const volumes: Volume[] = [];
  for (const node of ['pve-01', 'pve-02'])
    volumes.push(
      vol(node, 'local:iso/debian-13.1.0-amd64-netinst.iso', 784_334_848, 30),
      vol(node, 'local:iso/ubuntu-24.04.3-live-server-amd64.iso', 3_213_064_192, 52),
      vol(node, 'local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst', 123_731_968, 40),
      vol(node, 'nas-iso:iso/proxmox-backup-server_4.0-1.iso', 1_386_217_472, 21),
    );
  volumes.push(
    vol('pve-02', 'local:iso/Win11_24H2_English_x64.iso', 5_819_484_160, 12),
    vol('pve-02', 'nas-iso:iso/virtio-win-0.1.271.iso', 727_531_520, 12),
    vol('pve-02', 'local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst', 141_426_688, 20),
    vol('pve-02', 'local:import/haos_ova-16.2.qcow2', 512 * 1024 ** 2, 9),
  );
  const st: WcState = {
    volumes,
    templates: new Map([
      [
        'pve-02',
        [
          { id: '9000', name: 'debian-13-cloud', kind: 'vm', node: 'pve-02' },
          { id: '9001', name: 'ubuntu-24.04-cloud', kind: 'vm', node: 'pve-02' },
          { id: '9100', name: 'debian-13-base', kind: 'container', node: 'pve-02' },
        ],
      ],
      ['pve-01', [{ id: '9010', name: 'win11-golden', kind: 'vm', node: 'pve-01' }]],
    ]),
    nextId: new Map([
      ['pve-02', 146],
      ['pve-01', 234],
    ]),
    seq: 0,
  };

  // Tags across servers, guests without a backup job.
  for (const [serverId, list] of world.guests) {
    world.guests.set(
      serverId,
      list.map((g) => ({
        ...g,
        tags: TAGS[serverId]?.[g.name] ?? g.tags,
        backupJob: NO_BACKUP_JOB[serverId]?.includes(g.name) ? false : g.backupJob,
      })),
    );
  }
  // The Proxmox hints as the hub folds them (one per kind, the guests in the detail).
  const pve02 = world.guests.get('pve-02') ?? [];
  const pending = pve02.filter((g) => (g.pendingChanges ?? 0) > 0);
  const hints: HostHint[] = [
    {
      serverId: 'pve-02',
      kind: 'guest.no_backup_job',
      severity: 'info',
      entity: 'pve',
      title: `${NO_BACKUP_JOB['pve-02']?.length} machines aren’t in a backup plan`,
      detail: (NO_BACKUP_JOB['pve-02'] ?? []).join(', '),
      section: 'guests',
    },
    {
      serverId: 'pve-02',
      kind: 'guest.pending_changes',
      severity: 'info',
      entity: 'pve',
      title:
        pending.length === 1
          ? '1 machine needs a restart to apply changes'
          : `${pending.length} machines need a restart to apply changes`,
      detail: pending
        .map((g) => `${g.name} (${g.pendingChanges === 1 ? '1 change' : `${g.pendingChanges} changes`})`)
        .join(', '),
      section: 'guests',
    },
    {
      serverId: 'pve-02',
      kind: 'storage.overcommit',
      severity: 'info',
      entity: 'storage:local-zfs',
      title: 'Storage “local-zfs” has promised more space than it has',
      detail: 'Its machines may grow to 2.6 TB; it holds 2 TB (130%)',
      section: 'storage',
    },
  ];
  world.hints.push(...hints.filter((h) => h.detail));
  for (const id of world.guests.keys()) refresh(id);
  return st;
}

function failedTasks(serverId: string, now: number): HostTask[] {
  if (serverId !== 'pve-02') return [];
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  return [
    {
      id: 'UPID:pve-02:000A1F2C:vzdump:121',
      type: 'vzdump',
      platform: 'pve',
      guestId: 'pve:121',
      node: 'pve-02',
      user: 'root@pam',
      started: at(5 * H + 20 * 60_000),
      ended: at(5 * H),
      status: 'error',
      message: 'unable to create temporary directory on storage pbs: connection timed out',
    },
    {
      id: 'UPID:pve-02:000B03D1:qmigrate:124',
      type: 'qmigrate',
      platform: 'pve',
      guestId: 'pve:124',
      node: 'pve-02',
      user: 'john@pam',
      started: at(26 * H),
      ended: at(26 * H - 40_000),
      status: 'error',
      message: 'storage local-lvm is not available on node pve-01',
    },
    {
      id: 'UPID:pve-02:000C77E0:aptupdate',
      type: 'aptupdate',
      platform: 'pve',
      guestId: null,
      node: 'pve-02',
      user: 'root@pam',
      started: at(3 * DAY),
      ended: at(3 * DAY - 9_000),
      status: 'error',
      message: 'failed to update the package lists',
    },
  ];
}

/** What GET servers/:id shows on top of the main world (patched on read, so refreshes keep it). */
function patchDetail(d: HostServerDetail, now: number): HostServerDetail {
  const id = d.server.id;
  let out = d;
  if (id === 'pve-02' && d.health) {
    out = {
      ...out,
      health: {
        ...d.health,
        tasks: [...failedTasks(id, now), ...(d.health.tasks ?? [])],
        pveReplication: [
          {
            id: '118-0',
            guest: 'pve:118',
            target: 'pve-01',
            lastSync: new Date(now - 14 * 60_000).toISOString(),
            error: null,
            fails: 0,
          },
          {
            id: '131-0',
            guest: 'pve:131',
            target: 'pve-01',
            lastSync: new Date(now - 2 * DAY).toISOString(),
            error: 'no space left on device (storage local-zfs on pve-01)',
            fails: 4,
          },
        ],
      },
    };
  }
  if (id === 'pve-01') {
    const reason = 'Switched off on pve-01 itself.';
    out = {
      ...out,
      server: {
        ...out.server,
        agent: { ...out.server.agent, version: '0.15.2' },
        remoteControl: {
          ...out.server.remoteControl,
          hostShell: false,
          agentHostShell: false,
          hostShellReason: reason,
          hostPower: false,
          agentHostPower: false,
          hostPowerReason: reason,
        },
      },
    };
  }
  if (out.proxmox && !out.proxmox.storages.some((x) => x.id === 'nas-iso'))
    out = {
      ...out,
      proxmox: {
        ...out.proxmox,
        storages: [
          ...out.proxmox.storages.map((x) =>
            x.id === 'local' ? { ...x, content: 'iso,vztmpl,backup,import' } : x,
          ),
          { id: 'nas-iso', type: 'nfs', content: 'iso', usedGb: 4900, capacityGb: 8000 },
        ],
      },
    };
  const c = out.proxmox?.cluster;
  if (c && out.proxmox && !c.nodes.some((n) => n.name === 'pve-03'))
    out = {
      ...out,
      proxmox: {
        ...out.proxmox,
        cluster: {
          ...c,
          votes: { have: c.votes.have, expected: c.votes.expected + 1 },
          nodes: [
            ...c.nodes,
            {
              name: 'pve-03',
              thisNode: false,
              status: 'offline',
              cpuPct: null,
              memPct: null,
              vms: 0,
              containers: 2,
              agent: 'not_enrolled',
              serverId: null,
            },
          ],
        },
      },
    };
  return out;
}

function patchSettings(s: HostServerSettings): HostServerSettings {
  if (s.id !== 'pve-01') return s;
  return {
    ...s,
    agentPolicy: { ...s.agentPolicy, hostShell: false, hostPower: false },
    remoteControl: { ...s.remoteControl, hostShell: false, hostPower: false },
    agent: { ...(s.agent ?? { version: null }), version: '0.15.2', update: { available: false } },
  };
}

function bad(message: string, fields?: Record<string, string[]>): HostsFixtureAnswer {
  return {
    status: 400,
    body: { error: { code: 'bad_request', message, ...(fields ? { fields } : {}) } },
  };
}

function newGuest(serverId: string, vmid: number, p: Record<string, unknown>): HostGuest {
  const set = (p.set ?? {}) as Record<string, string>;
  const kind = p.kind === 'container' ? 'container' : 'vm';
  const on = p.start === true;
  const mem = Number(set.memory ?? 512);
  return {
    id: `pve:${vmid}`,
    serverId,
    serverOnline: true,
    name: String(p.name ?? `guest-${vmid}`),
    platform: 'pve',
    kind,
    image:
      kind === 'vm' ? (set.ostype?.startsWith('win') ? 'Windows' : 'Linux 6.x kernel') : 'debian-13-standard',
    state: on ? 'running' : 'stopped',
    vcpu: Number(set.cores ?? 1) * Number(set.sockets ?? 1),
    cpuPct: on ? 0.4 : null,
    memoryUsedMb: on ? Math.round(mem / 4) : null,
    memoryLimitMb: mem,
    snapshots: 0,
    uptimeS: on ? 30 : null,
    console: {
      available: on,
      protocols: kind === 'vm' ? ['vnc', 'serial'] : ['tty', 'shell'],
      defaultProtocol: kind === 'vm' ? 'vnc' : 'tty',
    },
    vmid,
    node: serverId,
    lastBackup: null,
    addresses: [],
    tags: [],
    pendingChanges: 0,
    guestAgent: kind === 'vm' && set.agent === '1' && on ? 'not_running' : null,
    backupJob: false,
    haState: null,
  };
}

const STATE_ORDER: Record<string, number> = { unhealthy: 0, running: 1, paused: 2, stopped: 3 };

function listGuests(world: HostsFixtureWorld, query: Record<string, string>): HostGuestPage {
  const scope = query.server ? (world.guests.get(query.server) ?? []) : [...world.guests.values()].flat();
  const q = (query.q ?? '').trim().toLowerCase();
  const matches = (g: HostGuest) =>
    !q ||
    [g.name, g.id, String(g.vmid ?? ''), g.image, ...(g.tags ?? [])].some((v) => v.toLowerCase().includes(q));
  const base = scope.filter(
    (g) =>
      matches(g) &&
      (!query.platform || g.platform === query.platform) &&
      (!query.kind || g.kind === query.kind),
  );
  const tag = query.tag?.toLowerCase();
  const tagged = tag ? base.filter((g) => (g.tags ?? []).some((t) => t.toLowerCase() === tag)) : base;
  const list = tagged.filter((g) => !query.state || g.state === query.state);
  const sort = query.sort ?? 'cpu';
  const key = sort.replace(/^[-+]/, '') || 'cpu';
  const descDefault = key === 'cpu' || key === 'memory';
  const desc = sort.startsWith('-') ? true : sort.startsWith('+') ? false : descDefault;
  const val = (g: HostGuest): number | string =>
    key === 'name'
      ? g.name.toLowerCase()
      : key === 'server'
        ? g.serverId
        : key === 'state'
          ? (STATE_ORDER[g.state] ?? 9)
          : key === 'memory'
            ? (g.memoryUsedMb ?? -1)
            : (g.cpuPct ?? -1);
  const sorted = [...list].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return (desc ? -c : c) || a.name.localeCompare(b.name);
  });
  const limit = Math.min(500, Number(query.limit ?? 100) || 100);
  const offset = Number(query.cursor ?? 0) || 0;
  const tags: Record<string, number> = {};
  for (const g of tagged) for (const t of g.tags ?? []) tags[t] = (tags[t] ?? 0) + 1;
  const platforms: Record<string, number> = {};
  for (const g of tagged) platforms[g.platform] = (platforms[g.platform] ?? 0) + 1;
  return {
    guests: sorted.slice(offset, offset + limit),
    total: sorted.length,
    nextCursor: offset + limit < sorted.length ? String(offset + limit) : null,
    counts: {
      all: tagged.length,
      running: tagged.filter((g) => g.state === 'running').length,
      stopped: tagged.filter((g) => g.state === 'stopped').length,
      unhealthy: tagged.filter((g) => g.state === 'unhealthy').length,
    },
    platforms,
    tags,
  };
}

/**
 * Stream WC's routes over the fixture world, or null for the main handler. `refresh` is the main fixtures' server
 * refresh (details and rows from the world's guests).
 */
export function handleWc(
  req: HostsFixtureRequest,
  world: HostsFixtureWorld,
  now: number,
  refresh: (serverId: string) => void,
): HostsFixtureAnswer | null {
  let st = states.get(world);
  if (!st) {
    st = seed(world, now, refresh);
    states.set(world, st);
  }
  const { method, path, query, body } = req;
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  const route = `${method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
  const a = seg[1] ?? '';
  const volumesOn = (server: string) => st.volumes.filter((v) => v.node === server);

  switch (route) {
    case 'GET guests':
      return { status: 200, body: listGuests(world, query) };
    case 'GET servers/:': {
      const d = world.details.get(a);
      return d ? { status: 200, body: patchDetail(d, now) } : null;
    }
    case 'GET servers/:/settings': {
      const s = world.settings.get(a);
      return s ? { status: 200, body: patchSettings(s) } : null;
    }
    case 'GET servers/:/manage': {
      if (query.op === 'choices') {
        const base = world.details.get(a);
        if (!base?.proxmox) return null;
        const mine = volumesOn(a);
        const choices: Partial<HostChoices> = {
          nextId: st.nextId.get(a) ?? 100,
          isos: mine
            .filter((v) => v.content === 'iso')
            .map(({ volume, name, storage }) => ({ volume, name, storage })),
          ctTemplates: mine
            .filter((v) => v.content === 'vztmpl')
            .map(({ volume, name, storage }) => ({ volume, name, storage })),
          templates: st.templates.get(a) ?? [],
          download: a !== 'pve-01',
        };
        return { status: 200, body: { op: 'choices', choices: choicesFor(a, choices) } };
      }
      if (query.op === 'content.list') {
        const items = volumesOn(a).filter(
          (v) => v.storage === query.storage && (!query.content || v.content === query.content),
        );
        return {
          status: 200,
          body: {
            op: 'content.list',
            items: items.map(({ volume, storage, content, name, sizeBytes, created }) => ({
              volume,
              storage,
              content,
              name,
              sizeBytes,
              created,
            })),
          },
        };
      }
      if (query.op === 'appliance.list')
        return { status: 200, body: { op: 'appliance.list', items: WC_APPLIANCES } };
      return null;
    }
    case 'POST servers/:/manage': {
      const op = String(body.op ?? '');
      const p = (body.params ?? {}) as Record<string, unknown>;
      const task = (what: string) => ({ ok: true, task: { id: `UPID:${a}:wc${++st.seq}:${what}` } });
      if (op === 'guest.create') {
        const set = (p.set ?? {}) as Record<string, string>;
        const fields: Record<string, string[]> = {};
        if (!String(p.name ?? '').trim()) fields.name = ['Give it a name.'];
        if (p.kind === 'container' && !set.ostemplate) fields.ostemplate = ['Pick a template.'];
        if (p.kind === 'vm' && !set.scsi0) fields.scsi0 = ['Pick a storage.'];
        if (Object.keys(fields).length) return bad('Some fields need a look.', fields);
        const id = typeof p.newId === 'number' ? p.newId : (st.nextId.get(a) ?? 100);
        const list = world.guests.get(a) ?? [];
        if (list.some((g) => g.vmid === id))
          return bad(`ID ${id} is taken.`, { new_id: [`${id} is taken.`] });
        world.guests.set(a, [...list, newGuest(a, id, p)]);
        st.nextId.set(a, Math.max(st.nextId.get(a) ?? 100, id + 1));
        refresh(a);
        return { status: 200, body: { ...task('qmcreate'), newId: `pve:${id}` } };
      }
      const tpls = st.templates.get(a) ?? [];
      const tpl = tpls.find((t) => `pve:${t.id}` === body.guestId);
      if (tpl && op === 'guest.delete') {
        st.templates.set(
          a,
          tpls.filter((t) => t !== tpl),
        );
        return { status: 200, body: task('qmdestroy') };
      }
      if (tpl && op === 'guest.clone') {
        const id = typeof p.newId === 'number' ? p.newId : (st.nextId.get(a) ?? 100);
        world.guests.set(a, [
          ...(world.guests.get(a) ?? []),
          newGuest(a, id, {
            name: p.name,
            kind: tpl.kind,
            start: false,
            set: { memory: '2048', cores: '2' },
          }),
        ]);
        st.nextId.set(a, Math.max(st.nextId.get(a) ?? 100, id + 1));
        refresh(a);
        return { status: 200, body: { ...task('qmclone'), newId: `pve:${id}` } };
      }
      if (op === 'content.download' || op === 'appliance.download') {
        const storage = String(p.storage ?? '');
        const filename = op === 'appliance.download' ? String(p.template ?? '') : String(p.filename ?? '');
        const content =
          op === 'appliance.download' ? 'vztmpl' : (String(p.content ?? 'iso') as Volume['content']);
        if (!storage || !filename) return bad('storage and filename: required.');
        if (p.checksum && !p.checksumAlgorithm) return bad('checksum_algorithm: required with a checksum.');
        const v: Volume = {
          node: a,
          volume: `${storage}:${content}/${filename}`,
          storage,
          content,
          name: filename,
          sizeBytes: 512 * 1024 ** 2,
          created: new Date(now).toISOString(),
        };
        st.volumes.push(v);
        return { status: 200, body: task(op === 'appliance.download' ? 'aplinfo' : 'download') };
      }
      if (op === 'content.delete') {
        const volume = String(p.volume ?? '');
        st.volumes = st.volumes.filter((v) => !(v.volume === volume && v.node === a));
        return { status: 200, body: task('imgdel') };
      }
      return null;
    }
  }
  return null;
}

function choicesFor(serverId: string, extra: Partial<HostChoices>): HostChoices {
  const storages: HostChoices['storages'] = [
    {
      id: 'local',
      type: 'dir',
      content: ['iso', 'vztmpl', 'backup', 'import'],
      availBytes: 85 * GIB,
      totalBytes: 94 * GIB,
    },
    {
      id: 'local-zfs',
      type: 'zfspool',
      content: ['images', 'rootdir'],
      availBytes: 1129 * GIB,
      totalBytes: 2000 * GIB,
      thin: true,
    },
    {
      id: 'nas-iso',
      type: 'nfs',
      content: ['iso'],
      availBytes: 3100 * GIB,
      totalBytes: 8000 * GIB,
      shared: true,
    },
    {
      id: 'pbs',
      type: 'pbs',
      content: ['backup'],
      availBytes: 2790 * GIB,
      totalBytes: 4000 * GIB,
      shared: true,
    },
  ];
  return {
    platform: 'pve',
    node: serverId,
    cluster: true,
    storages,
    bridges: ['vmbr0', 'vmbr1'],
    cpuTypes: ['x86-64-v2-AES', 'x86-64-v3', 'x86-64-v4', 'host', 'kvm64', 'qemu64'],
    nodes: ['pve-01', 'pve-02', 'pve-03'].filter((n) => n !== serverId),
    ...extra,
  };
}
