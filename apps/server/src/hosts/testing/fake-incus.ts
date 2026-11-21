/**
 * The fake hosts service's Incus side (basalt; the Incus and unRAID build brief §2.2, hosts/docs/MANAGE.md §2.5):
 * projects, storage pools and custom volumes, images, profiles, networks with leases, instance backups, operations
 * (tasks `incus:<uuid>`), the instance log, rename, move and publish. Routes it doesn't own for a guest or server
 * answer `null`, so the Proxmox side (`fake-manage.ts`) gets them.
 *
 * Its state lives on the server's detail (`detail.incus`), so `GET /servers/{id}` shows every change: the counts that
 * follow from the instances (a project's instances, a profile's and a network's users, a volume's instances, a pool's
 * volumes) are read when the detail is. What the detail doesn't carry — instance profiles and devices, profile
 * configurations, backups — is kept here; instance settings are the fake's guest configurations (`configOf`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';
import type { FakeManage, GuestConfigState, ManageHost } from './fake-manage';

type Device = Record<string, string>;
type Devices = Record<string, Device>;
type Role = 'operator' | 'admin';
type Kind = 'vm' | 'container' | 'profile';

interface InstanceState {
  profiles: string[];
  /** The instance's own devices (profiles add theirs underneath). */
  devices: Devices;
}

interface ProfileState {
  config: Record<string, string>;
  devices: Devices;
  digest: number;
}

const SELF = 'That’s this Whombat itself.';
const INSTANCE_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEVICE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,62}$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const SIZE_RE = /^(\+)?(\d+(?:\.\d+)?)\s*([kKMGTP]?)(i?B)?$/;
const CLOUD_INIT_MAX = 64 * 1024;
const GiB = 1024 ** 3;
const DAY = 86_400_000;

const BOOL = /^(?:true|false|yes|no|on|off|1|0)$/i;
const UINT = /^\d{1,10}$/;
/** The instance settings Whombat changes (MANAGE.md §2.5), besides `user.*`. */
const KEYS: Record<string, { re: RegExp; hint: string; containers?: boolean }> = {
  'limits.cpu': {
    re: /^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*$/,
    hint: 'A number of CPUs or a CPU list (0-3,6).',
  },
  'limits.memory': {
    re: /^\d{1,15}(%|B|kB|MB|GB|TB|PB|EB|KiB|MiB|GiB|TiB|PiB|EiB)?$/,
    hint: 'A size such as 4GiB, or a percentage.',
  },
  'limits.memory.swap': { re: BOOL, hint: 'true or false.', containers: true },
  'limits.processes': { re: UINT, hint: 'A whole number.', containers: true },
  'boot.autostart': { re: BOOL, hint: 'true or false.' },
  'boot.autostart.priority': { re: UINT, hint: 'A whole number.' },
  'boot.autostart.delay': { re: UINT, hint: 'A number of seconds.' },
  'boot.host_shutdown_timeout': { re: UINT, hint: 'A number of seconds.' },
  'security.protection.delete': { re: BOOL, hint: 'true or false.' },
  'security.nesting': { re: BOOL, hint: 'true or false.', containers: true },
  'snapshots.schedule': {
    re: /^[A-Za-z0-9*/,@ ._-]{1,200}$/,
    hint: 'A cron expression, or @hourly, @daily, …',
  },
  'snapshots.expiry': { re: /^[0-9A-Za-z ]{1,64}$/, hint: 'A duration such as 2w or 1d 12H.' },
  'snapshots.pattern': { re: /^[^\n]{1,200}$/, hint: 'A name pattern such as snap%d.' },
  description: { re: /^[^\n\r]{0,1024}$/, hint: 'One line of text.' },
};
const USER_KEY = /^user\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NIC_KEYS = new Set([
  'type',
  'name',
  'network',
  'nictype',
  'parent',
  'hwaddr',
  'mtu',
  'vlan',
  'vlan.tagged',
  'ipv4.address',
  'ipv6.address',
  'limits.ingress',
  'limits.egress',
  'limits.max',
  'limits.priority',
  'boot.priority',
  'security.mac_filtering',
  'security.ipv4_filtering',
  'security.ipv6_filtering',
  'security.port_isolation',
  'queue.tx.length',
]);
const DISK_KEYS = new Set([
  'type',
  'path',
  'pool',
  'source',
  'size',
  'size.state',
  'readonly',
  'required',
  'boot.priority',
  'limits.read',
  'limits.write',
  'limits.max',
  'io.bus',
  'io.cache',
]);

/** The common images of `images:` offered when creating an instance (a fixed list in the agent). */
const REMOTE_IMAGES: Json[] = (
  [
    ['debian/13', 'Debian 13 (trixie)'],
    ['debian/13/cloud', 'Debian 13 (trixie) with cloud-init'],
    ['debian/12', 'Debian 12 (bookworm)'],
    ['ubuntu/24.04', 'Ubuntu 24.04 LTS (noble)'],
    ['ubuntu/24.04/cloud', 'Ubuntu 24.04 LTS (noble) with cloud-init'],
    ['ubuntu/22.04', 'Ubuntu 22.04 LTS (jammy)'],
    ['alpine/3.22', 'Alpine 3.22'],
    ['fedora/42', 'Fedora 42'],
    ['archlinux', 'Arch Linux'],
    ['rockylinux/9', 'Rocky Linux 9'],
    ['nixos/25.05', 'NixOS 25.05'],
  ] as const
).flatMap(([alias, description]) =>
  ['container', 'virtual-machine'].map((type) => ({ alias, description, type })),
);

const ROOT_DISK: Device = { type: 'disk', path: '/', pool: 'default' };
const BRIDGE_NIC: Device = { type: 'nic', name: 'eth0', network: 'incusbr0' };

/** The fixture instances' settings, devices and profiles (basalt). */
const SEED: Record<string, { config: Record<string, string>; devices?: Devices; profiles?: string[] }> = {
  nixbuild: {
    config: {
      'limits.cpu': '8',
      'limits.memory': '16GiB',
      'boot.autostart': 'true',
      'snapshots.schedule': '@daily',
      'snapshots.expiry': '2w',
      'image.os': 'NixOS',
      'image.release': '26.05',
      description: 'Nix build machine',
    },
    devices: { root: { ...ROOT_DISK, size: '200GiB' } },
    profiles: ['default', 'gpu'],
  },
  'ci-runner': {
    config: {
      'limits.cpu': '4',
      'limits.memory': '8GiB',
      'boot.autostart': 'true',
      'snapshots.schedule': '0 4 * * *',
      'snapshots.expiry': '3d',
      'image.os': 'Debian',
      'image.release': 'trixie',
      'user.owner': 'ci',
      description: 'GitHub Actions runner',
    },
    devices: { root: { ...ROOT_DISK, size: '60GiB' } },
  },
  'whombat-dev-box': {
    config: {
      'limits.cpu': '4',
      'limits.memory': '16GiB',
      'boot.autostart': 'true',
      'boot.autostart.priority': '90',
      'security.protection.delete': 'true',
      'snapshots.schedule': '0 3 * * *',
      'snapshots.expiry': '7d',
      'image.os': 'NixOS',
      'image.release': '26.05',
      'user.whombat': 'dev',
      description: 'The DEV Whombat',
    },
    devices: {
      root: { ...ROOT_DISK, size: '64GiB' },
      eth0: { type: 'nic', name: 'eth0', nictype: 'bridged', parent: 'br0' },
    },
  },
  'dev-shell': {
    config: {
      'limits.cpu': '4',
      'limits.memory': '4GiB',
      'boot.autostart': 'true',
      'security.nesting': 'true',
      'snapshots.schedule': '@weekly',
      'raw.lxc': 'lxc.apparmor.profile=unconfined',
      'image.os': 'NixOS',
      'image.release': '26.05',
    },
    devices: { media: { type: 'disk', pool: 'default', source: 'media', path: '/srv/media' } },
  },
  'git-mirror': {
    config: {
      'limits.cpu': '2',
      'boot.autostart': 'true',
      'snapshots.schedule': '@weekly',
      'image.os': 'Alpine',
      'image.release': '3.22',
    },
  },
  'mqtt-bridge': {
    config: { 'limits.cpu': '1', 'boot.autostart': 'true', 'image.os': 'Debian', 'image.release': 'trixie' },
  },
  dns: {
    config: {
      'limits.cpu': '1',
      'boot.autostart': 'true',
      'boot.autostart.priority': '100',
      'image.os': 'Alpine',
      'image.release': '3.22',
    },
    devices: { eth0: { ...BRIDGE_NIC, 'ipv4.address': '10.94.12.53' } },
  },
  scratch: {
    config: {
      'limits.cpu': '2',
      'boot.autostart': 'false',
      'security.privileged': 'true',
      'image.os': 'Ubuntu',
      'image.release': 'noble',
    },
  },
};

/** The fixture profiles' settings and devices, by `<project>/<name>`. */
const PROFILES: Record<string, { config: Record<string, string>; devices: Devices }> = {
  'default/default': { config: {}, devices: { root: ROOT_DISK, eth0: BRIDGE_NIC } },
  'default/gpu': { config: {}, devices: { gpu0: { type: 'gpu', gputype: 'physical', pci: '0000:41:00.0' } } },
  'ci-platform/default': { config: {}, devices: { root: ROOT_DISK, eth0: BRIDGE_NIC } },
  'ci-platform/ci': {
    config: { 'limits.cpu': '4', 'limits.memory': '8GiB', 'security.nesting': 'true' },
    devices: { root: { type: 'disk', path: '/', pool: 'fast', size: '40GiB' } },
  },
};

/** The fixture's backups (name, created, size, format, expiry), by instance. */
const BACKUPS: Record<string, [string, string, number, string, string | null][]> = {
  nixbuild: [
    ['whombat-20261004-0300', '2026-10-04T03:00:12Z', 41_875_931_136, 'optimized', '2026-11-03T03:00:00Z'],
  ],
  'whombat-dev-box': [['before-0-89', '2026-10-10T18:22:41Z', 12_884_901_888, 'optimized', null]],
  'dev-shell': [['nix-gc', '2026-09-20T09:14:03Z', 2_147_483_648, 'tar', null]],
  dns: [['whombat-20261009-0400', '2026-10-09T04:00:07Z', 48_234_496, 'tar', '2026-10-23T04:00:00Z']],
};

const audit = () => `au_${randomBytes(6).toString('hex')}`;
const isAnswer = (x: unknown): x is FakeAnswer =>
  !!x && typeof x === 'object' && typeof (x as FakeAnswer).status === 'number';
const strings = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
/** Control characters other than tabs and line breaks. */
const controlled = (s: string) =>
  [...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127;
  });
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** An Incus guest id's project and name (`incus:<name>`, `incus:<project>/<name>`). */
function parseId(id: string): { project: string; name: string } {
  const rest = id.startsWith('incus:') ? id.slice(6) : id;
  const i = rest.indexOf('/');
  return i < 0 ? { project: 'default', name: rest } : { project: rest.slice(0, i), name: rest.slice(i + 1) };
}

