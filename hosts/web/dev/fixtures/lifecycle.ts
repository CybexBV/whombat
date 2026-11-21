// Guest lifecycle in fixture mode (docs/MANAGE.md): create, clone, convert
// to template and delete guests, backups and restore, storage content and
// appliance downloads, the guest firewall, HA and replication. Uses the
// per-browser state and helpers of manage.ts; guests created here are kept
// in createdGuests and show in the host's lists (applyLifecycle), deleted
// ones disappear. Every task is watched so `task.finished` arrives on time
// even when no dialog follows it (like the hub's task watcher).

import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { Guest, PlatformWorkload, Problem } from '../../src/api/types.ts';
import type { Appliance, BackupVolume, FirewallRule, GuestFirewall, HASettings, ManagePlatform, StorageVolume, TemplateGuest } from '../../src/api/manage-types.ts';
import { workloadsOf } from './catalog.ts';
import type { Ctx } from './ctx.ts';
import type { FixtureSet } from './data.ts';
import { bodyObject, type FxResponse, json, problem } from './http.ts';
import {
  accepted,
  auditManage,
  choicesFor,
  type ConfigRec,
  configOf,
  createdGuests,
  decode,
  findManagedGuest,
  hostPlatform,
  manageGuest,
  manageHost,
  type ManageRoute,
  manageState,
  type Refusal,
  startTask,
  type TaskRec,
  taskStatus,
} from './manage.ts';
import { type BrowserState, iso, randomHex } from './state.ts';

const refuse = (r: Refusal): FxResponse => problem(r.status, r.code, r.detail);