const idOf = (project: string, name: string) =>
  project === 'default' ? `incus:${name}` : `incus:${project}/${name}`;
const projectOf = (g: Json) => (typeof g.project === 'string' ? g.project : parseId(String(g.id)).project);

/** A requested size: "+8G" grows by 8 GiB, "40GiB" is the new total (binary units; kB … decimal). */
function parseSize(s: unknown): { bytes: number; relative: boolean } | null {
  if (typeof s !== 'string') return null;
  const m = SIZE_RE.exec(s.trim());
  if (!m || (m[3] === '' && m[4] === 'iB')) return null;
  const exp = m[3] ? 'KMGTP'.indexOf((m[3] as string).toUpperCase()) + 1 : 0;
  const bytes = Number(m[2]) * (m[4] === 'B' ? 1000 : 1024) ** exp;
  return bytes >= 1 ? { bytes: Math.round(bytes), relative: m[1] === '+' } : null;
}

/** A size the way Incus writes it ("48GiB"). */
function sizeString(n: number): string {
  if (n % GiB === 0) return `${n / GiB}GiB`;
  if (n % 1024 ** 2 === 0) return `${n / 1024 ** 2}MiB`;
  return `${n}B`;
}

/** A device as the configuration shows it: `type=disk,path=/,pool=default` (type first, the rest sorted). */
function deviceString(dev: Device): string {
  const keys = Object.keys(dev)
    .filter((k) => k !== 'type')
    .sort();
  return [...('type' in dev ? ['type'] : []), ...keys].map((k) => `${k}=${dev[k]}`).join(',');
}

function parseDevice(s: string): Device | null {
  const dev: Device = {};
  let last = '';
  for (const item of s.split(',')) {
    const at = item.indexOf('=');
    if (at < 0) {
      if (!last || !item) return null;
      dev[last] += `,${item}`;
      continue;
    }
    last = item.slice(0, at);
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(last) || last in dev) return null;
    dev[last] = item.slice(at + 1);
  }
  return dev;
}

function keyAllowed(key: string, kind: Kind): boolean {
  const rule = KEYS[key];
  if (rule) return !rule.containers || kind !== 'vm';
  return USER_KEY.test(key);
}

/** A device Whombat shows but never changes (GPUs, USB, host paths, options outside the allowlist). */
function restrictedDevice(dev: Device): boolean {
  if (dev.type === 'nic')
    return (
      Object.keys(dev).some((k) => !NIC_KEYS.has(k)) ||
      !(
        (dev.network && !dev.nictype && !dev.parent) ||
        (!dev.network && dev.nictype === 'bridged' && dev.parent)
      )
    );
  if (dev.type === 'disk') return Object.keys(dev).some((k) => !DISK_KEYS.has(k)) || !dev.pool;
  return true;
}

const mac = () => `10:66:6a:${randomBytes(3).toString('hex').match(/../g)?.join(':')}`;
const fingerprint = () => createHash('sha256').update(randomBytes(16)).digest('hex');

export class FakeIncus {
  readonly #instances = new Map<string, InstanceState>();
  readonly #profiles = new Map<string, ProfileState>();
  readonly #backups = new Map<string, Json[]>();
  readonly #seeded = new Set<string>();

  constructor(
    readonly host: ManageHost,
    readonly manage: FakeManage,
  ) {}

  /** The fixture world's Incus state (after the fake filled in its data). */
  init(): void {
    for (const server of ['basalt']) {
      const incus = this.#detail(server);
      if (!incus) continue;
      for (const [key, p] of Object.entries(PROFILES)) {
        const [project, name] = key.split('/') as [string, string];
        if (this.#list(server, 'profiles').some((x) => x.project === project && x.name === name))
          this.#profiles.set(this.#profileKey(server, project, name), {
            config: { ...p.config },
            devices: structuredClone(p.devices),
            digest: 1,
          });
      }
      for (const kind of ['projects', 'pools', 'networks', 'profiles', 'volumes'] as const)
        for (const e of this.#list(server, kind)) this.#liven(server, kind, e);
      for (const g of this.#guests(server)) {
        const name = String(g.name);
        const seed = SEED[name];
        this.#seed(server, g, seed?.config, {
          profiles: [...(seed?.profiles ?? ['default'])],
          devices: structuredClone(seed?.devices ?? {}),
        });
        this.#backups.set(
          this.#key(server, String(g.id)),
          (BACKUPS[name] ?? []).map(([volume, created, size, format, expires]) =>
            this.#backupJson(volume, created, size, format, expires),
          ),
        );
        const snaps = Number(g.snapshots ?? 0);
        const key = `${server}/${g.id}`;
        if (snaps > 0 && !this.manage.snapshots.has(key))
          this.manage.snapshots.set(
            key,
            Array.from({ length: snaps }, (_, i) => ({
              Name: `snap${i}`,
              Created: iso(Date.parse(this.host.asOf()) - (snaps - i) * DAY),
              Description: '',
            })),
          );
      }
      this.manage.pastTask(server, 'backup.create', 'Backing up instance', 'incus:nixbuild', 'incus', 'ok');
      this.manage.pastTask(
        server,
        'snapshot_create',
        'Snapshotting instance',
        'incus:ci-runner',
        'incus',
        'error',
        'Create instance snapshot: Failed to run: zfs snapshot default/virtual-machines/ci-runner@snap2: dataset is busy',
      );
      this.#hints(server);
    }
  }

  routes(): { method: string; path: string; handler: FakeHandler }[] {
    const S = '/api/v1/servers/*';
    const G = `${S}/guests/*`;
    const s = (p: string[]) => p[0] as string;
    const g = (p: string[]) => p[1] as string;
    const n = (p: string[], i: number) => p[i] as string;
    return [
      // Instances (shared routes answer only for Incus guests and servers).
      { method: 'POST', path: `${S}/guests`, handler: (r, p) => this.#create(r, s(p)) },
      { method: 'GET', path: `${G}/config`, handler: (r, p) => this.#getConfig(r, s(p), g(p)) },
      { method: 'PUT', path: `${G}/config`, handler: (r, p) => this.#setConfig(r, s(p), g(p)) },
      {
        method: 'POST',
        path: `${G}/disks/*/resize`,
        handler: (r, p) => this.#resize(r, s(p), g(p), n(p, 2)),
      },
      { method: 'POST', path: `${G}/clone`, handler: (r, p) => this.#clone(r, s(p), g(p)) },
      { method: 'POST', path: `${G}/rename`, handler: (r, p) => this.#rename(r, s(p), g(p)) },
      { method: 'POST', path: `${G}/move`, handler: (r, p) => this.#move(r, s(p), g(p)) },
      { method: 'POST', path: `${G}/publish`, handler: (r, p) => this.#publish(r, s(p), g(p)) },
      { method: 'GET', path: `${G}/log`, handler: (r, p) => this.#log(r, s(p), g(p)) },
      { method: 'GET', path: `${G}/backups`, handler: (r, p) => this.#listBackups(r, s(p), g(p)) },
      { method: 'POST', path: `${G}/backups`, handler: (r, p) => this.#backup(r, s(p), g(p)) },
      { method: 'POST', path: `${S}/backups/restore`, handler: (r, p) => this.#restore(r, s(p)) },
      { method: 'DELETE', path: `${S}/backups`, handler: (r, p) => this.#deleteBackup(r, s(p)) },
      { method: 'GET', path: `${S}/manage/choices`, handler: (r, p) => this.#choices(r, s(p)) },
      // The Proxmox side's routes refuse the guest this Whombat runs in here, and leave the rest to it.
      { method: 'DELETE', path: G, handler: this.#selfRefused('admin') },
      { method: 'POST', path: `${G}/template`, handler: this.#selfRefused('admin') },
      { method: 'POST', path: `${G}/migrate`, handler: this.#selfRefused('admin') },
      { method: 'POST', path: `${G}/disks/*/move`, handler: this.#selfRefused('operator') },
      { method: 'PUT', path: `${G}/autostart`, handler: this.#selfRefused('operator') },
      // The host's Incus.
      { method: 'GET', path: `${S}/incus/profiles/*`, handler: (r, p) => this.#getProfile(r, s(p), g(p)) },
      { method: 'POST', path: `${S}/incus/profiles`, handler: (r, p) => this.#createProfile(r, s(p)) },
      { method: 'PUT', path: `${S}/incus/profiles/*`, handler: (r, p) => this.#updateProfile(r, s(p), g(p)) },
      {
        method: 'DELETE',
        path: `${S}/incus/profiles/*`,
        handler: (r, p) => this.#deleteProfile(r, s(p), g(p)),
      },
      { method: 'GET', path: `${S}/incus/networks/*/leases`, handler: (r, p) => this.#leases(r, s(p), g(p)) },
      { method: 'POST', path: `${S}/incus/images`, handler: (r, p) => this.#downloadImage(r, s(p)) },
      {
        method: 'POST',
        path: `${S}/incus/images/*/refresh`,
        handler: (r, p) => this.#refreshImage(r, s(p), g(p)),
      },
      { method: 'DELETE', path: `${S}/incus/images/*`, handler: (r, p) => this.#deleteImage(r, s(p), g(p)) },
      {
        method: 'POST',
        path: `${S}/incus/pools/*/volumes`,
        handler: (r, p) => this.#createVolume(r, s(p), g(p)),
      },
      {
        method: 'POST',
        path: `${S}/incus/pools/*/volumes/*/resize`,
        handler: (r, p) => this.#resizeVolume(r, s(p), g(p), n(p, 2)),
      },
      {
        method: 'DELETE',
        path: `${S}/incus/pools/*/volumes/*`,
        handler: (r, p) => this.#deleteVolume(r, s(p), g(p), n(p, 2)),
      },
    ];
  }

  /* State ----------------------------------------------------------------------------------------------------------- */

  #detail(server: string): Json | null {
    const incus = this.host.detailOf(server)?.incus;
    return incus && typeof incus === 'object' && !Array.isArray(incus) ? (incus as Json) : null;
  }

  #list(server: string, key: string): Json[] {
    const incus = this.#detail(server);
    if (!incus) return [];
    if (!Array.isArray(incus[key])) incus[key] = [];
    return incus[key] as Json[];
  }

  #guests(server: string): Json[] {
    return this.host.guestsOf(server).filter((g) => g.platform === 'incus');
  }

  #key(server: string, guestId: string): string {
    return `${server}/${guestId}`;
  }

  #profileKey(server: string, project: string, name: string): string {
    return `${server}/${project}/${name}`;
  }

  /** The counts that follow from the instances, read whenever the detail is. */
  #liven(server: string, kind: 'projects' | 'pools' | 'networks' | 'profiles' | 'volumes', e: Json): void {
    const live = (key: string, get: () => unknown) =>
      Object.defineProperty(e, key, { get, enumerable: true, configurable: true });
    const inProject = () => this.#guests(server).filter((g) => projectOf(g) === e.name);
    if (kind === 'projects') {
      live('instances', () => inProject().length);
      live('running', () => inProject().filter((g) => g.state === 'running').length);
    } else if (kind === 'pools') {
      live('volumes', () => this.#list(server, 'volumes').filter((v) => v.pool === e.name).length);
    } else if (kind === 'networks') {
      live('used_by', () => this.#networkUsers(server, String(e.name)));
    } else if (kind === 'profiles') {
      live('used_by', () => this.#profileUsers(server, String(e.project), String(e.name)).length);
    } else {
      live('used_by', () => this.#volumeUsers(server, e));
    }
  }

  /** An instance's settings: the fake's guest configuration, Incus keys put in on first use. */
  #cfg(server: string, guest: Json): GuestConfigState {
    const id = String(guest.id);
    if (!this.#seeded.has(this.#key(server, id))) this.#seed(server, guest);
    return this.host.configOf(server, id);
  }

  #inst(server: string, guest: Json): InstanceState {
    const key = this.#key(server, String(guest.id));
    if (!this.#seeded.has(key)) this.#seed(server, guest);
    return this.#instances.get(key) as InstanceState;
  }

  #seed(server: string, guest: Json, config?: Record<string, string>, inst?: InstanceState): void {
    const id = String(guest.id);
    const c = this.host.configOf(server, id);
    const mb = Number(guest.memory_limit_mb);
    c.values = config
      ? { ...config }
      : {
          'limits.cpu': String(guest.vcpu ?? 1),
          ...(mb > 0 ? { 'limits.memory': mb % 1024 === 0 ? `${mb / 1024}GiB` : `${mb}MiB` } : {}),
          'boot.autostart': 'true',
        };
    c.running = guest.state === 'running';
    this.#instances.set(this.#key(server, id), inst ?? { profiles: ['default'], devices: {} });
    this.#seeded.add(this.#key(server, id));
  }

  #profileState(server: string, project: string, name: string): ProfileState | null {
    return this.#profiles.get(this.#profileKey(server, project, name)) ?? null;
  }

  /** An instance's settings and devices with its profiles' underneath. */
  #expanded(server: string, guest: Json) {
    const inst = this.#inst(server, guest);
    const own = this.#cfg(server, guest).values;
    const profileConfig: Record<string, string> = {};
    const profileDevices: Devices = {};
    for (const name of inst.profiles) {
      const p = this.#profileState(server, projectOf(guest), name);
      if (!p) continue;
      Object.assign(profileConfig, p.config);
      Object.assign(profileDevices, p.devices);
    }
    return {
      config: { ...profileConfig, ...own },
      devices: { ...profileDevices, ...inst.devices },
      profileConfig,
      profileDevices,
      own,
      inst,
    };
  }

  /** Every setting as `config.get` shows it: the settings, then `device.<name>`. */
  #values(server: string, guest: Json): Record<string, string> {
    const x = this.#expanded(server, guest);
    return {
      ...x.config,
      ...Object.fromEntries(
        Object.entries(x.devices).map(([name, d]) => [`device.${name}`, deviceString(d)]),
      ),
    };
  }

  #profileUsers(server: string, project: string, name: string): string[] {
    return this.#guests(server)
      .filter((g) => projectOf(g) === project && this.#inst(server, g).profiles.includes(name))
      .map((g) => String(g.id));
  }

  #networkUsers(server: string, network: string): number {
    const uses = (d: Device) => d.type === 'nic' && (d.network === network || d.parent === network);
    const profiles = [...this.#profiles.entries()].filter(
      ([k, p]) => k.startsWith(`${server}/`) && Object.values(p.devices).some(uses),
    ).length;
    const guests = this.#guests(server).filter((g) =>
      Object.values(this.#expanded(server, g).devices).some(uses),
    ).length;
    return profiles + guests;
  }

  #volumeUsers(server: string, v: Json): string[] {
    return this.#guests(server)
      .filter(
        (g) =>
          projectOf(g) === v.project &&
          Object.values(this.#expanded(server, g).devices).some(
            (d) => d.type === 'disk' && d.pool === v.pool && d.source === v.name,
          ),
      )
      .map((g) => String(g.id));
  }

  /** The “no snapshots” hint (IU-08): running instances without a snapshot schedule and no backup in 30 days. */
  #hints(server: string): void {
    if (!this.#detail(server)) return;
    const since = Date.parse(this.host.asOf()) - 30 * DAY;
    const bare = this.#guests(server).filter((g) => {
      if (g.state !== 'running') return false;
      const schedule = this.#expanded(server, g).config['snapshots.schedule'] ?? '';
      if (schedule && schedule !== '@never') return false;
      return !(this.#backups.get(this.#key(server, String(g.id))) ?? []).some(
        (b) => Date.parse(String(b.created)) >= since,
      );
    });
    const names = bare.map((g) => String(g.name));
    this.host.setHint(
      server,
      'incus.no_snapshots',
      bare.length
        ? {
            server,
            kind: 'incus.no_snapshots',
            severity: 'info',
            entity: bare.length === 1 ? String(bare[0]?.id) : 'incus',
            title:
              bare.length === 1
                ? 'An instance without snapshots'
                : `${bare.length} instances without snapshots`,
            detail: names.length > 5 ? `${names.slice(0, 5).join(', ')}, …` : names.join(', '),
            link: '#guests',
          }
        : null,
    );
  }

  #backupJson(volume: string, created: string, size: number, format: string, expires: string | null): Json {
    return {
      volume,
      storage: 'incus',
      created,
      size_bytes: size,
      notes: expires ? `expires ${expires}` : '',
      format,
      expires_at: expires,
    };
  }

  #newGuest(o: {
    id: string;
    kind: string;
    image: string;
    state: string;
    vcpu: number;
    memoryMb: number | null;
  }): Json {
    const { project, name } = parseId(o.id);
    const running = o.state === 'running';
    return {
      id: o.id,
      name,
      platform: 'incus',
      kind: o.kind,
      image: o.image,
      state: o.state,
      project,
      macs: [mac()],
      vcpu: o.vcpu,
      cpu_pct: running ? 0.5 : null,
      memory_used_mb: running ? 180 : null,
      memory_limit_mb: o.memoryMb,
      disk_read_mbs: running ? 0 : null,
      disk_write_mbs: running ? 0 : null,
      net_rx_mbps: running ? 0 : null,
      net_tx_mbps: running ? 0 : null,
      snapshots: 0,
      uptime_s: running ? 1 : null,
      console:
        o.kind === 'vm'
          ? {
              available: true,
              protocols: ['spice', 'serial'],
              default_protocol: 'spice',
              resolution: running ? '1280x800' : null,
            }
          : {
              available: true,
              protocols: ['shell', 'tty'],
              default_protocol: 'shell',
              resolution: running ? '132x36' : null,
            },
    };
  }

  /** Puts a new instance in the detail with its settings, profiles and devices. */
  #addInstance(server: string, guest: Json, values: Record<string, string>, inst: InstanceState): void {
    this.host.addGuest(server, guest);
    this.#seed(server, guest, values, inst);
    this.#counts(server);
    this.host.emit('guest.state_changed', { server, id: guest.id, state: guest.state });
    this.#hints(server);
  }

  /** Gives an instance a new id (rename, move to another project), keeping its settings, snapshots and backups. */
  #reid(server: string, oldId: string, newId: string, name: string, project: string): void {
    const g = this.host.guest(server, oldId);
    if (!g) return;
    const c = this.#cfg(server, g);
    const values = { ...c.values };
    const digest = c.digest;
    const inst = this.#inst(server, g);
    const [oldKey, newKey] = [this.#key(server, oldId), this.#key(server, newId)];
    const snaps = this.manage.snapshots.get(oldKey);
    const backups = this.#backups.get(oldKey);
    this.host.removeGuest(server, oldId);
    for (const m of [this.manage.snapshots, this.#backups, this.#instances]) m.delete(oldKey);
    this.#seeded.delete(oldKey);
    Object.assign(g, { id: newId, name, project });
    this.host.addGuest(server, g);
    this.#seed(server, g, values, inst);
    this.host.configOf(server, newId).digest = digest + 1;
    if (snaps) this.manage.snapshots.set(newKey, snaps);
    if (backups) this.#backups.set(newKey, backups);
    this.host.emit('guest.state_changed', { server, id: newId, state: g.state });
    this.#hints(server);
  }

  /** The detail's Incus workload counts. */
  #counts(server: string): void {
    const group = (this.host.detailOf(server)?.workloads as Record<string, Json> | undefined)?.incus;
    if (!group) return;
    const guests = this.#guests(server);
    group.total = guests.length;
    group.running = guests.filter((g) => g.state === 'running').length;
  }

  /* Checks ---------------------------------------------------------------------------------------------------------- */

  /** A shared guest route: the guest when it is an Incus guest of a server with Incus (else null: not ours). */
  #shared(r: FakeRequest, server: string, guestId: string, role: Role): { guest: Json } | FakeAnswer | null {
    const guest = this.host.guest(server, guestId);
    if (guest?.platform !== 'incus' || !this.#detail(server)) return null;
    return this.manage.check(r, server, role) ?? { guest };
  }

  /** A route only Incus has: checks, then the guest (404 when missing, 501 for other platforms). */
  #own(
    r: FakeRequest,
    server: string,
    guestId: string,
    role: Role,
    refusal: string,
  ): { guest: Json } | FakeAnswer | null {
    // A libvirt VM's rename and log are the libvirt side's (QEMU/KVM, 0.84): pass them on.
    if (this.host.guest(server, guestId)?.platform === 'libvirt') return null;
    const refused = this.manage.check(r, server, role);
    if (refused) return refused;
    const guest = this.host.guest(server, guestId);
    if (!guest) return problem(404, 'guest_not_found', 'No such guest.');
    if (guest.platform !== 'incus' || !this.#detail(server)) return problem(501, 'unsupported', refusal);
    return { guest };
  }

  /** A host route of the server's Incus. */
  #hostRoute(r: FakeRequest, server: string, role: Role): FakeAnswer | null {
    const refused = this.manage.check(r, server, role);
    if (refused) return refused;
    return this.#detail(server) ? null : problem(501, 'unsupported', 'This server doesn’t run Incus.');
  }

  /** Whether a host route with a `platform` is about this server's Incus. */
  #mine(server: string, platform: unknown): boolean {
    return platform === 'incus' || (platform === undefined && this.#detail(server) !== null);
  }

  #selfRefused(role: Role): FakeHandler {
    return (r, p) => {
      const guest = this.host.guest(p[0] as string, p[1] as string);
      if (guest?.platform !== 'incus' || guest.self !== true) return null;
      return this.manage.check(r, p[0] as string, role) ?? problem(409, 'self_guest', SELF);
    };
  }

  #fields(r: FakeRequest, allowed: readonly string[]): Json | FakeAnswer {
    const bc = this.manage.body(r, allowed);
    return 'fields' in bc ? bc.fields : bc;
  }

  /** A DELETE route's query: only the keys it takes. */
  #query(r: FakeRequest, allowed: readonly string[]): FakeAnswer | null {
    for (const k of r.query.keys())
      if (!allowed.includes(k)) return problem(400, 'bad_request', `Unknown query parameter "${k}"`);
    return null;
  }

  #confirmed(r: FakeRequest): boolean {
    return r.query.get('confirm') === '1' || r.query.get('confirm') === 'true';
  }

  #project(server: string, raw: unknown): string | FakeAnswer {
    if (raw === undefined || raw === null || raw === '') return 'default';
    if (typeof raw !== 'string' || !this.#list(server, 'projects').some((p) => p.name === raw))
      return this.manage.invalid({ project: 'No such Incus project.' });
    return raw;
  }

  #bools(b: Json, names: string[]): FakeAnswer | null {
    for (const n of names)
      if (b[n] !== undefined && typeof b[n] !== 'boolean')
        return this.manage.invalid({ [n]: 'true or false.' });
    return null;
  }

  #notAllowed(field: string, message: string): FakeAnswer {
    return problem(403, 'not_allowed', message, { field_errors: { [field]: message } });
  }

  /** `set` and `delete` against the allowlist; `device.<name>` keys come back as device changes. */
  #checkKeys(
    set: unknown,
    del: unknown,
    kind: Kind,
  ): { set: Record<string, string>; del: string[]; devices: Record<string, Device | null> } | FakeAnswer {
    const out = {
      set: {} as Record<string, string>,
      del: [] as string[],
      devices: {} as Record<string, Device | null>,
    };
    if (set !== undefined && (!set || typeof set !== 'object' || Array.isArray(set)))
      return this.manage.invalid({ set: 'An object of settings.' });
    for (const [key, value] of Object.entries((set ?? {}) as Json)) {
      if (typeof value !== 'string') return this.manage.invalid({ [key]: 'Settings are text.' });
      if (key.startsWith('device.')) {
        const dev = parseDevice(value);
        if (!dev) return this.manage.invalid({ [key]: 'A device like type=nic,network=incusbr0.' });
        out.devices[key.slice(7)] = dev;
        continue;
      }
      if (!keyAllowed(key, kind)) return this.#notAllowed(key, `${key} isn’t changed through Whombat.`);
      const rule = KEYS[key];
      if (rule && !rule.re.test(value)) return this.manage.invalid({ [key]: rule.hint });
      if (!rule && (value.length > 4096 || controlled(value)))
        return this.manage.invalid({ [key]: 'Text of at most 4096 characters.' });
      out.set[key] = value;
    }
    if (del !== undefined && (!Array.isArray(del) || del.some((k) => typeof k !== 'string')))
      return this.manage.invalid({ delete: 'A list of settings.' });
    for (const key of (del ?? []) as string[]) {
      if (key.startsWith('device.')) out.devices[key.slice(7)] = null;
      else if (!keyAllowed(key, kind)) return this.#notAllowed(key, `${key} isn’t changed through Whombat.`);
      else out.del.push(key);
    }
    return out;
  }

  /** One device of a `devices` change (MANAGE.md §2.5): NICs on an Incus network or host bridge, pool disks. */
  #checkDevice(server: string, project: string, kind: Kind, name: string, raw: unknown): FakeAnswer | null {
    const field = `devices.${name}`;
    const invalid = (m: string) => this.manage.invalid({ [field]: m });
    if (!DEVICE_RE.test(name)) return invalid('Not a device name.');
    if (!strings(raw))
      return invalid('A device is an object of text options, like {"type": "nic", "network": "incusbr0"}.');
    const dev = raw;
    const networks = this.#list(server, 'networks');
    if (dev.type === 'nic') {
      const bad = Object.keys(dev).find((k) => !NIC_KEYS.has(k));
      if (bad) return this.#notAllowed(field, `The option ${bad} isn’t changed through Whombat.`);
      if (dev.network && !dev.nictype && !dev.parent)
        return networks.some((x) => x.name === dev.network && x.managed === true)
          ? null
          : invalid(`No Incus network “${dev.network}”.`);
      if (!dev.network && dev.nictype === 'bridged' && dev.parent)
        return networks.some((x) => x.name === dev.parent && x.type === 'bridge')
          ? null
          : invalid(`No host bridge “${dev.parent}”.`);
      return this.#notAllowed(
        field,
        'Only network cards on an Incus network or a host bridge are changed through Whombat.',
      );
    }
    if (dev.type === 'disk') {
      const bad = Object.keys(dev).find((k) => !DISK_KEYS.has(k));
      if (bad) return this.#notAllowed(field, `The option ${bad} isn’t changed through Whombat.`);
      if (!dev.pool || dev.source?.startsWith('/'))
        return this.#notAllowed(
          field,
          'Host folders can’t be attached here, only volumes of a storage pool.',
        );
      if (!this.#list(server, 'pools').some((p) => p.name === dev.pool))
        return invalid(`No storage pool “${dev.pool}”.`);
      if (dev.size !== undefined && !parseSize(dev.size)) return invalid('A size such as 20GiB.');
      if (dev.source === undefined)
        return dev.path === '/'
          ? null
          : invalid('A disk without a volume is the root disk: its path is “/”.');
      if (!VOLUME_RE.test(dev.source))
        return this.#notAllowed(field, 'The source of a disk must be a custom volume of its pool.');
      const v = this.#list(server, 'volumes').find(
        (x) => x.pool === dev.pool && x.name === dev.source && x.project === project,
      );
      if (!v) return invalid(`No volume “${dev.source}” on the pool ${dev.pool}.`);
      if (v.content_type === 'block' && kind === 'container')
        return invalid('A block volume can only be attached to a virtual machine.');
      if (v.content_type !== 'block' && !dev.path) return invalid('Where should it be mounted? Give a path.');
      return null;
    }
    if (!dev.type) return invalid('A device needs a type.');
    return this.#notAllowed(field, `${dev.type} devices aren’t changed through Whombat.`);
  }

  /** Checks a set of device changes against what is there; null when they may be applied. */
  #checkDevices(
    server: string,
    project: string,
    kind: Kind,
    changes: Record<string, Device | null>,
    own: Devices,
    inherited: Devices,
  ): FakeAnswer | null {
    for (const [name, dev] of Object.entries(changes)) {
      const field = `devices.${name}`;
      if (own[name] && restrictedDevice(own[name] as Device))
        return this.#notAllowed(field, `The device ${name} isn’t changed through Whombat.`);
      if (dev === null) {
        if (own[name]) continue;
        return this.manage.invalid({
          [field]: inherited[name]
            ? 'That device comes from a profile: change the profile instead.'
            : 'No such device.',
        });
      }
      const refused = this.#checkDevice(server, project, kind, name, dev);
      if (refused) return refused;
    }
    return null;
  }

  #checkProfiles(server: string, project: string, raw: unknown): FakeAnswer | null {
    if (raw === undefined) return null;
    if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string'))
      return this.manage.invalid({ profiles: 'A list of profile names.' });
    const missing = (raw as string[]).find((p) => !this.#profileState(server, project, p));
    return missing
      ? this.manage.invalid({ profiles: `No profile “${missing}” in the project ${project}.` })
      : null;
  }

  /** The changed keys between two `#values` maps. */
  #diff(before: Record<string, string>, after: Record<string, string>): Json[] {
    const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])];
    return keys
      .filter((k) => before[k] !== after[k])
      .map((k) => ({ key: k, old: before[k] ?? null, new: after[k] ?? null, pending: false }));
  }

  /** A local image for a reference (fingerprint or its first 12+ characters, or an alias) in a project. */
  #image(server: string, ref: string, project: string, type?: string): Json | null {
    const images = this.#list(server, 'images').filter(
      (i) => i.project === project || (project !== 'default' && i.project === 'default'),
    );
    const byFp = images.find(
      (i) =>
        i.fingerprint === ref || (/^[0-9a-f]{12,64}$/.test(ref) && String(i.fingerprint).startsWith(ref)),
    );
    if (byFp) return byFp;
    return images.find((i) => (i.aliases as string[]).includes(ref) && (!type || i.type === type)) ?? null;
  }

  /** A local image by its fingerprint (or its first 12+ characters) in a project. */
  #imageByFp(server: string, ref: string, project: string): Json | null {
    if (!/^[0-9a-f]{12,64}$/.test(ref)) return null;
    return (
      this.#list(server, 'images').find(
        (i) => i.project === project && String(i.fingerprint).startsWith(ref),
      ) ?? null
    );
  }

  #imageUsers(server: string, img: Json): Json[] {
    return this.#guests(server).filter(
      (g) =>
        (img.aliases as string[]).includes(String(g.image)) &&
        (g.kind === 'vm') === (img.type === 'virtual-machine') &&
        projectOf(g) === img.project,
    );
  }

  /* Instances ------------------------------------------------------------------------------------------------------- */

  #create(r: FakeRequest, server: string): FakeAnswer | null {
    const raw = (r.body && typeof r.body === 'object' ? r.body : {}) as Json;
    if (!this.#mine(server, raw.platform)) return null;
    const refused = this.#hostRoute(r, server, 'admin');
    if (refused) return refused;
    const b = this.#fields(r, [
      'platform',
      'kind',
      'new_id',
      'name',
      'set',
      'start',
      'image',
      'profiles',
      'project',
      'pool',
      'network',
      'cloud_init',
    ]);
    if (isAnswer(b)) return b;
    const invalid = (f: Record<string, string>) => this.manage.invalid(f);
    if (b.kind !== 'vm' && b.kind !== 'container') return invalid({ kind: 'vm or container.' });
    const kind = b.kind;
    if (typeof b.name !== 'string' || !INSTANCE_RE.test(b.name))
      return invalid({ name: 'Letters, digits and dashes, starting with a letter (at most 63).' });
    const project = this.#project(server, b.project);
    if (isAnswer(project)) return project;
    if (typeof b.image !== 'string' || !b.image) return invalid({ image: 'An image is needed.' });
    const ref = b.image.startsWith('images:') ? b.image.slice(7) : b.image;
    const type = kind === 'vm' ? 'virtual-machine' : 'container';
    const local = this.#image(server, ref, project, type);
    if (local && local.type !== type)
      return invalid({ image: `This image is for a ${String(local.type).replace('-', ' ')}.` });
    if (!local && !ALIAS_RE.test(ref))
      return invalid({ image: 'An image alias such as debian/13, or a fingerprint.' });
    const keys = this.#checkKeys(b.set, undefined, kind);
    if (isAnswer(keys)) return keys;
    const profileRefused = this.#checkProfiles(server, project, b.profiles);
    if (profileRefused) return profileRefused;
    if (b.pool !== undefined && !this.#list(server, 'pools').some((p) => p.name === b.pool))
      return invalid({ pool: 'No such storage pool.' });
    const network = this.#list(server, 'networks').find((x) => x.name === b.network);
    if (b.network !== undefined && (!network || (network.managed !== true && network.type !== 'bridge')))
      return invalid({ network: 'No such network or bridge.' });
    if (
      b.cloud_init !== undefined &&
      (typeof b.cloud_init !== 'string' || Buffer.byteLength(b.cloud_init) > CLOUD_INIT_MAX)
    )
      return invalid({ cloud_init: 'Cloud-init user data is text of at most 64 KiB.' });
    const bad = this.#bools(b, ['start']);
    if (bad) return bad;
    const devices: Devices = {};
    for (const [name, dev] of Object.entries(keys.devices)) if (dev) devices[name] = dev;
    if (b.pool !== undefined) devices.root = { ...ROOT_DISK, ...devices.root, pool: String(b.pool) };
    if (network)
      devices.eth0 =
        network.managed === true
          ? { type: 'nic', name: 'eth0', network: String(network.name) }
          : { type: 'nic', name: 'eth0', nictype: 'bridged', parent: String(network.name) };
    const devRefused = this.#checkDevices(server, project, kind, keys.devices, {}, {});
    if (devRefused) return devRefused;
    const id = idOf(project, b.name);
    if (this.host.guest(server, id)) return problem(409, 'exists', `${id} already exists.`);
    const alias = local
      ? String((local.aliases as string[])[0] ?? String(local.fingerprint).slice(0, 12))
      : ref;
    const start = b.start === true;
    const values: Record<string, string> = {
      ...keys.set,
      ...(typeof b.cloud_init === 'string' ? { 'cloud-init.user-data': b.cloud_init } : {}),
    };
    const memory = parseSize(values['limits.memory']);
    return this.#task(r, server, 'guest.create', {
      type: 'Creating instance',
      guest: id,
      cancellable: true,
      answer: { new_id: id },
      plan: [
        'Creating instance',
        ...(local
          ? []
          : [
              'Retrieving image: 12% (18.40MB/s)',
              'Retrieving image: 54% (21.92MB/s)',
              'Retrieving image: 100% (22.31MB/s)',
            ]),
        'Unpacking image: 100%',
        `Instance ${b.name} created`,
        ...(start ? ['Starting instance'] : []),
      ],
      apply: (good) => {
        if (!good) return;
        if (!local)
          this.#list(server, 'images').push({
            fingerprint: fingerprint(),
            aliases: [ref],
            description: `${String(REMOTE_IMAGES.find((i) => i.alias === ref)?.description ?? ref)} amd64`,
            type,
            architecture: 'x86_64',
            size_bytes: kind === 'vm' ? 312_475_648 : 104_857_600,
            uploaded_at: iso(Date.now()),
            last_used_at: iso(Date.now()),
            auto_update: true,
            cached: true,
            project,
          });
        else local.last_used_at = iso(Date.now());
        const guest = this.#newGuest({
          id,
          kind,
          image: alias,
          state: start ? 'running' : 'stopped',
          vcpu: Number(values['limits.cpu']) || (kind === 'vm' ? 1 : 2),
          memoryMb: memory ? Math.round(memory.bytes / 1024 ** 2) : kind === 'vm' ? 1024 : null,
        });
        const profiles = (b.profiles as string[] | undefined) ?? ['default'];
        this.#addInstance(server, guest, values, { profiles: [...profiles], devices });
      },
    });
  }

  #getConfig(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#shared(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest } = gc;
    const kind = guest.kind === 'vm' ? 'vm' : 'container';
    const x = this.#expanded(server, guest);
    const values = this.#values(server, guest);
    const inherited = [
      ...Object.keys(x.profileConfig).filter((k) => !(k in x.own)),
      ...Object.keys(x.profileDevices)
        .filter((n) => !(n in x.inst.devices))
        .map((n) => `device.${n}`),
    ];
    const restricted = [
      ...Object.keys(x.config).filter((k) => !keyAllowed(k, kind) && !k.startsWith('image.')),
      ...Object.entries(x.devices)
        .filter(([, d]) => restrictedDevice(d))
        .map(([n]) => `device.${n}`),
    ];
    const disks = Object.entries(x.devices)
      .filter(([, d]) => d.type === 'disk' && d.pool)
      .map(([key, d]) => {
        const size = parseSize(d.size);
        return {
          key,
          storage: d.pool,
          ...(d.source ? { volume: d.source } : {}),
          ...(size ? { size_bytes: size.bytes } : {}),
          media: 'disk',
          ...(d.path && d.path !== '/' ? { path: d.path } : {}),
          ...(d.path === '/' ? { boot: true } : {}),
        };
      });
    return ok({
      platform: 'incus',
      kind,
      digest: `d${this.#cfg(server, guest).digest}`,
      running: guest.state === 'running',
      values,
      pending: {},
      restricted,
      inherited,
      profiles: [...x.inst.profiles],
      disks,
    });
  }

  #setConfig(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#shared(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest } = gc;
    if (guest.self === true) return problem(409, 'self_guest', SELF);
    const b = this.#fields(r, ['digest', 'set', 'delete', 'revert', 'confirm', 'devices', 'profiles']);
    if (isAnswer(b)) return b;
    const c = this.#cfg(server, guest);
    if (b.digest !== undefined && b.digest !== `d${c.digest}`)
      return problem(409, 'digest_mismatch', 'The configuration changed meanwhile.');
    if (b.revert !== undefined && (!Array.isArray(b.revert) || b.revert.length > 0))
      return this.manage.invalid({ revert: 'Incus applies changes at once: there is nothing to revert.' });
    const kind = guest.kind === 'vm' ? 'vm' : 'container';
    const keys = this.#checkKeys(b.set, b.delete, kind);
    if (isAnswer(keys)) return keys;
    if (b.devices !== undefined && (!b.devices || typeof b.devices !== 'object' || Array.isArray(b.devices)))
      return this.manage.invalid({ devices: 'An object of devices by name (null removes one).' });
    const devices = { ...keys.devices, ...((b.devices ?? {}) as Record<string, Device | null>) };
    const project = projectOf(guest);
    const x = this.#expanded(server, guest);
    const devRefused = this.#checkDevices(server, project, kind, devices, x.inst.devices, x.profileDevices);
    if (devRefused) return devRefused;
    const profileRefused = this.#checkProfiles(server, project, b.profiles);
    if (profileRefused) return profileRefused;
    const before = this.#values(server, guest);
    const profilesBefore = x.inst.profiles.join(',');
    Object.assign(c.values, keys.set);
    for (const k of keys.del) delete c.values[k];
    for (const [name, dev] of Object.entries(devices))
      if (dev === null) delete x.inst.devices[name];
      else x.inst.devices[name] = { ...dev };
    if (b.profiles !== undefined) x.inst.profiles = [...(b.profiles as string[])];
    const changes = this.#diff(before, this.#values(server, guest));
    if (b.profiles !== undefined && x.inst.profiles.join(',') !== profilesBefore)
      changes.push({ key: 'profiles', old: profilesBefore, new: x.inst.profiles.join(','), pending: false });
    c.digest += 1;
    this.#hints(server);
    return ok({ ok: true, changes, audit_id: audit() });
  }

  #resize(r: FakeRequest, server: string, guestId: string, disk: string): FakeAnswer | null {
    const gc = this.#shared(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest } = gc;
    if (guest.self === true) return problem(409, 'self_guest', SELF);
    const b = this.#fields(r, ['size']);
    if (isAnswer(b)) return b;
    const want = parseSize(b.size);
    if (!want) return this.manage.invalid({ size: 'A size such as +8G or 40GiB.' });
    const x = this.#expanded(server, guest);
    const dev = x.devices[disk];
    if (dev?.type !== 'disk')
      return problem(404, 'not_found', `The instance has no disk ${disk}.`, {
        field_errors: { disk: 'No such disk.' },
      });
    if (restrictedDevice(dev)) return this.#notAllowed('disk', 'This disk isn’t changed through Whombat.');
    if (dev.source)
      return this.manage.invalid({ disk: `This disk is the volume ${dev.source}: grow the volume instead.` });
    if (dev.path !== '/') return this.manage.invalid({ disk: 'Only the root disk is grown here.' });
    const cur = parseSize(dev.size)?.bytes ?? 0;
    if (!cur) return this.manage.invalid({ disk: 'This disk has no size limit: it can use the whole pool.' });
    const next = want.relative ? cur + want.bytes : want.bytes;
    if (next < cur) return this.manage.invalid({ size: `Disks only grow: this one has ${sizeString(cur)}.` });
    if (next === cur) return ok({ ok: true, changes: [], audit_id: audit() });
    const old = deviceString(dev);
    x.inst.devices[disk] = { ...dev, size: sizeString(next) };
    this.#cfg(server, guest).digest += 1;
    return ok({
      ok: true,
      changes: [
        { key: `device.${disk}`, old, new: deviceString(x.inst.devices[disk] as Device), pending: false },
      ],
      audit_id: audit(),
    });
  }

  #clone(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#shared(r, server, guestId, 'admin');
    if (!gc || isAnswer(gc)) return gc;
    const { guest } = gc;
    const b = this.#fields(r, ['new_id', 'name', 'full', 'storage', 'project', 'instance_only']);
    if (isAnswer(b)) return b;
    if (typeof b.name !== 'string' || !INSTANCE_RE.test(b.name))
      return this.manage.invalid({
        name: 'Letters, digits and dashes, starting with a letter (at most 63).',
      });
    const project = this.#project(server, b.project ?? projectOf(guest));
    if (isAnswer(project)) return project;
    if (b.storage !== undefined && !this.#list(server, 'pools').some((p) => p.name === b.storage))
      return this.manage.invalid({ storage: 'No such storage pool.' });
    const bad = this.#bools(b, ['full', 'instance_only']);
    if (bad) return bad;
    const id = idOf(project, b.name);
    if (this.host.guest(server, id)) return problem(409, 'exists', `${id} already exists.`);
    const x = this.#expanded(server, guest);
    const values = { ...x.own };
    const devices = structuredClone(x.inst.devices);
    if (b.storage !== undefined)
      devices.root = { ...ROOT_DISK, ...(x.devices.root ?? {}), pool: String(b.storage) };
    const profiles = x.inst.profiles.filter((p) => this.#profileState(server, project, p));
    const snaps = this.manage.snapshots.get(this.#key(server, guestId));
    return this.#task(r, server, 'guest.clone', {
      type: 'Creating instance',
      guest: guestId,
      answer: { new_id: id },
      plan: [
        'Creating instance',
        'Transferring instance: root: 1.21GB (402.10MB/s)',
        `Instance ${b.name} copied`,
      ],
      apply: (good) => {
        if (!good) return;
        const copy = this.#newGuest({
          id,
          kind: String(guest.kind),
          image: String(guest.image),
          state: 'stopped',
          vcpu: Number(guest.vcpu ?? 1),
          memoryMb: (guest.memory_limit_mb as number | null) ?? null,
        });
        if (snaps?.length && b.instance_only !== true) {
          this.manage.snapshots.set(this.#key(server, id), structuredClone(snaps));
          copy.snapshots = snaps.length;
        }
        this.#addInstance(server, copy, values, {
          profiles: profiles.length ? profiles : ['default'],
          devices,
        });
      },
    });
  }

  #rename(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#own(r, server, guestId, 'admin', 'Only Incus instances are renamed here.');
    if (gc === null) return null;
    if (isAnswer(gc)) return gc;
    const { guest } = gc;
    if (guest.self === true) return problem(409, 'self_guest', SELF);
    const b = this.#fields(r, ['name']);
    if (isAnswer(b)) return b;
    if (typeof b.name !== 'string' || !INSTANCE_RE.test(b.name))
      return this.manage.invalid({
        name: 'Letters, digits and dashes, starting with a letter (at most 63).',
      });
    if (guest.state !== 'stopped')
      return problem(409, 'guest_running', 'The instance has to be stopped first.');
    const project = projectOf(guest);
    const id = idOf(project, b.name);
    if (id === guestId) return this.manage.invalid({ name: 'That’s its name already.' });
    if (this.host.guest(server, id)) return problem(409, 'exists', `${id} already exists.`);
    const name = b.name;
    return this.#task(r, server, 'guest.rename', {
      type: 'Renaming instance',
      guest: guestId,
      answer: { new_id: id },
      plan: ['Renaming instance', `Instance renamed to ${name}`],
      apply: (good) => good && this.#reid(server, guestId, id, name, project),
    });
  }

  #move(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#own(r, server, guestId, 'admin', 'Only Incus instances are moved here.');
    if (gc === null) return null;
    if (isAnswer(gc)) return gc;
    const { guest } = gc;
    if (guest.self === true) return problem(409, 'self_guest', SELF);
    const b = this.#fields(r, ['pool', 'project', 'confirm']);
    if (isAnswer(b)) return b;
    if (b.confirm !== true)
      return problem(
        400,
        'confirm_required',
        'Moving an instance needs a confirmation: send "confirm": true.',
      );
    if (b.pool === undefined && b.project === undefined)
      return this.manage.invalid({ pool: 'A storage pool or a project to move it to.' });
    if (b.pool !== undefined && !this.#list(server, 'pools').some((p) => p.name === b.pool))
      return this.manage.invalid({ pool: 'No such storage pool.' });
    const from = projectOf(guest);
    const project = this.#project(server, b.project ?? from);
    if (isAnswer(project)) return project;
    if (guest.state !== 'stopped')
      return problem(409, 'guest_running', 'The instance has to be stopped first.');
    const x = this.#expanded(server, guest);
    const pool = b.pool === undefined ? undefined : String(b.pool);
    if (project === from && (pool === undefined || x.devices.root?.pool === pool))
      return this.manage.invalid({ pool: 'The instance is there already.' });
    const name = String(guest.name);
    const id = idOf(project, name);
    if (id !== guestId && this.host.guest(server, id)) return problem(409, 'exists', `${id} already exists.`);
    return this.#task(r, server, 'guest.move', {
      type: 'Migrating instance',
      guest: guestId,
      answer: { new_id: id },
      plan: ['Migrating instance', 'Transferring instance: root: 3.42GB (512.80MB/s)', 'Instance moved'],
      apply: (good) => {
        if (!good) return;
        const inst = this.#inst(server, guest);
        if (pool !== undefined) inst.devices.root = { ...ROOT_DISK, ...(x.devices.root ?? {}), pool };
        if (project !== from) {
          const kept = inst.profiles.filter((p) => this.#profileState(server, project, p));
          inst.profiles = kept.length ? kept : ['default'];
          this.#reid(server, guestId, id, name, project);
        } else {
          this.#cfg(server, guest).digest += 1;
          this.host.emit('guest.state_changed', { server, id: guestId, state: guest.state });
        }
      },
    });
  }

  #publish(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#own(r, server, guestId, 'admin', 'Only Incus instances become images here.');
    if (gc === null) return null;
    if (isAnswer(gc)) return gc;
    const { guest } = gc;
    const b = this.#fields(r, ['alias', 'description', 'snapshot']);
    if (isAnswer(b)) return b;
    if (b.snapshot === undefined && guest.self === true) return problem(409, 'self_guest', SELF);
    if (b.snapshot !== undefined) {
      const snaps = this.manage.snapshots.get(this.#key(server, guestId)) ?? [];
      if (typeof b.snapshot !== 'string' || !snaps.some((s) => s.Name === b.snapshot))
        return this.manage.invalid({ snapshot: 'No such snapshot.' });
    } else if (guest.state !== 'stopped')
      return problem(
        409,
        'guest_running',
        'The instance has to be stopped first, or publish one of its snapshots.',
      );
    const project = projectOf(guest);
    if (b.alias !== undefined) {
      if (typeof b.alias !== 'string' || !ALIAS_RE.test(b.alias))
        return this.manage.invalid({ alias: 'A name such as web/base or my-image.' });
      if (
        this.#list(server, 'images').some(
          (i) => i.project === project && (i.aliases as string[]).includes(b.alias as string),
        )
      )
        return problem(409, 'exists', `An image called ${b.alias} exists already.`);
    }
    if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 1024))
      return this.manage.invalid({ description: 'Text of at most 1024 characters.' });
    const fp = fingerprint();
    const answer = this.#task(r, server, 'guest.publish', {
      type: 'Downloading image',
      guest: guestId,
      plan: [
        'Downloading image',
        'Exporting: 37%',
        'Image pack: 100%',
        `Instance published with fingerprint: ${fp}`,
      ],
      apply: (good) => {
        if (!good) return;
        this.#list(server, 'images').push({
          fingerprint: fp,
          aliases: typeof b.alias === 'string' ? [b.alias] : [],
          description:
            typeof b.description === 'string' ? b.description : `${String(guest.name)} (published)`,
          type: guest.kind === 'vm' ? 'virtual-machine' : 'container',
          architecture: 'x86_64',
          size_bytes: guest.kind === 'vm' ? 1_879_048_192 : 412_090_368,
          uploaded_at: iso(Date.now()),
          last_used_at: null,
          auto_update: false,
          cached: false,
          project,
        });
      },
    });
    // The fingerprint goes into the answer after the task started, so `task.finished` still names the instance.
    (answer.body as Json).new_id = fp;
    return answer;
  }

  #log(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#own(r, server, guestId, 'operator', 'Only Incus instances have a log here.');
    if (gc === null) return null;
    if (isAnswer(gc)) return gc;
    const { guest } = gc;
    const raw = r.query.get('lines');
    const lines = raw === null ? 500 : /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(lines >= 1 && lines <= 2000))
      return this.manage.invalid({ lines: 'A number of lines from 1 to 2000.' });
    const name = String(guest.name);
    const at = Date.parse(this.host.asOf());
    const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').replace('Z', '');
    const all: string[] = [];
    for (let boot = 5; boot >= 1; boot--) {
      const t = at - boot * 7 * DAY;
      if (guest.kind === 'vm')
        all.push(
          `${iso(t)} qemu-system-x86_64: warning: host doesn't support requested feature: CPUID.80000007H:EDX.invtsc [bit 8]`,
          `${iso(t + 412)} qemu-system-x86_64: -device virtio-net-pci,netdev=dev-eth0: warning: tap: vhost-net is not available`,
          `${iso(t + 2_050)} qemu-system-x86_64: agent: guest agent connected`,
          `${iso(t + 6 * DAY)} qemu-system-x86_64: terminating on signal 15 from pid 1882 (incusd)`,
        );
      else
        all.push(
          `lxc ${name} ${stamp(t)} WARN     idmap_utils - ../src/lxc/idmap_utils.c:lxc_map_ids:165 - newuidmap binary is missing`,
          `lxc ${name} ${stamp(t + 1)} WARN     idmap_utils - ../src/lxc/idmap_utils.c:lxc_map_ids:171 - newgidmap binary is missing`,
          `lxc ${name} ${stamp(t + 94)} WARN     cgfsng - ../src/lxc/cgroups/cgfsng.c:fchowmodat:1611 - No such file or directory - Failed to fchownat(41, memory.oom.group, 1000000000, 0, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW )`,
          `lxc ${name} ${stamp(t + 130)} INFO     conf - ../src/lxc/conf.c:run_script_argv:340 - Executing script "/proc/1882/exe callhook /var/lib/incus \\"${parseId(String(guest.id)).project}\\" \\"${name}\\" start" for container "${name}"`,
          `lxc ${name} ${stamp(t + 402)} NOTICE   start - ../src/lxc/start.c:start:2196 - Exec'ing "/sbin/init"`,
          `lxc ${name} ${stamp(t + 405)} NOTICE   start - ../src/lxc/start.c:post_start:2207 - Started "/sbin/init" with pid "48211"`,
        );
    }
    return ok({ file: guest.kind === 'vm' ? 'qemu.log' : 'lxc.log', lines: all.slice(-lines) });
  }

  /* Backups --------------------------------------------------------------------------------------------------------- */

  #listBackups(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#shared(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    return ok({ items: this.#backups.get(this.#key(server, guestId)) ?? [] });
  }

  #backup(r: FakeRequest, server: string, guestId: string): FakeAnswer | null {
    const gc = this.#shared(r, server, guestId, 'operator');
    if (!gc || isAnswer(gc)) return gc;
    const { guest } = gc;
    const b = this.#fields(r, ['name', 'expires_at', 'instance_only', 'optimized', 'compression']);
    if (isAnswer(b)) return b;
    const key = this.#key(server, guestId);
    const list = this.#backups.get(key) ?? [];
    let name: string;
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !NAME_RE.test(b.name))
        return this.manage.invalid({ name: 'Letters, digits, dots, dashes and underscores (at most 63).' });
      if (list.some((x) => x.volume === b.name))
        return problem(409, 'exists', `A backup called ${b.name} exists already.`);
      name = b.name;
    } else {
      const base = `whombat-${new Date().toISOString().slice(0, 16).replace(/-/g, '').replace('T', '-').replace(':', '')}`;
      name = base;
      for (let i = 2; list.some((x) => x.volume === name); i++) name = `${base}-${i}`;
    }
    let expires = Date.now() + 7 * DAY;
    if (b.expires_at !== undefined) {
      expires = typeof b.expires_at === 'string' ? Date.parse(b.expires_at) : Number.NaN;
      if (!(expires > Date.now())) return this.manage.invalid({ expires_at: 'A time in the future.' });
    }
    if (b.compression !== undefined && !['zstd', 'gzip', 'none'].includes(String(b.compression)))
      return this.manage.invalid({ compression: 'zstd, gzip or none.' });
    const bad = this.#bools(b, ['instance_only', 'optimized']);
    if (bad) return bad;
    return this.#task(r, server, 'backup.create', {
      type: 'Backing up instance',
      guest: guestId,
      plan: [
        'Backing up instance',
        'Exporting backup: 23%',
        'Exporting backup: 71%',
        'Backup exported successfully',
      ],
      apply: (good) => {
        if (!good) return;
        const size = guest.kind === 'vm' ? 3_435_973_836 : 642_252_390;
        list.push(
          this.#backupJson(
            name,
            iso(Date.now()),
            b.instance_only === true ? Math.round(size * 0.8) : size,
            b.optimized === true ? 'optimized' : 'tar',
            iso(expires),
          ),
        );
        this.#backups.set(key, list);
        this.#hints(server);
      },
    });
  }

  #restore(r: FakeRequest, server: string): FakeAnswer | null {
    const raw = (r.body && typeof r.body === 'object' ? r.body : {}) as Json;
    const guestish = typeof raw.guest === 'string' && raw.guest.startsWith('incus:');
    if (!(raw.platform === 'incus' || (raw.platform === undefined && guestish && this.#detail(server))))
      return null;
    const refused = this.#hostRoute(r, server, 'admin');
    if (refused) return refused;
    const b = this.#fields(r, [
      'platform',
      'volume',
      'new_id',
      'guest',
      'storage',
      'start',
      'unique',
      'confirm',
      'name',
    ]);
    if (isAnswer(b)) return b;
    if (typeof b.guest !== 'string') return this.manage.invalid({ guest: 'Whose backup?' });
    const source = this.host.guest(server, b.guest);
    if (source?.platform !== 'incus') return problem(404, 'guest_not_found', 'No such guest.');
    if (typeof b.volume !== 'string' || !b.volume) return this.manage.invalid({ volume: 'Which backup?' });
    const backup = (this.#backups.get(this.#key(server, b.guest)) ?? []).find((x) => x.volume === b.volume);
    if (!backup) return problem(404, 'not_found', 'No such backup.');
    const name = b.name === undefined ? `${String(source.name)}-restored` : b.name;
    if (typeof name !== 'string' || !INSTANCE_RE.test(name))
      return this.manage.invalid({
        name: 'Letters, digits and dashes, starting with a letter (at most 63).',
      });
    if (b.storage !== undefined && !this.#list(server, 'pools').some((p) => p.name === b.storage))
      return this.manage.invalid({ storage: 'No such storage pool.' });
    const bad = this.#bools(b, ['start']);
    if (bad) return bad;
    const project = projectOf(source);
    const id = idOf(project, name);
    if (this.host.guest(server, id)) return problem(409, 'exists', `${id} already exists.`);
    const x = this.#expanded(server, source);
    const values = { ...x.own };
    const devices = structuredClone(x.inst.devices);
    if (b.storage !== undefined)
      devices.root = { ...ROOT_DISK, ...(x.devices.root ?? {}), pool: String(b.storage) };
    const profiles = [...x.inst.profiles];
    const start = b.start === true;
    return this.#task(r, server, 'backup.restore', {
      type: 'Restoring backup',
      guest: id,
      answer: { new_id: id },
      plan: [
        'Restoring backup',
        'Importing backup: 48%',
        'Importing backup: 100%',
        `Instance ${name} created from the backup`,
      ],
      apply: (good) => {
        if (!good) return;
        const copy = this.#newGuest({
          id,
          kind: String(source.kind),
          image: String(source.image),
          state: start ? 'running' : 'stopped',
          vcpu: Number(source.vcpu ?? 1),
          memoryMb: (source.memory_limit_mb as number | null) ?? null,
        });
        this.#addInstance(server, copy, values, { profiles, devices });
      },
    });
  }

  #deleteBackup(r: FakeRequest, server: string): FakeAnswer | null {
    const platform = r.query.get('platform') ?? undefined;
    const guestish = r.query.get('guest')?.startsWith('incus:') === true;
    if (!(platform === 'incus' || (platform === undefined && guestish && this.#detail(server)))) return null;
    const refused = this.#hostRoute(r, server, 'admin') ?? this.#query(r, ['platform', 'guest', 'volume']);
    if (refused) return refused;
    const guestId = r.query.get('guest');
    if (!guestId) return this.manage.invalid({ guest: 'Whose backup?' });
    const guest = this.host.guest(server, guestId);
    if (guest?.platform !== 'incus') return problem(404, 'guest_not_found', 'No such guest.');
    const list = this.#backups.get(this.#key(server, guestId)) ?? [];
    const i = list.findIndex((x) => x.volume === r.query.get('volume'));
    if (i < 0) return problem(404, 'not_found', 'No such backup.');
    list.splice(i, 1);
    this.#hints(server);
    return ok({ ok: true, audit_id: audit() });
  }

  /* Choices --------------------------------------------------------------------------------------------------------- */

  #choices(r: FakeRequest, server: string): FakeAnswer | null {
    if (!this.#mine(server, r.query.get('platform') ?? undefined)) return null;
    const refused = this.#hostRoute(r, server, 'operator');
    if (refused) return refused;
    const project = this.#project(server, r.query.get('project') ?? undefined);
    if (isAnswer(project)) return project;
    return ok({
      platform: 'incus',
      project,
      storages: this.#list(server, 'pools').map((p) => ({
        id: p.name,
        type: p.driver,
        content: ['images', 'rootdir'],
        avail_bytes: Number(p.total_bytes ?? 0) - Number(p.used_bytes ?? 0),
        total_bytes: p.total_bytes,
        ...(p.driver === 'zfs' || p.driver === 'lvm' ? { thin: true } : {}),
      })),
      bridges: this.#list(server, 'networks')
        .filter((x) => x.managed === true || x.type === 'bridge')
        .map((x) => x.name),
      profiles: this.#list(server, 'profiles')
        .filter((p) => p.project === project)
        .map((p) => p.name),
      images: this.#list(server, 'images')
        .filter((i) => i.project === project || (project !== 'default' && i.project === 'default'))
        .map((i) => ({
          fingerprint: i.fingerprint,
          aliases: i.aliases,
          description: i.description,
          type: i.type,
          size_bytes: i.size_bytes,
        })),
      projects: this.#list(server, 'projects').map((p) => p.name),
      remote_images: REMOTE_IMAGES,
    });
  }

  /* Profiles -------------------------------------------------------------------------------------------------------- */

  #profileEntry(server: string, project: string, name: string): Json | null {
    return this.#list(server, 'profiles').find((p) => p.project === project && p.name === name) ?? null;
  }

  #getProfile(r: FakeRequest, server: string, name: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'operator');
    if (refused) return refused;
    const project = this.#project(server, r.query.get('project') ?? undefined);
    if (isAnswer(project)) return project;
    const entry = this.#profileEntry(server, project, name);
    const p = this.#profileState(server, project, name);
    if (!entry || !p) return problem(404, 'not_found', 'No such profile.');
    return ok({
      name,
      project,
      description: entry.description ?? '',
      config: { ...p.config },
      devices: structuredClone(p.devices),
      used_by: this.#profileUsers(server, project, name),
      restricted: [
        ...Object.keys(p.config).filter((k) => !keyAllowed(k, 'profile')),
        ...Object.entries(p.devices)
          .filter(([, d]) => restrictedDevice(d))
          .map(([n]) => `device.${n}`),
      ],
      digest: `p${p.digest}`,
    });
  }

  #createProfile(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'admin');
    if (refused) return refused;
    const b = this.#fields(r, ['name', 'description', 'copy_from', 'project']);
    if (isAnswer(b)) return b;
    if (typeof b.name !== 'string' || !NAME_RE.test(b.name))
      return this.manage.invalid({ name: 'Letters, digits, dots, dashes and underscores (at most 64).' });
    const project = this.#project(server, b.project);
    if (isAnswer(project)) return project;
    if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 1024))
      return this.manage.invalid({ description: 'Text of at most 1024 characters.' });
    let from: ProfileState | null = null;
    if (b.copy_from !== undefined) {
      from = typeof b.copy_from === 'string' ? this.#profileState(server, project, b.copy_from) : null;
      if (!from)
        return this.manage.invalid({
          copy_from: `No profile “${String(b.copy_from)}” in the project ${project}.`,
        });
    }
    if (this.#profileEntry(server, project, b.name))
      return problem(409, 'exists', `A profile called ${b.name} exists already.`);
    const entry: Json = {
      name: b.name,
      project,
      description:
        typeof b.description === 'string'
          ? b.description
          : String(
              (b.copy_from && this.#profileEntry(server, project, String(b.copy_from))?.description) ?? '',
            ),
      used_by: 0,
    };
    this.#list(server, 'profiles').push(entry);
    this.#profiles.set(this.#profileKey(server, project, b.name), {
      config: { ...(from?.config ?? {}) },
      devices: structuredClone(from?.devices ?? {}),
      digest: 1,
    });
    this.#liven(server, 'profiles', entry);
    return ok({ ok: true, audit_id: audit() });
  }

  #updateProfile(r: FakeRequest, server: string, name: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'admin');
    if (refused) return refused;
    const b = this.#fields(r, ['project', 'digest', 'set', 'delete', 'devices', 'description']);
    if (isAnswer(b)) return b;
    const project = this.#project(server, b.project);
    if (isAnswer(project)) return project;
    const entry = this.#profileEntry(server, project, name);
    const p = this.#profileState(server, project, name);
    if (!entry || !p) return problem(404, 'not_found', 'No such profile.');
    if (b.digest !== undefined && b.digest !== `p${p.digest}`)
      return problem(409, 'digest_mismatch', 'The profile changed meanwhile.');
    const keys = this.#checkKeys(b.set, b.delete, 'profile');
    if (isAnswer(keys)) return keys;
    if (b.devices !== undefined && (!b.devices || typeof b.devices !== 'object' || Array.isArray(b.devices)))
      return this.manage.invalid({ devices: 'An object of devices by name (null removes one).' });
    if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 1024))
      return this.manage.invalid({ description: 'Text of at most 1024 characters.' });
    const devices = { ...keys.devices, ...((b.devices ?? {}) as Record<string, Device | null>) };
    const devRefused = this.#checkDevices(server, project, 'profile', devices, p.devices, {});
    if (devRefused) return devRefused;
    const values = () => ({
      ...p.config,
      ...Object.fromEntries(Object.entries(p.devices).map(([n, d]) => [`device.${n}`, deviceString(d)])),
    });
    const before = values();
    Object.assign(p.config, keys.set);
    for (const k of keys.del) delete p.config[k];
    for (const [n, dev] of Object.entries(devices))
      if (dev === null) delete p.devices[n];
      else p.devices[n] = { ...dev };
    const changes = this.#diff(before, values()).map(({ pending: _p, ...c }) => c);
    if (typeof b.description === 'string' && b.description !== entry.description) {
      changes.push({ key: 'description', old: String(entry.description ?? ''), new: b.description });
      entry.description = b.description;
    }
    p.digest += 1;
    this.#hints(server);
    return ok({ ok: true, changes, audit_id: audit() });
  }

  #deleteProfile(r: FakeRequest, server: string, name: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'admin') ?? this.#query(r, ['project', 'confirm']);
    if (refused) return refused;
    const project = this.#project(server, r.query.get('project') ?? undefined);
    if (isAnswer(project)) return project;
    const entry = this.#profileEntry(server, project, name);
    if (!entry) return problem(404, 'not_found', 'No such profile.');
    if (name === 'default') return problem(403, 'not_allowed', 'The default profile can’t be deleted.');
    if (!this.#confirmed(r))
      return problem(400, 'confirm_required', 'Deleting a profile can’t be undone: send confirm=1.');
    const users = this.#profileUsers(server, project, name);
    if (users.length)
      return problem(
        409,
        'in_use',
        `The profile is used by ${users.map((u) => parseId(u).name).join(', ')}.`,
      );
    const list = this.#list(server, 'profiles');
    list.splice(list.indexOf(entry), 1);
    this.#profiles.delete(this.#profileKey(server, project, name));
    return ok({ ok: true, audit_id: audit() });
  }

  /* Networks -------------------------------------------------------------------------------------------------------- */

  #leases(r: FakeRequest, server: string, network: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'operator');
    if (refused) return refused;
    const project = this.#project(server, r.query.get('project') ?? undefined);
    if (isAnswer(project)) return project;
    const n = this.#list(server, 'networks').find((x) => x.name === network);
    if (!n) return problem(404, 'not_found', 'No such network.');
    if (n.managed !== true) return ok({ items: [] });
    const prefix = String(n.ipv4 ?? '10.0.0.1/24').replace(/\.\d+\/\d+$/, '.');
    const items: Json[] = [];
    for (const g of this.#guests(server)) {
      if (g.state !== 'running' || projectOf(g) !== project) continue;
      const nic = Object.values(this.#expanded(server, g).devices).find(
        (d) => d.type === 'nic' && d.network === network,
      );
      if (!nic) continue;
      const hwaddr = String((g.macs as string[] | undefined)?.[0] ?? nic.hwaddr ?? '');
      const last = Number.parseInt(hwaddr.slice(-2), 16) || 0;
      items.push({
        hostname: g.name,
        address: nic['ipv4.address'] ?? `${prefix}${20 + (last % 200)}`,
        hwaddr,
        type: nic['ipv4.address'] ? 'static' : 'dynamic',
        guest: g.id,
      });
    }
    if (project === 'default')
      items.push({
        hostname: 'old-runner',
        address: `${prefix}241`,
        hwaddr: '10:66:6a:0f:6e:21',
        type: 'dynamic',
        guest: null,
      });
    return ok({ items });
  }

  /* Images ---------------------------------------------------------------------------------------------------------- */

  #downloadImage(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'admin');
    if (refused) return refused;
    const b = this.#fields(r, ['alias', 'type', 'project', 'auto_update']);
    if (isAnswer(b)) return b;
    const alias = typeof b.alias === 'string' && b.alias.startsWith('images:') ? b.alias.slice(7) : b.alias;
    if (typeof alias !== 'string' || !ALIAS_RE.test(alias))
      return this.manage.invalid({ alias: 'An image of images: such as debian/13.' });
    if (b.type !== 'container' && b.type !== 'virtual-machine')
      return this.manage.invalid({ type: 'container or virtual-machine.' });
    const type = b.type;
    const project = this.#project(server, b.project);
    if (isAnswer(project)) return project;
    const bad = this.#bools(b, ['auto_update']);
    if (bad) return bad;
    if (
      this.#list(server, 'images').some(
        (i) => i.project === project && i.type === type && (i.aliases as string[]).includes(alias),
      )
    )
      return problem(409, 'exists', `${alias} is here already.`);
    const fp = fingerprint();
    const answer = this.#task(r, server, 'image.download', {
      type: 'Downloading image',
      cancellable: true,
      plan: [
        'Downloading image',
        'Retrieving image: 9% (24.12MB/s)',
        'Retrieving image: 63% (31.80MB/s)',
        'Retrieving image: 100% (30.95MB/s)',
        `Image downloaded: ${fp.slice(0, 12)}`,
      ],
      apply: (good) => {
        if (!good) return;
        this.#list(server, 'images').push({
          fingerprint: fp,
          aliases: [alias],
          description: `${String(REMOTE_IMAGES.find((i) => i.alias === alias)?.description ?? alias)} amd64`,
          type,
          architecture: 'x86_64',
          size_bytes: type === 'virtual-machine' ? 312_475_648 : 104_857_600,
          uploaded_at: iso(Date.now()),
          last_used_at: null,
          auto_update: b.auto_update !== false,
          cached: false,
          project,
        });
      },
    });
    (answer.body as Json).new_id = fp;
    return answer;
  }

  #refreshImage(r: FakeRequest, server: string, ref: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'operator');
    if (refused) return refused;
    const b = this.#fields(r, ['project']);
    if (isAnswer(b)) return b;
    const project = this.#project(server, b.project);
    if (isAnswer(project)) return project;
    const img = this.#imageByFp(server, ref, project);
    if (!img) return problem(404, 'not_found', 'No such image.');
    return this.#task(r, server, 'image.refresh', {
      type: 'Refreshing image',
      plan: ['Refreshing image', `Image ${String(img.fingerprint).slice(0, 12)} is up to date`],
      apply: (good) => {
        if (good) img.uploaded_at = iso(Date.now());
      },
    });
  }

  #deleteImage(r: FakeRequest, server: string, ref: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'admin') ?? this.#query(r, ['project']);
    if (refused) return refused;
    const project = this.#project(server, r.query.get('project') ?? undefined);
    if (isAnswer(project)) return project;
    const img = this.#imageByFp(server, ref, project);
    if (!img) return problem(404, 'not_found', 'No such image.');
    const users = this.#imageUsers(server, img);
    if (users.length)
      return problem(409, 'in_use', `The image is used by ${users.map((g) => g.name).join(', ')}.`);
    const list = this.#list(server, 'images');
    list.splice(list.indexOf(img), 1);
    return ok({ ok: true, audit_id: audit() });
  }

  /* Volumes --------------------------------------------------------------------------------------------------------- */

  #volume(server: string, pool: string, name: string, project: string): Json | null {
    return (
      this.#list(server, 'volumes').find(
        (v) => v.pool === pool && v.name === name && v.project === project,
      ) ?? null
    );
  }

  #createVolume(r: FakeRequest, server: string, pool: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'admin');
    if (refused) return refused;
    if (!this.#list(server, 'pools').some((p) => p.name === pool))
      return problem(404, 'not_found', 'No such storage pool.');
    const b = this.#fields(r, ['name', 'size', 'content_type', 'project', 'description']);
    if (isAnswer(b)) return b;
    if (typeof b.name !== 'string' || !VOLUME_RE.test(b.name))
      return this.manage.invalid({ name: 'Letters, digits, dots, dashes and underscores.' });
    const size = parseSize(b.size);
    if (!size || size.relative) return this.manage.invalid({ size: 'A size such as 10GiB.' });
    const contentType = b.content_type ?? 'filesystem';
    if (contentType !== 'filesystem' && contentType !== 'block')
      return this.manage.invalid({ content_type: 'filesystem or block.' });
    const project = this.#project(server, b.project);
    if (isAnswer(project)) return project;
    if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 1024))
      return this.manage.invalid({ description: 'Text of at most 1024 characters.' });
    if (this.#volume(server, pool, b.name, project))
      return problem(409, 'exists', `A volume called ${b.name} exists already.`);
    const entry: Json = {
      pool,
      name: b.name,
      project,
      type: 'custom',
      content_type: contentType,
      size_bytes: size.bytes,
      used_bytes: contentType === 'block' ? null : 0,
      used_by: [],
      description: typeof b.description === 'string' ? b.description : '',
    };
    this.#list(server, 'volumes').push(entry);
    this.#liven(server, 'volumes', entry);
    return ok({ ok: true, audit_id: audit() });
  }

  #resizeVolume(r: FakeRequest, server: string, pool: string, name: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'operator');
    if (refused) return refused;
    const b = this.#fields(r, ['size', 'project']);
    if (isAnswer(b)) return b;
    const project = this.#project(server, b.project);
    if (isAnswer(project)) return project;
    const v = this.#volume(server, pool, name, project);
    if (!v) return problem(404, 'not_found', 'No such volume.');
    const want = parseSize(b.size);
    if (!want) return this.manage.invalid({ size: 'A size such as +10G or 300GiB.' });
    const cur = Number(v.size_bytes ?? 0);
    const next = want.relative ? cur + want.bytes : want.bytes;
    if (next < cur)
      return this.manage.invalid({ size: `Volumes only grow: this one has ${sizeString(cur)}.` });
    if (next === cur) return ok({ ok: true, changes: [], audit_id: audit() });
    v.size_bytes = next;
    return ok({
      ok: true,
      changes: [{ key: 'size', old: sizeString(cur), new: sizeString(next) }],
      audit_id: audit(),
    });
  }

  #deleteVolume(r: FakeRequest, server: string, pool: string, name: string): FakeAnswer {
    const refused = this.#hostRoute(r, server, 'admin') ?? this.#query(r, ['project', 'confirm']);
    if (refused) return refused;
    const project = this.#project(server, r.query.get('project') ?? undefined);
    if (isAnswer(project)) return project;
    const v = this.#volume(server, pool, name, project);
    if (!v) return problem(404, 'not_found', 'No such volume.');
    if (!this.#confirmed(r))
      return problem(400, 'confirm_required', 'Deleting a volume destroys its data: send confirm=1.');
    const users = this.#volumeUsers(server, v);
    if (users.length)
      return problem(
        409,
        'in_use',
        `The volume is attached to ${users.map((u) => parseId(u).name).join(', ')}.`,
      );
    const list = this.#list(server, 'volumes');
    list.splice(list.indexOf(v), 1);
    return ok({ ok: true, audit_id: audit() });
  }

  /* Tasks ----------------------------------------------------------------------------------------------------------- */

  /** An Incus operation (`incus:<uuid>`), ending like every fake task. */
  #task(
    r: FakeRequest,
    server: string,
    op: string,
    t: {
      type: string;
      guest?: string | null;
      plan: string[];
      apply: (ok: boolean) => void;
      answer?: Json;
      cancellable?: boolean;
    },
  ): FakeAnswer {
    return this.manage.startTask(r, server, op, {
      ...t,
      idKind: 'incus',
      cancellable: t.cancellable ?? false,
    });
  }
}