/** 400 invalid_value with the field that failed (the hub's field_errors). */
function invalid(detail: string, fields: Record<string, string>): FxResponse {
  const body: Problem = { type: 'https://rackoon.dev/problems/invalid_value', title: STATUS_CODES[400] ?? 'Bad Request', status: 400, detail, code: 'invalid_value', field_errors: fields };
  return { status: 400, headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

const ok = (): FxResponse => json(200, { ok: true, audit_id: `au_${randomHex(6)}` });
const GiB = 1024 ** 3;

// ---------------------------------------------------------------- state

interface LifecycleState {
  backups: Map<string, BackupVolume[]>;
  firewall: Map<string, { options: Record<string, string>; rules: Omit<FirewallRule, 'pos'>[] }>;
  imports: StorageVolume[];
  /** Backups made in this browser (keeps their times apart on the frozen clock). */
  made: number;
  templated?: Set<string>;
}

function lc(st: BrowserState): LifecycleState {
  const m = manageState(st);
  let s = m.extra.get('lifecycle') as LifecycleState | undefined;
  if (!s) {
    s = {
      backups: new Map(),
      firewall: new Map(),
      imports: [{ volume: 'local:import/haos_ova-16.2.qcow2', storage: 'local', content: 'import', name: 'haos_ova-16.2.qcow2', size_bytes: 512 * 1024 ** 2, created: '2026-09-28T18:20:00Z' }],
      made: 0,
    };
    m.extra.set('lifecycle', s);
  }
  return s;
}

/** "server/guestId" of deleted (or templated) guests and deleted volume ids; choicesFor reads it too. */
function deleted(st: BrowserState): Set<string> {
  const m = manageState(st);
  let s = m.extra.get('deleted') as Set<string> | undefined;
  if (!s) {
    s = new Set();
    m.extra.set('deleted', s);
  }
  return s;
}

/** "server/guestId" of guests converted to templates (they leave the guest lists). */
function templated(st: BrowserState): Set<string> {
  const s = lc(st);
  return (s.templated ??= new Set());
}

function extraList<T>(st: BrowserState, key: 'isos' | 'ct_templates' | 'templates'): T[] {
  const m = manageState(st);
  let l = m.extra.get(key) as T[] | undefined;
  if (!l) {
    l = [];
    m.extra.set(key, l);
  }
  return l;
}

/** Start a task and look at it when it should be over, so task.finished is published without a poller. */
function runTask(c: Ctx, op: string, t: Parameters<typeof startTask>[1]): TaskRec {
  const task = startTask(c, t);
  c.store.schedule(c.st, task.durationMs + 60, () => taskStatus(c, task, -1, op));
  return task;
}

// ---------------------------------------------------------------- guests in the lists

const listed = new WeakSet<FixtureSet>();

const splitTags = (v: string | undefined): string[] =>
  (v ?? '')
    .split(/[;,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function workloadFor(fx: FixtureSet, server: string, g: Guest): PlatformWorkload | undefined {
  if (server === 'shale') return g.kind === 'vm' ? fx.shale.guests.vm : fx.shale.guests.container;
  if (server === 'basalt') return fx.basalt.workloads?.incus;
  return undefined;
}

const live = (g: Guest) => g.state !== 'stopped';

/**
 * This browser's lifecycle changes on a fresh fixture copy (in place, once):
 * deleted and templated guests leave the lists, created ones join them,
 * and Proxmox guests carry the tags of their configuration.
 */
export function applyLifecycle(st: BrowserState, fx: FixtureSet): void {
  if (listed.has(fx)) return;
  listed.add(fx);
  const del = deleted(st);
  const tpl = templated(st);
  const gone = { has: (k: string) => del.has(k) || tpl.has(k) };
  for (const server of ['basalt', 'shale']) {
    for (const w of workloadsOf(fx, server)) {
      const out = w.guests.filter((g) => gone.has(`${server}/${g.id}`));
      if (!out.length) continue;
      w.guests = w.guests.filter((g) => !gone.has(`${server}/${g.id}`));
      w.total -= out.length;
      if (w.guests_shown != null) w.guests_shown -= out.length;
      w.running -= out.filter(live).length;
    }
  }
  for (const [key, g] of createdGuests(st)) {
    const server = key.slice(0, key.indexOf('/'));
    const w = workloadFor(fx, server, g);
    if (!w || gone.has(key) || w.guests.some((x) => x.id === g.id)) continue;
    w.guests.push(structuredClone(g));
    w.total++;
    if (w.guests_shown != null) w.guests_shown++;
    if (live(g)) {
      w.running++;
      if (g.platform === 'incus' && g.kind === 'container' && w.containers !== undefined) w.containers++;
      if (g.platform === 'incus' && g.kind === 'vm' && w.vms !== undefined) w.vms++;
    }
  }
  // configOf only reads the browser state.
  const ctx = { st } as Ctx;
  for (const w of workloadsOf(fx, 'shale')) {
    for (const g of w.guests) {
      const tags = splitTags(configOf(ctx, 'shale', g)?.values.tags);
      if (tags.length) g.tags = tags;
    }
  }
}

// ---------------------------------------------------------------- helpers

/** A guest object as the agent reports it (live numbers only while running). */
function newGuest(p: { platform: ManagePlatform; kind: 'vm' | 'container'; id: string; name: string; image: string; vcpu: number; memoryMb: number; running: boolean }): Guest {
  const vm = p.kind === 'vm';
  const protocols: Guest['console']['protocols'] = vm ? (p.platform === 'incus' ? ['spice'] : ['vnc', 'spice']) : ['shell', 'tty'];
  const vmid = p.platform === 'pve' ? Number(p.id.split(':')[1]) : undefined;
  return {
    id: p.id,
    name: p.name,
    platform: p.platform,
    kind: p.kind,
    image: p.image,
    state: p.running ? 'running' : 'stopped',
    vcpu: p.vcpu,
    cpu_pct: p.running ? 0.8 : null,
    memory_used_mb: p.running ? Math.round(p.memoryMb * 0.18) : null,
    memory_limit_mb: p.memoryMb,
    disk_read_mbs: p.running ? 0 : null,
    disk_write_mbs: p.running ? 0 : null,
    net_rx_mbps: p.running ? 0 : null,
    net_tx_mbps: p.running ? 0 : null,
    snapshots: null,
    uptime_s: p.running ? 30 : null,
    console: { available: true, protocols, default_protocol: protocols[0], resolution: p.running ? (vm ? '1024x768' : '132x36') : null },
    ...(vmid !== undefined ? { vmid, node: 'shale', last_backup: null } : {}),
  };
}

const DISK_KEY = /^(ide|sata|scsi|virtio|efidisk|tpmstate|mp)\d+$|^rootfs$/;
const mac = (vmid: number, i: number) => `BC:24:11:${(0x40 + ((vmid + i) % 0x30)).toString(16).toUpperCase()}:${((vmid * 11 + i) % 256).toString(16).padStart(2, '0').toUpperCase()}:${((vmid * 7 + i * 3) % 256).toString(16).padStart(2, '0').toUpperCase()}`;

/** New volumes ("local-zfs:32") get names and sizes; NICs get MAC addresses (what PVE writes into the configuration). */
function allocate(values: Record<string, string>, vmid: number, kind: 'vm' | 'container'): Record<string, string> {
  const out: Record<string, string> = {};
  let disk = 0;
  for (const [k, v] of Object.entries(values)) {
    const [file = '', ...rest] = v.split(',');
    const m = /^([\w-]+):(\d+(?:\.\d+)?)$/.exec(file);
    if (DISK_KEY.test(k) && m && !v.includes('media=cdrom')) {
      const name = kind === 'container' ? `subvol-${vmid}-disk-${disk++}` : `vm-${vmid}-disk-${disk++}`;
      const size = k === 'efidisk0' ? '1M' : k === 'tpmstate0' ? '4M' : `${m[2]}G`;
      out[k] = [`${m[1]}:${name}`, ...rest, `size=${size}`].join(',');
    } else if (/^net\d+$/.test(k)) {
      const i = Number(k.slice(3));
      if (kind === 'vm' && /^(virtio|e1000e?|rtl8139|vmxnet3)$/.test(file)) out[k] = [`${file}=${mac(vmid, i)}`, ...rest].join(',');
      else if (kind === 'container' && !v.includes('hwaddr=')) out[k] = `${v},hwaddr=${mac(vmid, i)}`;
      else out[k] = v;
    } else out[k] = v;
  }
  return out;
}

/** A clone's or restored guest's configuration: the source's with its volumes renamed (and moved for full clones). */
function copyConfig(src: ConfigRec, fromId: string, toId: string, storage?: string): ConfigRec {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(src.values)) {
    if (/^unused\d+$/.test(k)) continue;
    if (DISK_KEY.test(k) && !v.includes('media=cdrom') && v.includes(':')) {
      const [file = '', ...rest] = v.split(',');
      const [store = '', vol = ''] = file.split(':');
      values[k] = [`${storage ?? store}:${vol.replace(`-${fromId}-`, `-${toId}-`)}`, ...rest].join(',');
    } else if (/^net\d+$/.test(k)) {
      values[k] = v.replace(/([0-9A-F]{2}:){5}[0-9A-F]{2}/i, mac(Number(toId) || 0, Number(k.slice(3))));
    } else values[k] = v;
  }
  return { ...src, values, pending: {}, pendingDelete: [], replication: [], ha: null };
}

function osLabel(set: Record<string, string>): string {
  const os: Record<string, string> = { l26: 'Linux', l24: 'Linux 2.4', win11: 'Windows 11', win10: 'Windows 10', win2k22: 'Windows Server 2022', other: 'Other', solaris: 'Solaris' };
  return [os[set.ostype ?? 'l26'] ?? set.ostype, set.bios === 'ovmf' ? 'OVMF' : '', set.tpmstate0 ? 'TPM' : ''].filter(Boolean).join(' · ');
}

/** "local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst" -> "debian 13". */
function templateImage(volume: string): string {
  const name = volume.split('/').pop() ?? volume;
  const [os = name, ver = ''] = name.split(/[-_]/);
  return `${os} ${ver}`.trim();
}

function vmidTaken(c: Ctx, server: string, vmid: number): boolean {
  const id = `pve:${vmid}`;
  if (deleted(c.st).has(`${server}/${id}`) && !createdGuests(c.st).has(`${server}/${id}`)) return false;
  return !!findManagedGuest(c, server, id) || choicesFor(c, server, 'pve').templates?.some((t) => t.id === String(vmid)) === true;
}

/** The guest or one of the host's templates (templates are guests on PVE, but not in the report's lists). */
function guestOrTemplate(c: Ctx, server: string, guestId: string, admin: boolean): { guest: Guest; config: ConfigRec; template: TemplateGuest | null } | Refusal {
  const h = manageHost(c, server, admin);
  if ('status' in h) return h;
  if (deleted(c.st).has(`${server}/${guestId}`) && !createdGuests(c.st).has(`${server}/${guestId}`)) return { status: 404, code: 'guest_not_found', detail: 'No such guest on this server.' };
  const tpl = guestId.startsWith('pve:') ? (choicesFor(c, server, 'pve').templates?.find((t) => `pve:${t.id}` === guestId) ?? null) : null;
  if (tpl) {
    const guest = newGuest({ platform: 'pve', kind: tpl.kind, id: guestId, name: tpl.name, image: 'template', vcpu: 2, memoryMb: 2048, running: false });
    const config = configOf(c, server, guest)!;
    return { guest, config, template: tpl };
  }
  const t = manageGuest(c, server, guestId, admin);
  if ('status' in t) return t;
  return { guest: t.guest, config: t.config, template: null };
}

const runningState = (c: Ctx, server: string, g: Guest): boolean => {
  const o = c.st.guestOverrides.get(`${server}|${g.id}`);
  const s = o?.state ?? g.state;
  return s === 'running' || s === 'unhealthy' || s === 'paused';
};

/** Register a guest made by a task (create, clone, restore) with its configuration. */
function addGuest(c: Ctx, server: string, g: Guest, config: ConfigRec): void {
  const key = `${server}/${g.id}`;
  createdGuests(c.st).set(key, g);
  manageState(c.st).configs.set(key, config);
  deleted(c.st).delete(key);
}

const NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// ---------------------------------------------------------------- backups

function seedBackups(server: string, g: Guest, cfg: ConfigRec): BackupVolume[] {
  const n = g.id.split(':')[1] ?? '';
  const vm = g.kind === 'vm';
  const size = (cfg.values.scsi0 ?? cfg.values.rootfs ?? '').match(/size=(\d+)G/)?.[1];
  const bytes = Math.round(Number(size ?? 16) * GiB * (vm ? 0.31 : 0.22));
  if (server !== 'shale') return [];
  return [
    { volume: `pbs-01:backup/${vm ? 'vm' : 'ct'}/${n}/2026-10-11T00:10:00Z`, storage: 'pbs-01', guest: n, kind: g.kind === 'vm' ? 'vm' : 'container', size_bytes: bytes, created: '2026-10-11T00:10:00Z', format: vm ? 'pbs-vm' : 'pbs-ct', notes: g.name, verified: 'ok' },
    { volume: `pbs-01:backup/${vm ? 'vm' : 'ct'}/${n}/2026-10-10T00:10:00Z`, storage: 'pbs-01', guest: n, kind: g.kind === 'vm' ? 'vm' : 'container', size_bytes: bytes - 41 * 1024 ** 2, created: '2026-10-10T00:10:00Z', format: vm ? 'pbs-vm' : 'pbs-ct', notes: g.name, verified: '' },
    {
      volume: `local:backup/vzdump-${vm ? 'qemu' : 'lxc'}-${n}-2026_10_04-02_00_00.${vm ? 'vma' : 'tar'}.zst`,
      storage: 'local',
      guest: n,
      kind: g.kind === 'vm' ? 'vm' : 'container',
      size_bytes: Math.round(bytes * 0.8),
      created: '2026-10-04T02:00:00Z',
      format: vm ? 'vma.zst' : 'tar.zst',
      notes: 'before the upgrade',
      protected: true,
    },
  ];
}

function backupsOf(c: Ctx, server: string, g: Guest, cfg: ConfigRec): BackupVolume[] {
  const s = lc(c.st);
  const key = `${server}/${g.id}`;
  let l = s.backups.get(key);
  if (!l) {
    l = seedBackups(server, g, cfg);
    s.backups.set(key, l);
  }
  return l;
}

function findBackup(c: Ctx, server: string, volume: string): { list: BackupVolume[]; b: BackupVolume; key: string } | null {
  for (const [key, list] of lc(c.st).backups) {
    if (!key.startsWith(`${server}/`)) continue;
    const b = list.find((x) => x.volume === volume);
    if (b) return { list, b, key };
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (ms: number, sep: string, mid: string) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${sep}${pad(d.getUTCMonth() + 1)}${sep}${pad(d.getUTCDate())}${mid}${pad(d.getUTCHours())}${sep === '-' ? ':' : '_'}${pad(d.getUTCMinutes())}${sep === '-' ? ':' : '_'}${pad(d.getUTCSeconds())}`;
};

// ---------------------------------------------------------------- content

const APPLIANCES: Appliance[] = [
  { template: 'debian-13-standard_13.1-1_amd64.tar.zst', package: 'debian-13-standard', headline: 'Debian 13 (standard)', description: 'A small Debian Trixie system including all standard packages.', os: 'debian-13', version: '13.1-1', section: 'system' },
  { template: 'debian-12-standard_12.12-1_amd64.tar.zst', package: 'debian-12-standard', headline: 'Debian 12 (standard)', description: 'A small Debian Bookworm system including all standard packages.', os: 'debian-12', version: '12.12-1', section: 'system' },
  { template: 'ubuntu-24.04-standard_24.04-2_amd64.tar.zst', package: 'ubuntu-24.04-standard', headline: 'Ubuntu 24.04 (standard)', description: 'A small Ubuntu 24.04 Noble Numbat system including all standard packages.', os: 'ubuntu-24.04', version: '24.04-2', section: 'system' },
  { template: 'alpine-3.22-default_20250617_amd64.tar.xz', package: 'alpine-3.22-default', headline: 'Alpine Linux 3.22', description: 'A small Alpine Linux system.', os: 'alpine', version: '20250617', section: 'system' },
  { template: 'archlinux-base_20250901-1_amd64.tar.zst', package: 'archlinux-base', headline: 'Arch Linux base', description: 'Arch Linux base image.', os: 'archlinux', version: '20250901-1', section: 'system' },
  { template: 'fedora-42-default_20250428_amd64.tar.xz', package: 'fedora-42-default', headline: 'Fedora 42', description: 'A small Fedora 42 system.', os: 'fedora', version: '20250428', section: 'system' },
  { template: 'rockylinux-9-default_20240912_amd64.tar.xz', package: 'rockylinux-9-default', headline: 'Rocky Linux 9', description: 'A small Rocky Linux 9 system.', os: 'rockylinux', version: '20240912', section: 'system' },
  { template: 'debian-12-turnkey-nextcloud_18.1-1_amd64.tar.gz', package: 'turnkey-nextcloud', headline: 'TurnKey Nextcloud', description: 'Store, sync and share files.', os: 'debian-12', version: '18.1-1', section: 'turnkeylinux' },
  { template: 'debian-12-turnkey-wordpress_18.2-1_amd64.tar.gz', package: 'turnkey-wordpress', headline: 'TurnKey WordPress', description: 'Blog publishing platform and CMS.', os: 'debian-12', version: '18.2-1', section: 'turnkeylinux' },
  { template: 'debian-12-turnkey-gitea_18.0-1_amd64.tar.gz', package: 'turnkey-gitea', headline: 'TurnKey Gitea', description: 'Lightweight self-hosted Git service.', os: 'debian-12', version: '18.0-1', section: 'turnkeylinux' },
  { template: 'proxmox-mail-gateway-8.2-standard_8.2-1_amd64.tar.zst', package: 'proxmox-mailgateway-8.2', headline: 'Proxmox Mail Gateway 8.2', description: 'Mail gateway with antispam and antivirus.', os: 'debian-12', version: '8.2-1', section: 'mail' },
];

const CONTENT_EXT: Record<StorageVolume['content'], RegExp> = {
  iso: /\.(iso|img)$/i,
  vztmpl: /\.tar\.(gz|xz|zst)$/i,
  import: /\.(ova|ovf|qcow2|vmdk|raw|img)$/i,
};

function contentOf(c: Ctx, server: string, storage: string, content: StorageVolume['content']): StorageVolume[] {
  const ch = choicesFor(c, server, 'pve');
  const gone = deleted(c.st);
  const all = content === 'iso' ? (ch.isos ?? []) : content === 'vztmpl' ? (ch.ct_templates ?? []) : lc(c.st).imports.filter((v) => !gone.has(v.volume));
  return all.filter((v) => v.storage === storage);
}

/** Add a downloaded file to the storage's content (where choicesFor finds ISO images and templates). */
function addContent(c: Ctx, v: StorageVolume): void {
  deleted(c.st).delete(v.volume);
  const l = v.content === 'iso' ? extraList<StorageVolume>(c.st, 'isos') : v.content === 'vztmpl' ? extraList<StorageVolume>(c.st, 'ct_templates') : lc(c.st).imports;
  if (!l.some((x) => x.volume === v.volume)) l.push(v);
}

// ---------------------------------------------------------------- firewall

const FW_OPTIONS = new Set(['enable', 'dhcp', 'ndp', 'radv', 'macfilter', 'ipfilter', 'policy_in', 'policy_out', 'log_level_in', 'log_level_out']);
const FW_GROUPS = ['monitoring', 'webservers'];

function firewallOf(c: Ctx, server: string, g: Guest) {
  const s = lc(c.st);
  const key = `${server}/${g.id}`;
  let fw = s.firewall.get(key);
  if (!fw) {
    const web = /nginx|proxy|gitlab|grafana/.test(g.name);
    fw = {
      options: { enable: '1', policy_in: 'DROP', dhcp: '1' },
      rules: [
        { type: 'in', action: 'ACCEPT', enable: true, macro: 'SSH', source: '10.20.0.0/24', comment: 'admin LAN' },
        ...(web ? [{ type: 'in' as const, action: 'ACCEPT', enable: true, proto: 'tcp', dport: '443', comment: 'HTTPS' }] : []),
        { type: 'group', action: 'monitoring', enable: true },
        { type: 'in', action: 'DROP', enable: false, proto: 'icmp', log: 'info', comment: 'ping (off)' },
      ],
    };
    s.firewall.set(key, fw);
  }
  return fw;
}

const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

function firewallJson(fw: { options: Record<string, string>; rules: Omit<FirewallRule, 'pos'>[] }): GuestFirewall {
  return {
    options: { ...fw.options },
    options_digest: sha(fw.options),
    rules: fw.rules.map((r, pos) => ({ pos, ...r })),
    rules_digest: sha(fw.rules),
    groups: FW_GROUPS,
    // The datacenter firewall is off on shale (Proxmox's default): the guest's rules wait for it.
    cluster_enabled: false,
  };
}

/** A rule from the request (PVE's checks, briefly), or the field that is wrong. */
function ruleFrom(b: unknown): Omit<FirewallRule, 'pos'> | { field: string; message: string } {
  const r = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  const type = r.type;
  if (type !== 'in' && type !== 'out' && type !== 'group') return { field: 'type', message: 'type must be in, out or group' };
  const action = String(r.action ?? '');
  if (type === 'group' ? !FW_GROUPS.includes(action) : !['ACCEPT', 'DROP', 'REJECT'].includes(action))
    return { field: 'action', message: type === 'group' ? 'no such security group' : 'action must be ACCEPT, DROP or REJECT' };
  const port = (v: unknown) => v === undefined || v === '' || /^\d{1,5}([:,]\d{1,5})*$/.test(String(v));
  if (!port(r.dport)) return { field: 'dport', message: 'invalid port' };
  if (!port(r.sport)) return { field: 'sport', message: 'invalid port' };
  const out: Omit<FirewallRule, 'pos'> = { type, action, enable: r.enable !== false };
  for (const k of ['macro', 'proto', 'source', 'dest', 'sport', 'dport', 'iface', 'log', 'comment'] as const) {
    const v = r[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- routes

const G = String.raw`^\/servers\/([^/]+)\/guests\/([^/]+)`;
const S = String.raw`^\/servers\/([^/]+)`;

const PVE_ONLY: Refusal = { status: 501, code: 'unsupported', detail: 'Incus does not support this.' };

export const lifecycleRoutes: ManageRoute[] = [
  // ---- create, clone, template, delete
  {
    method: 'POST',
    re: new RegExp(`${S}\\/guests$`),
    handler: (c, [s]) => {
      const h = manageHost(c, decode(s), true);
      if ('status' in h) return refuse(h);
      const server = h.rec.id;
      const b = bodyObject(c.req);
      const platform = hostPlatform(c, server);
      const kind = b.kind === 'container' ? 'container' : 'vm';
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      const set = (b.set && typeof b.set === 'object' ? b.set : {}) as Record<string, string>;
      if (!name || !NAME_RE.test(name)) return invalid('The name is not valid.', { name: 'Use letters, digits, “-” and “.” (a DNS name).' });
      if (platform === 'incus') {
        const id = `incus:${name}`;
        if (findManagedGuest(c, server, id) && !deleted(c.st).has(`${server}/${id}`)) return problem(409, 'exists', `Instance ${name} already exists.`);
        const image = String(b.image ?? '');
        const ch = choicesFor(c, server, 'incus');
        const local = ch.images?.find((i) => i.fingerprint === image || i.aliases?.includes(image));
        if (!local && !/^images:[\w./-]+$/.test(image)) return invalid('Unknown image.', { image: 'Pick a local image or use images:<alias> (images.linuxcontainers.org).' });
        const alias = local?.aliases?.[0] ?? image.replace(/^images:/, '');
        const start = b.start === true;
        const mem = /^(\d+)(MiB|GiB)$/.exec(set['limits.memory'] ?? '');
        const memoryMb = mem ? Number(mem[1]) * (mem[2] === 'GiB' ? 1024 : 1) : 1024;
        const task = runTask(c, 'guest.create', {
          server,
          type: 'create',
          guest: id,
          durationMs: 3500,
          lines: [`Creating ${name}`, `Retrieving image: ${alias}`, 'Unpacking image: 100%', start ? `Starting ${name}` : `Created ${name}`],
          onDone: () => {
            const g = newGuest({ platform: 'incus', kind, id, name, image: alias, vcpu: Number(set['limits.cpu'] ?? 1) || 1, memoryMb, running: start });
            const values: Record<string, string> = { ...set, 'image.os': alias.split('/')[0] ?? '', 'image.release': alias.split('/')[1] ?? '' };
            if (!Object.keys(values).some((k) => k.startsWith('device.root'))) values['device.root'] = 'type=disk,path=/,pool=default';
            addGuest(c, server, g, { platform: 'incus', kind, values, pending: {}, pendingDelete: [], inherited: [], profiles: Array.isArray(b.profiles) ? (b.profiles as string[]) : ['default'] });
          },
        });
        auditManage(c, server, id, { op: 'guest.create', name, task: task.id });
        return accepted(task, { new_id: id });
      }
      const ch = choicesFor(c, server, 'pve');
      const vmid = typeof b.new_id === 'number' && b.new_id > 0 ? b.new_id : (ch.next_id ?? 100);
      if (vmid < 100 || vmid > 999_999_999) return invalid('Invalid VM ID.', { new_id: 'Use an ID from 100 to 999999999.' });
      if (vmidTaken(c, server, vmid)) return problem(409, 'exists', `VM ${vmid} already exists.`);
      const storageWith = (content: string) => (key: string) => {
        const st = (set[key] ?? '').split(',')[0]?.split(':')[0] ?? '';
        return ch.storages.some((x) => x.id === st && x.content.includes(content));
      };
      if (kind === 'vm') {
        const disk = Object.keys(set).find((k) => /^(scsi|virtio|sata|ide)\d+$/.test(k) && !set[k]!.includes('media=cdrom'));
        if (disk && !storageWith('images')(disk)) return invalid('Parameter verification failed.', { [disk]: 'storage does not hold VM disks' });
        const cd = Object.entries(set).find(([, v]) => v.includes('media=cdrom'));
        if (cd && cd[1].split(',')[0] !== 'none' && !(ch.isos ?? []).some((i) => i.volume === cd[1].split(',')[0])) return invalid('Parameter verification failed.', { [cd[0]]: 'no such ISO image' });
      } else {
        if (!(ch.ct_templates ?? []).some((t) => t.volume === set.ostemplate)) return invalid('Parameter verification failed.', { ostemplate: 'no such template' });
        if (set.unprivileged !== undefined && set.unprivileged !== '1') return problem(403, 'not_allowed', 'Rackoon creates unprivileged containers only.');
        if (set.rootfs && !storageWith('rootdir')('rootfs')) return invalid('Parameter verification failed.', { rootfs: 'storage does not hold container volumes' });
      }
      const id = `pve:${vmid}`;
      const start = b.start === true;
      const values = allocate({ ...set }, vmid, kind);
      delete values.password;
      delete values['ssh-public-keys'];
      delete values.ostemplate;
      if (kind === 'vm') values.name = name;
      else Object.assign(values, { hostname: name, unprivileged: '1', arch: 'amd64', ostype: templateImage(set.ostemplate ?? '').split(' ')[0] ?? 'debian' });
      const disks = Object.entries(values).filter(([k, v]) => DISK_KEY.test(k) && !v.includes('media=cdrom'));
      const lines =
        kind === 'vm'
          ? [...disks.map(([k, v]) => `${k}: successfully created disk '${v}'`), ...(start ? [`start VM ${vmid}`] : [])]
          : [
              `extracting archive '${set.ostemplate ?? ''}'`,
              'Total bytes read: 524288000 (500MiB, 210MiB/s)',
              'Detected container architecture: amd64',
              `Creating SSH host key 'ssh_host_ed25519_key' - this may take some time ...`,
              ...(start ? [`starting CT ${vmid}`] : []),
            ];
      const task = runTask(c, 'guest.create', {
        server,
        type: kind === 'vm' ? 'qmcreate' : 'vzcreate',
        guest: id,
        durationMs: 3500,
        lines,
        onDone: () => {
          const image = kind === 'vm' ? osLabel(values) : templateImage(set.ostemplate ?? '');
          const g = newGuest({ platform: 'pve', kind, id, name, image, vcpu: Number(values.cores ?? 1) * Number(values.sockets ?? 1), memoryMb: Number(values.memory ?? 512), running: start });
          addGuest(c, server, g, { platform: 'pve', kind, values, pending: {}, pendingDelete: [], inherited: [], profiles: [] });
        },
      });
      auditManage(c, server, id, { op: 'guest.create', new_id: id, name, task: task.id });
      return accepted(task, { new_id: id });
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${G}\\/clone$`),
    handler: (c, [s, gid]) => {
      const server = decode(s);
      const t = guestOrTemplate(c, server, decode(gid), true);
      if ('status' in t) return refuse(t);
      const b = bodyObject(c.req);
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : `${t.guest.name}-clone`;
      if (!NAME_RE.test(name)) return invalid('The name is not valid.', { name: 'Use letters, digits, “-” and “.” (a DNS name).' });
      if (t.config.platform === 'incus') {
        const id = `incus:${name}`;
        if (findManagedGuest(c, server, id)) return problem(409, 'exists', `Instance ${name} already exists.`);
        const src = t;
        const task = runTask(c, 'guest.clone', {
          server,
          type: 'copy',
          guest: id,
          durationMs: 3000,
          lines: [`Copying ${src.guest.name} to ${name}`, `Created ${name}`],
          onDone: () => addGuest(c, server, { ...newGuest({ platform: 'incus', kind: src.config.kind, id, name, image: src.guest.image, vcpu: src.guest.vcpu ?? 1, memoryMb: src.guest.memory_limit_mb ?? 1024, running: false }) }, { ...src.config, values: { ...src.config.values } }),
        });
        auditManage(c, server, t.guest.id, { op: 'guest.clone', new_id: id, name, task: task.id });
        return accepted(task, { new_id: id });
      }
      const full = b.full === true || !t.template;
      if (!t.template && b.full === false) return invalid('Linked clones need a template.', { full: 'Only templates can be cloned linked.' });
      const storage = typeof b.storage === 'string' && b.storage ? b.storage : undefined;
      if (storage && !full) return invalid('A storage applies to full clones only.', { storage: 'Only for full clones.' });
      if (storage && !choicesFor(c, server, 'pve').storages.some((x) => x.id === storage && x.content.includes(t.config.kind === 'vm' ? 'images' : 'rootdir')))
        return invalid('Parameter verification failed.', { storage: 'storage does not hold guest disks' });
      const vmid = typeof b.new_id === 'number' && b.new_id > 0 ? b.new_id : (choicesFor(c, server, 'pve').next_id ?? 100);
      if (vmidTaken(c, server, vmid)) return problem(409, 'exists', `VM ${vmid} already exists.`);
      const from = t.guest.id.split(':')[1] ?? '';
      const id = `pve:${vmid}`;
      const src = t;
      const vm = t.config.kind === 'vm';
      const task = runTask(c, 'guest.clone', {
        server,
        type: vm ? 'qmclone' : 'vzclone',
        guest: t.guest.id,
        durationMs: full ? 5000 : 2500,
        lines: full
          ? [`create full clone of drive scsi0 (${src.config.values.scsi0?.split(',')[0] ?? src.config.values.rootfs?.split(',')[0] ?? ''})`, 'transferred 4.0 GiB of 32.0 GiB (12.50%)', 'transferred 16.0 GiB of 32.0 GiB (50.00%)', 'transferred 32.0 GiB of 32.0 GiB (100.00%)']
          : [`create linked clone of drive scsi0 (${src.config.values.scsi0?.split(',')[0] ?? ''})`, `clone ${from} -> ${vmid}: done`],
        onDone: () => {
          const config = copyConfig(src.config, from, String(vmid), storage);
          if (vm) config.values.name = name;
          else config.values.hostname = name;
          const g = newGuest({ platform: 'pve', kind: src.config.kind, id, name, image: src.template ? osLabel(config.values) : src.guest.image, vcpu: Number(config.values.cores ?? 1), memoryMb: Number(config.values.memory ?? 1024), running: false });
          addGuest(c, server, g, config);
        },
      });
      auditManage(c, server, t.guest.id, { op: 'guest.clone', new_id: id, name, task: task.id });
      return accepted(task, { new_id: id });
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${G}\\/template$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid), true);
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve') return refuse(PVE_ONLY);
      if (bodyObject(c.req).confirm !== true) return problem(400, 'confirm_required', 'Converting to a template cannot be undone: send "confirm": true.');
      if (runningState(c, t.rec.id, t.guest)) return problem(409, 'guest_running', 'Shut the guest down first.');
      const server = t.rec.id;
      const g = t.guest;
      const vm = g.kind === 'vm';
      const task = runTask(c, 'guest.template', {
        server,
        type: vm ? 'qmtemplate' : 'vztemplate',
        guest: g.id,
        durationMs: 2000,
        lines: vm ? [`renaming disk images of VM ${g.vmid}`, 'converting to template'] : ['converting container to template'],
        onDone: () => {
          templated(c.st).add(`${server}/${g.id}`);
          createdGuests(c.st).delete(`${server}/${g.id}`);
          extraList<TemplateGuest>(c.st, 'templates').push({ id: g.id.split(':')[1] ?? '', name: g.name, kind: vm ? 'vm' : 'container', node: server, disk_bytes: 8 * GiB });
        },
      });
      auditManage(c, server, g.id, { op: 'guest.template', task: task.id });
      return accepted(task);
    },
  },
  {
    method: 'DELETE',
    re: new RegExp(`${G}$`),
    handler: (c, [s, gid]) => {
      const server = decode(s);
      const t = guestOrTemplate(c, server, decode(gid), true);
      if ('status' in t) return refuse(t);
      const g = t.guest;
      if ((c.req.query.get('confirm_name') ?? '') !== g.name) return problem(400, 'confirm_required', `Type the guest's name (${g.name}) to delete it.`);
      if (!t.template && runningState(c, server, g)) return problem(409, 'guest_running', 'Stop the guest first.');
      if (t.config.values.protection === '1' || t.config.values['security.protection.delete'] === 'true') return problem(409, 'protected', 'The guest is protected: turn protection off first.');
      const vm = g.kind === 'vm';
      const purge = c.req.query.get('purge') === '1';
      const task = runTask(c, 'guest.delete', {
        server,
        type: t.config.platform === 'incus' ? 'delete' : vm ? 'qmdestroy' : 'vzdestroy',
        guest: g.id,
        durationMs: 2500,
        lines: t.config.platform === 'incus' ? [`Deleting ${g.name}`] : [...Object.values(t.config.values).filter((v) => /:(vm|subvol|base)-\d+-disk/.test(v)).map((v) => `Removing image: 100% complete...done. (${v.split(',')[0]})`), ...(purge ? [`purging VM ${g.id.split(':')[1]} from related configurations..`] : [])],
        onDone: () => {
          deleted(c.st).add(`${server}/${g.id}`);
          createdGuests(c.st).delete(`${server}/${g.id}`);
        },
      });
      auditManage(c, server, g.id, { op: 'guest.delete', name: g.name, task: task.id });
      return accepted(task);
    },
  },

  // ---- backups
  {
    method: 'GET',
    re: new RegExp(`${G}\\/backups$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve') return refuse(PVE_ONLY);
      const items = [...backupsOf(c, t.rec.id, t.guest, t.config)].sort((a, b) => Date.parse(b.created ?? '') - Date.parse(a.created ?? ''));
      return json(200, { items });
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${G}\\/backups$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve') return refuse(PVE_ONLY);
      const b = bodyObject(c.req);
      const storage = String(b.storage ?? '');
      const st = choicesFor(c, t.rec.id, 'pve').storages.find((x) => x.id === storage);
      if (!st?.content.includes('backup')) return invalid('Parameter verification failed.', { storage: 'storage does not hold backups' });
      const mode = b.mode === 'suspend' || b.mode === 'stop' ? b.mode : 'snapshot';
      const compress = typeof b.compress === 'string' ? b.compress : 'zstd';
      const g = t.guest;
      const n = g.id.split(':')[1] ?? '';
      const vm = g.kind === 'vm';
      const s2 = lc(c.st);
      const at = c.store.fxNow() + ++s2.made * 1000;
      const pbs = st.type === 'pbs';
      const ext = { zstd: '.zst', lzo: '.lzo', gzip: '.gz', none: '' }[compress] ?? '.zst';
      const volume = pbs ? `${storage}:backup/${vm ? 'vm' : 'ct'}/${n}/${iso(at)}` : `${storage}:backup/vzdump-${vm ? 'qemu' : 'lxc'}-${n}-${stamp(at, '_', '-')}.${vm ? 'vma' : 'tar'}${ext}`;
      const list = backupsOf(c, t.rec.id, g, t.config);
      const notes = typeof b.notes === 'string' && b.notes ? b.notes.replaceAll('{{guestname}}', g.name) : g.name;
      const task = runTask(c, 'backup.create', {
        server: t.rec.id,
        type: 'vzdump',
        guest: g.id,
        durationMs: 8000,
        lines: [
          `INFO: starting new backup job: vzdump ${n} --storage ${storage} --mode ${mode}${pbs ? '' : ` --compress ${compress}`} --node ${t.rec.id} --remove 0`,
          `INFO: Starting Backup of VM ${n} (${vm ? 'qemu' : 'lxc'})`,
          `INFO: Backup started at ${stamp(at, '-', ' ')}`,
          `INFO: status = ${runningState(c, t.rec.id, g) ? 'running' : 'stopped'}`,
          `INFO: backup mode: ${mode}`,
          `INFO: ${vm ? 'VM' : 'CT'} Name: ${g.name}`,
          pbs ? `INFO: creating Proxmox Backup Server archive '${vm ? 'vm' : 'ct'}/${n}/${iso(at)}'` : `INFO: creating vzdump archive '/var/lib/vz/dump/${volume.split('/').pop() ?? ''}'`,
          'INFO:  12% (3.8 GiB of 32.0 GiB) in 3s, read: 1.3 GiB/s, write: 96.0 MiB/s',
          'INFO:  47% (15.0 GiB of 32.0 GiB) in 9s, read: 1.9 GiB/s, write: 102.4 MiB/s',
          'INFO: 100% (32.0 GiB of 32.0 GiB) in 17s, read: 2.0 GiB/s, write: 88.0 MiB/s',
          `INFO: transferred 32.00 GiB in 17 seconds (1.9 GiB/s)`,
          `INFO: Finished Backup of VM ${n} (00:00:18)`,
          'INFO: Backup job finished successfully',
        ],
        onDone: () => {
          list.push({ volume, storage, guest: n, kind: vm ? 'vm' : 'container', size_bytes: Math.round(9.4 * GiB), created: iso(at), format: pbs ? (vm ? 'pbs-vm' : 'pbs-ct') : `${vm ? 'vma' : 'tar'}${ext}`, notes, protected: b.protected === true });
        },
      });
      auditManage(c, t.rec.id, g.id, { op: 'backup.create', storage, task: task.id });
      return accepted(task);
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${S}\\/backups\\/restore$`),
    handler: (c, [s]) => {
      const h = manageHost(c, decode(s), true);
      if ('status' in h) return refuse(h);
      const server = h.rec.id;
      const b = bodyObject(c.req);
      const volume = String(b.volume ?? '');
      const found = findBackup(c, server, volume);
      if (!found) return invalid('No such backup.', { volume: 'not a backup volume of this host' });
      const vm = found.b.kind !== 'container';
      const srcId = `pve:${found.b.guest ?? ''}`;
      const src = findManagedGuest(c, server, srcId);
      const srcConfig = src ? configOf(c, server, src) : null;
      const storage = typeof b.storage === 'string' && b.storage ? b.storage : undefined;
      const start = b.start === true;
      if (typeof b.guest === 'string' && b.guest) {
        const target = findManagedGuest(c, server, b.guest);
        if (!target) return problem(404, 'guest_not_found', 'No such guest on this server.');
        if (b.confirm !== true) return problem(400, 'confirm_required', 'Restoring over a guest replaces its disks: send "confirm": true.');
        if (runningState(c, server, target)) return problem(409, 'guest_running', 'Stop the guest first.');
        const task = runTask(c, 'backup.restore', {
          server,
          type: vm ? 'qmrestore' : 'vzrestore',
          guest: target.id,
          durationMs: 4000,
          lines: [`restore ${vm ? 'vma' : 'tar'} archive: ${volume}`, 'progress 25% (read 8 GiB)', 'progress 75% (read 24 GiB)', 'progress 100% (read 32 GiB)', 'rescan volumes...'],
        });
        auditManage(c, server, target.id, { op: 'backup.restore', volume, task: task.id });
        return accepted(task);
      }
      const ch = choicesFor(c, server, 'pve');
      const vmid = typeof b.new_id === 'number' && b.new_id > 0 ? b.new_id : (ch.next_id ?? 100);
      if (vmidTaken(c, server, vmid)) return problem(409, 'exists', `VM ${vmid} already exists.`);
      if (storage && !ch.storages.some((x) => x.id === storage && x.content.includes(vm ? 'images' : 'rootdir'))) return invalid('Parameter verification failed.', { storage: 'storage does not hold guest disks' });
      const id = `pve:${vmid}`;
      const task = runTask(c, 'backup.restore', {
        server,
        type: vm ? 'qmrestore' : 'vzrestore',
        guest: id,
        durationMs: 4000,
        lines: [`restore ${vm ? 'vma' : 'tar'} archive: ${volume}`, `new volume ID is '${storage ?? 'local-zfs'}:${vm ? 'vm' : 'subvol'}-${vmid}-disk-0'`, 'progress 50% (read 16 GiB)', 'progress 100% (read 32 GiB)', ...(start ? [`start ${vm ? 'VM' : 'CT'} ${vmid}`] : [])],
        onDone: () => {
          const base: ConfigRec = srcConfig ?? { platform: 'pve', kind: vm ? 'vm' : 'container', values: { memory: '2048', cores: '2' }, pending: {}, pendingDelete: [], inherited: [], profiles: [] };
          const config = copyConfig(base, found.b.guest ?? '', String(vmid), storage);
          const name = src?.name ?? `restored-${vmid}`;
          const g = newGuest({ platform: 'pve', kind: vm ? 'vm' : 'container', id, name, image: src?.image ?? (vm ? 'Linux' : 'debian'), vcpu: Number(config.values.cores ?? 1), memoryMb: Number(config.values.memory ?? 1024), running: start });
          addGuest(c, server, g, config);
        },
      });
      auditManage(c, server, srcId, { op: 'backup.restore', volume, new_id: id, task: task.id });
      return accepted(task, { new_id: id });
    },
  },
  {
    method: 'PATCH',
    re: new RegExp(`${S}\\/backups$`),
    handler: (c, [s]) => {
      const h = manageHost(c, decode(s));
      if ('status' in h) return refuse(h);
      const b = bodyObject(c.req);
      const found = findBackup(c, h.rec.id, String(b.volume ?? ''));
      if (!found) return problem(404, 'not_found', 'No such backup.');
      if (typeof b.notes === 'string') found.b.notes = b.notes;
      if (typeof b.protected === 'boolean') found.b.protected = b.protected || undefined;
      auditManage(c, h.rec.id, `pve:${found.b.guest ?? ''}`, { op: 'backup.update', volume: found.b.volume });
      return ok();
    },
  },
  {
    method: 'DELETE',
    re: new RegExp(`${S}\\/backups$`),
    handler: (c, [s]) => {
      const h = manageHost(c, decode(s), true);
      if ('status' in h) return refuse(h);
      const found = findBackup(c, h.rec.id, c.req.query.get('volume') ?? '');
      if (!found) return problem(404, 'not_found', 'No such backup.');
      if (found.b.protected) return problem(409, 'protected', 'The backup is protected: remove the protection first.');
      found.list.splice(found.list.indexOf(found.b), 1);
      auditManage(c, h.rec.id, `pve:${found.b.guest ?? ''}`, { op: 'backup.delete', volume: found.b.volume });
      return ok();
    },
  },

  // ---- storage content and appliances
  {
    method: 'GET',
    re: new RegExp(`${S}\\/storage\\/([^/]+)\\/content$`),
    handler: (c, [s, sto]) => {
      const h = manageHost(c, decode(s));
      if ('status' in h) return refuse(h);
      if (hostPlatform(c, h.rec.id) !== 'pve') return refuse(PVE_ONLY);
      const storage = decode(sto);
      const content = c.req.query.get('content') as StorageVolume['content'] | null;
      if (content !== 'iso' && content !== 'vztmpl' && content !== 'import') return invalid('Unknown content type.', { content: 'iso, vztmpl or import' });
      if (!choicesFor(c, h.rec.id, 'pve').storages.some((x) => x.id === storage && x.content.includes(content))) return problem(404, 'not_found', `${storage} holds no ${content} content.`);
      return json(200, { items: contentOf(c, h.rec.id, storage, content) });
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${S}\\/storage\\/([^/]+)\\/download$`),
    handler: (c, [s, sto]) => {
      const h = manageHost(c, decode(s), true);
      if ('status' in h) return refuse(h);
      const server = h.rec.id;
      const storage = decode(sto);
      const b = bodyObject(c.req);
      const content = b.content as StorageVolume['content'];
      const ch = choicesFor(c, server, 'pve');
      if (!ch.download) return problem(403, 'not_allowed', 'Downloads need PVE 8.3 or later.');
      if (!ch.storages.some((x) => x.id === storage && x.content.includes(content))) return invalid('Parameter verification failed.', { storage: `storage does not hold ${String(content)}` });
      const url = String(b.url ?? '');
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return invalid('Invalid URL.', { url: 'Use an http:// or https:// address without credentials.' });
      const filename = String(b.filename ?? '');
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(filename) || !CONTENT_EXT[content]?.test(filename)) return invalid('Invalid file name.', { filename: content === 'iso' ? 'Use letters, digits, “.”, “_” and “-”, ending in .iso or .img.' : 'Use letters, digits, “.”, “_” and “-” with the right extension.' });
      const algo = typeof b.checksum_algorithm === 'string' ? b.checksum_algorithm : '';
      const sum = typeof b.checksum === 'string' ? b.checksum.trim() : '';
      if (sum && !/^[0-9a-fA-F]{32,128}$/.test(sum)) return invalid('Invalid checksum.', { checksum: 'Use the hexadecimal checksum.' });
      const volume = `${storage}:${content}/${filename}`;
      if (contentOf(c, server, storage, content).some((v) => v.volume === volume)) return problem(409, 'exists', `${filename} already exists on ${storage}.`);
      const dir = { iso: 'template/iso', vztmpl: 'template/cache', import: 'import' }[content];
      const task = runTask(c, 'content.download', {
        server,
        type: 'download',
        durationMs: 6000,
        lines: [
          `downloading ${url} to /var/lib/vz/${dir}/${filename}.tmp.48213`,
          `--${stamp(c.store.fxNow(), '-', ' ')}--  ${url}`,
          `Resolving ${parsed.hostname}... 151.101.2.132`,
          `Connecting to ${parsed.hostname}|151.101.2.132|:443... connected.`,
          'HTTP request sent, awaiting response... 200 OK',
          'Length: 789577728 (753M) [application/x-iso9660-image]',
          '     0K ........ ........ ........ ........  12% 52.1M 13s',
          '196608K ........ ........ ........ ........  38% 61.4M 8s',
          '393216K ........ ........ ........ ........  64% 70.0M 4s',
          '589824K ........ ........ ........ ........ 100% 66.3M=11s',
          ...(sum ? [`calculating checksum of '/var/lib/vz/${dir}/${filename}.tmp.48213'...`, `checksum verified`] : []),
          `download of '${url}' to '/var/lib/vz/${dir}/${filename}' finished`,
        ],
        onDone: () => addContent(c, { volume, storage, content, name: filename, size_bytes: 789577728, created: iso(c.store.fxNow()) }),
      });
      auditManage(c, server, null, { op: 'content.download', storage, url, ...(algo ? { checksum_algorithm: algo } : {}), task: task.id });
      return accepted(task);
    },
  },
  {
    method: 'DELETE',
    re: new RegExp(`${S}\\/storage\\/content$`),
    handler: (c, [s]) => {
      const h = manageHost(c, decode(s), true);
      if ('status' in h) return refuse(h);
      const volume = c.req.query.get('volume') ?? '';
      const [storage = '', rest = ''] = volume.split(':');
      const content = rest.split('/')[0] as StorageVolume['content'];
      if (!['iso', 'vztmpl', 'import'].includes(content) || !contentOf(c, h.rec.id, storage, content).some((v) => v.volume === volume))
        return problem(404, 'not_found', 'No such ISO image, template or import file.');
      deleted(c.st).add(volume);
      auditManage(c, h.rec.id, null, { op: 'content.delete', volume });
      return ok();
    },
  },
  {
    method: 'GET',
    re: new RegExp(`${S}\\/appliances$`),
    handler: (c, [s]) => {
      const h = manageHost(c, decode(s));
      if ('status' in h) return refuse(h);
      if (hostPlatform(c, h.rec.id) !== 'pve') return refuse(PVE_ONLY);
      return json(200, { items: APPLIANCES });
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${S}\\/storage\\/([^/]+)\\/appliances$`),
    handler: (c, [s, sto]) => {
      const h = manageHost(c, decode(s), true);
      if ('status' in h) return refuse(h);
      const server = h.rec.id;
      const storage = decode(sto);
      if (!choicesFor(c, server, 'pve').storages.some((x) => x.id === storage && x.content.includes('vztmpl'))) return invalid('Parameter verification failed.', { storage: 'storage does not hold container templates' });
      const tpl = APPLIANCES.find((a) => a.template === bodyObject(c.req).template);
      if (!tpl) return invalid('Unknown template.', { template: 'not in the appliance list' });
      const task = runTask(c, 'appliance.download', {
        server,
        type: 'download',
        durationMs: 4000,
        lines: [`starting template download from: http://download.proxmox.com/images/system/${tpl.template}`, `target file: /var/lib/vz/template/cache/${tpl.template}`, '52% 80.2M 1s', '100% 92.0M=2.1s', `download of 'http://download.proxmox.com/images/system/${tpl.template}' to '/var/lib/vz/template/cache/${tpl.template}' finished`],
        onDone: () => addContent(c, { volume: `${storage}:vztmpl/${tpl.template}`, storage, content: 'vztmpl', name: tpl.template, size_bytes: 128 * 1024 ** 2, created: iso(c.store.fxNow()) }),
      });
      auditManage(c, server, null, { op: 'appliance.download', storage, name: tpl.template, task: task.id });
      return accepted(task);
    },
  },

  // ---- firewall
  {
    method: 'GET',
    re: new RegExp(`${G}\\/firewall$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve') return refuse(PVE_ONLY);
      return json(200, firewallJson(firewallOf(c, t.rec.id, t.guest)));
    },
  },
  {
    method: 'PUT',
    re: new RegExp(`${G}\\/firewall\\/options$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve') return refuse(PVE_ONLY);
      const fw = firewallOf(c, t.rec.id, t.guest);
      const b = bodyObject(c.req);
      if (typeof b.digest === 'string' && b.digest && b.digest !== sha(fw.options)) return problem(409, 'digest_mismatch', 'The firewall options changed meanwhile. Review them again.');
      const set = (b.set ?? {}) as Record<string, string>;
      const del = (Array.isArray(b.delete) ? b.delete : []) as string[];
      const bad = [...Object.keys(set), ...del].find((k) => !FW_OPTIONS.has(k));
      if (bad) return invalid('Parameter verification failed.', { [bad]: 'unknown option' });
      Object.assign(fw.options, set);
      for (const k of del) delete fw.options[k];
      auditManage(c, t.rec.id, t.guest.id, { op: 'firewall.options', changes: Object.entries(set).map(([k, v]) => `${k}: ${v}`).join('; ') });
      return ok();
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${G}\\/firewall\\/rules$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve') return refuse(PVE_ONLY);
      const fw = firewallOf(c, t.rec.id, t.guest);
      const raw = bodyObject(c.req).rule as Record<string, unknown> | undefined;
      const rule = ruleFrom(raw);
      if ('field' in rule) return invalid('Parameter verification failed.', { [rule.field]: rule.message });
      const pos = typeof raw?.pos === 'number' ? Math.max(0, Math.min(fw.rules.length, raw.pos)) : 0;
      fw.rules.splice(pos, 0, rule);
      auditManage(c, t.rec.id, t.guest.id, { op: 'firewall.rule_add' });
      return ok();
    },
  },
  {
    method: 'PUT',
    re: new RegExp(`${G}\\/firewall\\/rules\\/(\\d+)$`),
    handler: (c, [s, gid, p]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve') return refuse(PVE_ONLY);
      const fw = firewallOf(c, t.rec.id, t.guest);
      const b = bodyObject(c.req);
      const pos = Number(p);
      if (typeof b.digest === 'string' && b.digest && b.digest !== sha(fw.rules)) return problem(409, 'digest_mismatch', 'The rules changed meanwhile. Review them again.');
      if (pos >= fw.rules.length) return problem(404, 'not_found', `No rule at position ${pos}.`);
      if (b.rule !== undefined) {
        const rule = ruleFrom(b.rule);
        if ('field' in rule) return invalid('Parameter verification failed.', { [rule.field]: rule.message });
        fw.rules[pos] = rule;
      }
      if (typeof b.move_to === 'number') {
        const [r] = fw.rules.splice(pos, 1);
        fw.rules.splice(Math.max(0, Math.min(fw.rules.length, b.move_to)), 0, r!);
      }
      auditManage(c, t.rec.id, t.guest.id, { op: 'firewall.rule_update' });
      return ok();
    },
  },
  {
    method: 'DELETE',
    re: new RegExp(`${G}\\/firewall\\/rules\\/(\\d+)$`),
    handler: (c, [s, gid, p]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve') return refuse(PVE_ONLY);
      const fw = firewallOf(c, t.rec.id, t.guest);
      const digest = c.req.query.get('digest');
      if (digest && digest !== sha(fw.rules)) return problem(409, 'digest_mismatch', 'The rules changed meanwhile. Review them again.');
      const pos = Number(p);
      if (pos >= fw.rules.length) return problem(404, 'not_found', `No rule at position ${pos}.`);
      fw.rules.splice(pos, 1);
      auditManage(c, t.rec.id, t.guest.id, { op: 'firewall.rule_delete' });
      return ok();
    },
  },

  // ---- HA and replication (cluster)
  {
    method: 'PUT',
    re: new RegExp(`${G}\\/ha$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid), true);
      if ('status' in t) return refuse(t);
      if (t.config.platform !== 'pve' || !choicesFor(c, t.rec.id, 'pve').cluster) return refuse({ status: 501, code: 'unsupported', detail: 'HA needs a Proxmox cluster.' });
      const b = bodyObject(c.req) as Partial<HASettings>;
      if (!b.state || !['started', 'stopped', 'ignored', 'disabled'].includes(b.state)) return invalid('Parameter verification failed.', { state: 'state must be started, stopped, ignored or disabled' });
      const num = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 10 ? v : undefined);
      t.config.ha = { state: b.state, max_restart: num(b.max_restart) ?? 1, max_relocate: num(b.max_relocate) ?? 1, ...(b.comment ? { comment: b.comment } : {}), status: b.state === 'started' ? 'started' : b.state === 'stopped' ? 'stopped' : b.state };
      auditManage(c, t.rec.id, t.guest.id, { op: 'ha.set', changes: `state: ${b.state}` });
      return ok();
    },
  },
  {
    method: 'DELETE',
    re: new RegExp(`${G}\\/ha$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid), true);
      if ('status' in t) return refuse(t);
      if (!t.config.ha) return problem(404, 'not_found', 'The guest is not an HA resource.');
      t.config.ha = null;
      auditManage(c, t.rec.id, t.guest.id, { op: 'ha.remove' });
      return ok();
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${G}\\/replication$`),
    handler: (c, [s, gid]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      const ch = choicesFor(c, t.rec.id, 'pve');
      if (t.config.platform !== 'pve' || !ch.cluster) return refuse({ status: 501, code: 'unsupported', detail: 'Replication needs a Proxmox cluster.' });
      const b = bodyObject(c.req);
      const target = String(b.target ?? '');
      if (!(ch.nodes ?? []).includes(target)) return invalid('Parameter verification failed.', { target: 'not another node of this cluster' });
      const jobs = (t.config.replication ??= []);
      if (jobs.some((j) => j.target === target)) return problem(409, 'exists', `A job to ${target} exists already.`);
      const schedule = typeof b.schedule === 'string' && b.schedule.trim() ? b.schedule.trim() : '*/15';
      if (!/^[\w*/:,.\s-]{1,64}$/.test(schedule)) return invalid('Parameter verification failed.', { schedule: 'invalid calendar event' });
      const rate = typeof b.rate === 'string' && b.rate.trim() ? b.rate.trim() : undefined;
      if (rate && !/^\d+(\.\d+)?$/.test(rate)) return invalid('Parameter verification failed.', { rate: 'MB/s as a number' });
      const vmid = t.guest.id.split(':')[1] ?? '';
      let n = 0;
      while (jobs.some((j) => j.id === `${vmid}-${n}`)) n++;
      jobs.push({ id: `${vmid}-${n}`, target, schedule, ...(rate ? { rate } : {}), ...(typeof b.comment === 'string' && b.comment ? { comment: b.comment } : {}), last_sync: null });
      auditManage(c, t.rec.id, t.guest.id, { op: 'replication.add', changes: `target: ${target}` });
      return ok();
    },
  },
  {
    method: 'DELETE',
    re: new RegExp(`${G}\\/replication\\/([^/]+)$`),
    handler: (c, [s, gid, job]) => {
      const t = manageGuest(c, decode(s), decode(gid));
      if ('status' in t) return refuse(t);
      const jobs = t.config.replication ?? [];
      const i = jobs.findIndex((j) => j.id === decode(job));
      if (i < 0) return problem(404, 'not_found', 'No such replication job.');
      jobs.splice(i, 1);
      auditManage(c, t.rec.id, t.guest.id, { op: 'replication.delete', changes: `job: ${decode(job)}` });
      return ok();
    },
  },
];

