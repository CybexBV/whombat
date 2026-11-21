// Guest management in fixture mode (docs/MANAGE.md): per-browser
// configurations of shale's Proxmox guests and basalt's Incus instances,
// the choices the forms offer, and a task simulator whose log grows with
// the real clock. Routes for configuration, disks, choices and tasks live
// here; lifecycle routes (create, clone, backups, content, firewall, ...)
// in lifecycle.ts use the same state and helpers.

import { createHash } from 'node:crypto';
import type { Guest } from '../../src/api/types.ts';
import type { Choices, ConfigChange, GuestConfig, HAState, ManagePlatform, ReplicationJob, TaskStatus, TemplateGuest } from '../../src/api/manage-types.ts';
import { appendAudit } from './audit.ts';
import { findGuest } from './catalog.ts';
import { gen, round1 } from './gen.ts';
import type { Ctx } from './ctx.ts';
import { pushEvent } from './events.ts';
import { bodyObject, type FxResponse, json, problem } from './http.ts';
import { effectivePerms } from './remote.ts';
import { RANGE_STEPS } from './servers.ts';
import { type BrowserState, findServer, iso, randomHex, roleAtLeast, type ServerRec } from './state.ts';

/** A fixture route (same shape as api.ts's). */
export interface ManageRoute {
  method: string;
  re: RegExp;
  admin?: boolean;
  handler: (c: Ctx, params: string[]) => FxResponse;
}

export const decode = (s: string | undefined): string => decodeURIComponent(s ?? '');

// ---------------------------------------------------------------- state

export interface ConfigRec {
  platform: ManagePlatform;
  kind: 'vm' | 'container';
  /** Proxmox: names new volumes (vm-<vmid>-disk-<n>). */
  vmid?: number;
  values: Record<string, string>;
  pending: Record<string, string>;
  pendingDelete: string[];
  inherited: string[];
  profiles: string[];
  /** Proxmox cluster: HA resource and replication jobs (lifecycle.ts changes them). */
  ha?: HAState | null;
  replication?: ReplicationJob[];
}

export interface TaskRec {
  id: string;
  server: string;
  type: string;
  guest?: string;
  user: string;
  startedMs: number;
  durationMs: number;
  lines: string[];
  /** Ends with an error after its duration. */
  error?: string;
  stoppedMs?: number;
  /** Runs once, the first time the task is seen finished. */
  onDone?: () => void;
  done?: boolean;
}

export interface ManageState {
  /** "server/guestId" -> configuration. */
  configs: Map<string, ConfigRec>;
  tasks: Map<string, TaskRec>;
  nextId: number;
  /** Free-form state of lifecycle.ts (backups, content, firewall, created guests). */
  extra: Map<string, unknown>;
}

const states = new WeakMap<BrowserState, ManageState>();

export function manageState(st: BrowserState): ManageState {
  let m = states.get(st);
  if (!m) {
    m = { configs: new Map(), tasks: new Map(), nextId: 108, extra: new Map() };
    states.set(st, m);
  }
  return m;
}

const mac = (n: number): string => `BC:24:11:${(0x30 + (n % 0x40)).toString(16).toUpperCase()}:${((n * 7) % 256).toString(16).padStart(2, '0').toUpperCase()}:${((n * 13) % 256).toString(16).padStart(2, '0').toUpperCase()}`;

/** Seed configurations: hand-written for the interesting guests, derived from the report for the rest. */
function seedConfig(g: Guest): ConfigRec {
  const n = g.vmid ?? 0;
  const base = (platform: ManagePlatform, values: Record<string, string>, extra: Partial<ConfigRec> = {}): ConfigRec => ({
    platform,
    kind: g.kind === 'vm' ? 'vm' : 'container',
    values,
    pending: {},
    pendingDelete: [],
    inherited: [],
    profiles: [],
    ...(g.vmid ? { vmid: g.vmid } : {}),
    ...extra,
  });
  if (g.platform === 'incus') {
    const name = g.id.slice('incus:'.length);
    return base(
      'incus',
      {
        'limits.cpu': String(g.vcpu ?? 1),
        ...(g.memory_limit_mb ? { 'limits.memory': `${Math.round(g.memory_limit_mb / 1024)}GiB` } : {}),
        'boot.autostart': g.state === 'stopped' ? 'false' : 'true',
        'image.os': g.image.split('/')[0] ?? '',
        'image.release': g.image.split('/')[1] ?? '',
        ...(name === 'dev-shell' ? { 'security.nesting': 'true', 'raw.idmap': 'both 1000 1000' } : {}),
        'device.root': `type=disk,path=/,pool=default${g.kind === 'vm' ? ',size=40GiB' : ''}`,
        'device.eth0': 'type=nic,network=incusbr0,name=eth0',
      },
      { inherited: ['device.eth0', ...(g.kind === 'vm' ? [] : ['device.root'])], profiles: ['default'] },
    );
  }
  const common = { tags: '', onboot: g.state === 'stopped' ? '0' : '1' };
  if (g.kind === 'container') {
    const values: Record<string, string> = {
      arch: 'amd64',
      hostname: g.name,
      cores: String(g.vcpu ?? 1),
      memory: String(g.memory_limit_mb ?? 512),
      swap: '512',
      ostype: g.image.startsWith('alpine') ? 'alpine' : 'debian',
      rootfs: `local-zfs:subvol-${n}-disk-0,size=8G`,
      net0: `name=eth0,bridge=vmbr0,firewall=1,hwaddr=${mac(n)},ip=dhcp,type=veth`,
      unprivileged: '1',
      features: 'nesting=1',
      ...common,
    };
    if (n === 200) Object.assign(values, { tags: 'monitoring', description: 'Grafana for the lab.\nDashboards in /var/lib/grafana.' });
    if (n === 201) Object.assign(values, { tags: 'edge;web', mp0: 'vmdata:subvol-201-disk-1,mp=/data,size=20G' });
    if (n === 202) Object.assign(values, { tags: 'secrets', mp1: '/mnt/backup/vaultwarden,mp=/backup', 'lxc.cgroup2.devices.allow': 'c 10:200 rwm' });
    if (n === 203) Object.assign(values, { net0: `name=eth0,bridge=vmbr0,firewall=1,hwaddr=${mac(n)},ip=10.20.0.53/24,gw=10.20.0.1,type=veth`, nameserver: '1.1.1.1', searchdomain: 'lab.example' });
    return base('pve', values);
  }
  const values: Record<string, string> = {
    name: g.name,
    boot: 'order=scsi0;ide2;net0',
    cores: String(g.vcpu ?? 2),
    sockets: '1',
    cpu: 'x86-64-v2-AES',
    memory: String(g.memory_limit_mb ?? 4096),
    ostype: 'l26',
    scsihw: 'virtio-scsi-single',
    scsi0: `local-zfs:vm-${n}-disk-0,iothread=1,discard=on,size=64G`,
    ide2: 'none,media=cdrom',
    net0: `virtio=${mac(n)},bridge=vmbr0,firewall=1`,
    agent: '1',
    numa: '0',
    smbios1: `uuid=6f1c2a4e-0000-4000-8000-${String(n).padStart(12, '0')}`,
    vmgenid: `0c6a7f2e-0000-4000-8000-${String(n).padStart(12, '0')}`,
    ...common,
  };
  const ovmf = { bios: 'ovmf', machine: 'pc-q35-9.2+pve1', efidisk0: `vmdata:vm-${n}-disk-0,efitype=4m,pre-enrolled-keys=1,size=1M` };
  if (n === 100) Object.assign(values, { tags: 'k3s;prod', description: 'k3s worker node 2.', balloon: '8192' });
  if (n === 101 || n === 107)
    Object.assign(values, ovmf, {
      ostype: 'win11',
      cpu: 'host',
      scsi0: `vmdata:vm-${n}-disk-1,cache=writeback,discard=on,size=256G`,
      tpmstate0: `vmdata:vm-${n}-disk-2,size=4M,version=v2.0`,
      net0: `e1000e=${mac(n)},bridge=vmbr0`,
      ide2: 'local:iso/virtio-win-0.1.271.iso,media=cdrom,size=709474K',
      ...(n === 101 ? { hostpci0: '0000:01:00.0,pcie=1,x-vga=1', tags: 'build;windows', balloon: '0' } : { tags: 'lab' }),
    });
  if (n === 102)
    Object.assign(values, {
      tags: 'k3s;prod',
      ide0: 'local-zfs:vm-102-cloudinit,media=cdrom',
      ciuser: 'ubuntu',
      cipassword: '**********',
      sshkeys: 'ssh-ed25519%20AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheFixturesOnly%20admin%40lab',
      ipconfig0: 'ip=10.20.0.52/24,gw=10.20.0.1',
      nameserver: '10.20.0.1',
      searchdomain: 'lab.example',
    });
  if (n === 103)
    Object.assign(values, {
      tags: 'db;prod',
      protection: '1',
      scsi1: 'vmdata:vm-103-disk-1,iothread=1,size=500G',
      unused0: 'vmdata:vm-103-disk-2',
      args: '-cpu host,+invtsc',
      startup: 'order=1,up=60',
    });
  if (n === 104) Object.assign(values, { tags: 'ci', memory: '8192' });
  if (n === 105)
    Object.assign(values, ovmf, {
      ostype: 'other',
      tags: 'network',
      startup: 'order=0',
      net1: `virtio=${mac(n + 1)},bridge=vmbr1,tag=20`,
      scsi0: 'local-zfs:vm-105-disk-1,size=32G',
    });
  if (n === 106) Object.assign(values, ovmf, { ostype: 'l26', tags: 'home', usb0: 'host=10c4:ea60', scsi0: 'local-zfs:vm-106-disk-1,discard=on,size=32G' });
  const rec = base('pve', values);
  if (n === 104 && g.state !== 'stopped') rec.pending = { memory: '12288' };
  if (n === 103) rec.ha = { state: 'started', max_restart: 1, max_relocate: 1, status: 'started' };
  if (n === 100) rec.replication = [{ id: '100-0', target: 'schist', schedule: '*/15', last_sync: '2026-10-11T13:45:04Z' }];
  return rec;
}

/** The configuration of a guest (seeded on first use), or null for platforms without one. */
export function configOf(c: Ctx, serverId: string, g: Guest): ConfigRec | null {
  if (g.platform !== 'pve' && g.platform !== 'incus') return null;
  const m = manageState(c.st);
  const key = `${serverId}/${g.id}`;
  let rec = m.configs.get(key);
  if (!rec) {
    rec = seedConfig(g);
    m.configs.set(key, rec);
  }
  return rec;
}

export function digestOf(rec: ConfigRec): string {
  return createHash('sha1').update(JSON.stringify([rec.values, rec.pending, rec.pendingDelete])).digest('hex');
}

/** Root-only keys: shown, never changed (docs/MANAGE.md 2.4). */
export function restrictedKeys(rec: ConfigRec): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(rec.values)) {
    if (rec.platform === 'incus') {
      if (k.startsWith('raw.') || k === 'security.privileged' || k.startsWith('image.')) out.push(k);
      continue;
    }
    if (/^(args|hookscript|hostpci\d+|usb\d+|parallel\d+|lxc\..*|dev\d+|smbios1|vmgenid|arch|unprivileged|ostype)$/.test(k) && !(rec.kind === 'vm' && k === 'ostype')) out.push(k);
    else if (/^mp\d+$/.test(k) && v.startsWith('/')) out.push(k);
  }
  return out.sort();
}

const sizeBytes = (v: string): number | undefined => {
  const m = /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT]?)/.exec(v);
  if (!m) return undefined;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2] as '' | 'K' | 'M' | 'G' | 'T'];
  return Math.round(Number(m[1]) * mult);
};

/** The JSON of config.get. */
export function configJson(rec: ConfigRec, running: boolean): GuestConfig {
  const disks: NonNullable<GuestConfig['disks']> = [];
  const boot = /order=([^,]*)/.exec(rec.values.boot ?? '')?.[1]?.split(';') ?? [];
  for (const [k, v] of Object.entries(rec.values)) {
    if (rec.platform === 'incus') {
      if (k.startsWith('device.') && v.includes('type=disk')) {
        const pool = /pool=([^,]*)/.exec(v)?.[1];
        disks.push({ key: k.slice(7), storage: pool, path: /path=([^,]*)/.exec(v)?.[1], size_bytes: /size=(\d+)GiB/.test(v) ? Number(/size=(\d+)GiB/.exec(v)![1]) * 1024 ** 3 : undefined, media: 'disk' });
      }
      continue;
    }
    if (!/^(ide|sata|scsi|virtio|efidisk|tpmstate|unused|mp)\d+$|^rootfs$/.test(k)) continue;
    const file = v.split(',')[0]!;
    const cdrom = v.includes('media=cdrom');
    disks.push({
      key: k,
      storage: file.includes(':') ? file.split(':')[0] : undefined,
      volume: file === 'none' ? undefined : file,
      size_bytes: sizeBytes(v),
      media: cdrom ? 'cdrom' : 'disk',
      path: /(?:^|,)mp=([^,]*)/.exec(v)?.[1],
      unused: k.startsWith('unused') || undefined,
      boot: boot.includes(k) || undefined,
    });
  }
  return {
    platform: rec.platform,
    kind: rec.kind,
    digest: digestOf(rec),
    running,
    values: { ...rec.values },
    ...(Object.keys(rec.pending).length ? { pending: { ...rec.pending } } : {}),
    ...(rec.pendingDelete.length ? { pending_delete: [...rec.pendingDelete] } : {}),
    restricted: restrictedKeys(rec),
    ...(rec.platform === 'incus' ? { inherited: [...rec.inherited], profiles: [...rec.profiles] } : {}),
    ...(rec.platform === 'pve' ? { ha: rec.ha ?? null, replication: [...(rec.replication ?? [])] } : {}),
    disks,
  };
}

// ---------------------------------------------------------------- checks

export type Refusal = { status: number; code: string; detail: string; fields?: Record<string, string> };
function refuse(r: Refusal): FxResponse {
  const res = problem(r.status, r.code, r.detail);
  if (!r.fields) return res;
  // Proxmox parameter errors: the problem names the fields (field_errors).
  return { ...res, body: JSON.stringify({ ...(JSON.parse(String(res.body)) as object), field_errors: r.fields }) };
}

/** Role, server, Manage permission, agent online; admin ops need an admin. */
export function manageHost(c: Ctx, serverId: string, admin = false): { rec: ServerRec } | Refusal {
  if (!roleAtLeast(c.st, 'operator')) return { status: 403, code: 'insufficient_role', detail: 'Requires operator access.' };
  if (admin && !roleAtLeast(c.st, 'admin')) return { status: 403, code: 'insufficient_role', detail: 'Requires admin access.' };
  const rec = findServer(c.st, serverId);
  if (!rec) return { status: 404, code: 'server_not_found', detail: 'No such server.' };
  const e = effectivePerms(c.st, rec);
  if (!e.manage) return { status: 403, code: 'manage_disabled', detail: e.manageReason ?? 'Managing guests is turned off for this server' };
  if (rec.status === 'offline') return { status: 409, code: 'agent_offline', detail: 'The agent of this server is not connected.' };
  return { rec };
}

/** manageHost plus the guest (Proxmox or Incus) and its configuration. */
export function manageGuest(c: Ctx, serverId: string, guestId: string, admin = false): { rec: ServerRec; guest: Guest; config: ConfigRec } | Refusal {
  const h = manageHost(c, serverId, admin);
  if ('status' in h) return h;
  const guest = findManagedGuest(c, serverId, guestId);
  if (!guest) return { status: 404, code: 'guest_not_found', detail: 'No such guest on this server.' };
  const config = configOf(c, serverId, guest);
  if (!config) return { status: 501, code: 'unsupported', detail: 'This platform cannot be managed through Rackoon.' };
  return { rec: h.rec, guest, config };
}

/** Guests created in this browser (lifecycle.ts registers them here). */
export function createdGuests(st: BrowserState): Map<string, Guest> {
  const m = manageState(st);
  let g = m.extra.get('created') as Map<string, Guest> | undefined;
  if (!g) {
    g = new Map();
    m.extra.set('created', g);
  }
  return g;
}

export function findManagedGuest(c: Ctx, serverId: string, guestId: string): Guest | null {
  return findGuest(c.fx(), serverId, guestId) ?? createdGuests(c.st).get(`${serverId}/${guestId}`) ?? null;
}

/** The host's platform for host-level ops (?platform= or the body's). */
export function hostPlatform(c: Ctx, serverId: string): ManagePlatform {
  const p = c.req.query.get('platform') ?? (bodyObject(c.req).platform as string | undefined);
  if (p === 'pve' || p === 'incus') return p;
  return serverId === 'shale' ? 'pve' : 'incus';
}

// ---------------------------------------------------------------- tasks

/** Start a simulated task; its log appears over durationMs of real time. */
export function startTask(c: Ctx, t: { server: string; type: string; guest?: string; durationMs?: number; lines: string[]; error?: string; onDone?: () => void }): TaskRec {
  const m = manageState(c.st);
  const now = c.store.now();
  const vmid = t.guest?.split(':')[1] ?? '';
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  const id =
    t.server === 'shale'
      ? `UPID:shale:${hex(Number.parseInt(randomHex(3), 16), 8)}:${hex(Number.parseInt(randomHex(4), 16), 8)}:${hex(Math.floor(now / 1000), 8)}:${t.type}:${vmid}:rackoon-manage@pve!agent-shale:`
      : `incus:${randomHex(4)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`;
  const rec: TaskRec = { id, server: t.server, type: t.type, guest: t.guest, user: t.server === 'shale' ? 'rackoon-manage@pve!agent-shale' : 'rackoon', startedMs: now, durationMs: t.durationMs ?? 4000, lines: t.lines, error: t.error, onDone: t.onDone };
  m.tasks.set(id, rec);
  return rec;
}

/** Status of a task at the real clock; finishing runs onDone once and announces task.finished. */
export function taskStatus(c: Ctx, t: TaskRec, logStart: number, op = ''): TaskStatus {
  const now = c.store.now();
  const end = t.stoppedMs ?? t.startedMs + t.durationMs;
  const finished = now >= end;
  const shown = finished ? t.lines.length : Math.max(1, Math.floor((t.lines.length * (now - t.startedMs)) / t.durationMs));
  const lines = [...t.lines.slice(0, shown)];
  let status: TaskStatus['status'] = 'running';
  let message = lines[lines.length - 1] ?? '';
  if (finished) {
    if (t.stoppedMs) {
      status = 'error';
      message = 'unexpected status';
      lines.push('received interrupt', 'TASK ERROR: interrupted by signal');
    } else if (t.error) {
      status = 'error';
      message = t.error;
      lines.push(`TASK ERROR: ${t.error}`);
    } else {
      status = 'ok';
      message = 'OK';
      lines.push('TASK OK');
    }
    if (!t.done) {
      t.done = true;
      if (status === 'ok') t.onDone?.();
      pushEvent(c.st, 'task.finished', { server: t.server, guest: t.guest ?? null, task: t.id, op, result: status, message });
    }
  }
  const from = Math.max(0, logStart);
  return {
    id: t.id,
    type: t.type,
    ...(t.guest ? { guest: t.guest.split(':')[1] } : {}),
    user: t.user,
    started: iso(t.startedMs),
    ended: finished ? iso(end) : null,
    status,
    message,
    ...(logStart >= 0 ? { log: lines.slice(from), log_next: lines.length } : {}),
  };
}

/** 202 answer of a change that started a task. */
export function accepted(t: TaskRec, extra: Record<string, unknown> = {}): FxResponse {
  return json(202, { ok: true, task: { id: t.id }, audit_id: `au_${randomHex(6)}`, ...extra });
}

export function auditManage(c: Ctx, server: string, guest: string | null, details: Record<string, string>): void {
  appendAudit(c.store, c.st, { event: 'manage.requested', server, ...(guest ? { guest } : {}), details }, c.req);
}

// ---------------------------------------------------------------- choices

export function choicesFor(c: Ctx, serverId: string, platform: ManagePlatform): Choices {
  if (platform === 'incus') {
    return {
      platform,
      storages: [{ id: 'default', type: 'zfs', content: ['images', 'rootdir'], avail_bytes: 812 * 1024 ** 3, total_bytes: 1800 * 1024 ** 3, thin: true }],
      bridges: ['incusbr0', 'br-lan'],
      profiles: ['default', 'gpu', 'macvlan'],
      images: [
        { fingerprint: '6f9e1c3b2a4d', aliases: ['debian/13'], description: 'Debian trixie amd64 (20261015_05:24)', type: 'container', size_bytes: 98 * 1024 ** 2 },
        { fingerprint: '1a2b3c4d5e6f', aliases: ['nixos/26.05'], description: 'NixOS 26.05 amd64', type: 'virtual-machine', size_bytes: 612 * 1024 ** 2 },
        { fingerprint: '9c8b7a6f5e4d', aliases: ['alpine/3.22'], description: 'Alpine 3.22 amd64', type: 'container', size_bytes: 3 * 1024 ** 2 },
      ],
    };
  }
  const m = manageState(c.st);
  const created = [...createdGuests(c.st).values()].filter((g) => g.vmid).map((g) => g.vmid!);
  const used = new Set([100, 101, 102, 103, 104, 105, 106, 107, 200, 201, 202, 203, 9000, 9001, ...created]);
  while (used.has(m.nextId)) m.nextId++;
  const GiB = 1024 ** 3;
  const extraIsos = (m.extra.get('isos') as Choices['isos']) ?? [];
  const extraTemplates = (m.extra.get('ct_templates') as Choices['ct_templates']) ?? [];
  // lifecycle.ts: guests converted to templates.
  const converted = (m.extra.get('templates') as TemplateGuest[] | undefined) ?? [];
  const pve: Choices = {
    platform,
    node: serverId,
    cluster: true,
    next_id: m.nextId,
    storages: [
      { id: 'local', type: 'dir', content: ['iso', 'vztmpl', 'backup', 'import', 'snippets'], avail_bytes: 53 * GiB, total_bytes: 94 * GiB },
      { id: 'local-zfs', type: 'zfspool', content: ['images', 'rootdir'], avail_bytes: 351 * GiB, total_bytes: 380 * GiB, thin: true },
      { id: 'vmdata', type: 'zfspool', content: ['images', 'rootdir'], avail_bytes: 650 * GiB, total_bytes: 3840 * GiB, thin: true },
      { id: 'bulk', type: 'zfspool', content: ['images', 'backup'], avail_bytes: 9100 * GiB, total_bytes: 14400 * GiB, thin: true },
      { id: 'pbs-01', type: 'pbs', content: ['backup'], avail_bytes: 4100 * GiB, total_bytes: 8000 * GiB, shared: true },
    ],
    bridges: ['vmbr0', 'vmbr1'],
    isos: [
      { volume: 'local:iso/debian-13.1.0-amd64-netinst.iso', storage: 'local', content: 'iso', name: 'debian-13.1.0-amd64-netinst.iso', size_bytes: 754 * 1024 ** 2, created: '2026-09-21T08:12:00Z' },
      { volume: 'local:iso/ubuntu-24.04.3-live-server-amd64.iso', storage: 'local', content: 'iso', name: 'ubuntu-24.04.3-live-server-amd64.iso', size_bytes: 3100 * 1024 ** 2, created: '2026-08-30T19:40:00Z' },
      { volume: 'local:iso/virtio-win-0.1.271.iso', storage: 'local', content: 'iso', name: 'virtio-win-0.1.271.iso', size_bytes: 693 * 1024 ** 2, created: '2026-06-02T10:05:00Z' },
      ...extraIsos,
    ],
    ct_templates: [
      { volume: 'local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst', storage: 'local', content: 'vztmpl', name: 'debian-13-standard_13.1-1_amd64.tar.zst', size_bytes: 124 * 1024 ** 2, created: '2026-09-10T07:00:00Z' },
      { volume: 'local:vztmpl/alpine-3.22-default_20250617_amd64.tar.xz', storage: 'local', content: 'vztmpl', name: 'alpine-3.22-default_20250617_amd64.tar.xz', size_bytes: 3 * 1024 ** 2, created: '2026-07-01T07:00:00Z' },
      { volume: 'local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst', storage: 'local', content: 'vztmpl', name: 'ubuntu-24.04-standard_24.04-2_amd64.tar.zst', size_bytes: 141 * 1024 ** 2, created: '2026-05-12T07:00:00Z' },
      ...extraTemplates,
    ],
    templates: [
      { id: '9000', name: 'debian-13-cloud', kind: 'vm', node: serverId, disk_bytes: 3 * GiB },
      { id: '9001', name: 'ubuntu-2404-cloud', kind: 'vm', node: serverId, disk_bytes: 4 * GiB },
      ...converted,
    ],
    cpu_types: ['x86-64-v2-AES', 'x86-64-v3', 'x86-64-v4', 'host', 'kvm64', 'qemu64', 'EPYC-Milan', 'Skylake-Server'],
    nodes: ['schist', 'slate'],
    download: true,
  };
  // lifecycle.ts: deleted ISO images, container templates and guest templates.
  const gone = (m.extra.get('deleted') as Set<string> | undefined) ?? new Set<string>();
  pve.isos = pve.isos?.filter((v) => !gone.has(v.volume));
  pve.ct_templates = pve.ct_templates?.filter((v) => !gone.has(v.volume));
  pve.templates = pve.templates?.filter((g) => !gone.has(`${serverId}/pve:${g.id}`));
  return pve;
}

// ---------------------------------------------------------------- config changes

/** Keys a running guest takes live; everything else waits for a restart. */
function appliesLive(rec: ConfigRec, key: string): boolean {
  if (rec.platform === 'incus') return true;
  if (rec.kind === 'container') return !/^(rootfs|mp\d+|features|unprivileged|cmode|tty|console)$/.test(key);
  return /^(name|description|tags|onboot|startup|protection|balloon|cpulimit|cpuunits|net\d+|ide\d+|sata\d+|scsi\d+|virtio\d+|unused\d+)$/.test(key);
}

const SECRET = /^(cipassword|password)$/;
const mask = (k: string, v: string | undefined) => (v !== undefined && SECRET.test(k) ? '**********' : v);

/**
 * A new volume ("local-zfs:32") becomes a named one with its size, like
 * Proxmox allocates it ("local-zfs:vm-100-disk-1,size=32G"); everything
 * else is stored as sent.
 */
function allocate(rec: ConfigRec, key: string, v: string): string {
  if (rec.platform !== 'pve' || !/^(ide|sata|scsi|virtio|mp)\d+$|^efidisk0$|^tpmstate0$/.test(key)) return v;
  const [file, ...rest] = v.split(',');
  const m = /^([\w.-]+):(\d+(?:\.\d+)?)$/.exec(file ?? '');
  if (!m || v.includes('media=cdrom')) return v;
  const used = Object.values({ ...rec.values, ...rec.pending }).flatMap((x) => [...x.matchAll(/-disk-(\d+)/g)].map((y) => Number(y[1])));
  const n = used.length ? Math.max(...used) + 1 : 0;
  const vmid = rec.vmid ?? 0;
  const name = rec.kind === 'container' ? `subvol-${vmid}-disk-${n}` : `vm-${vmid}-disk-${n}`;
  const size = key === 'efidisk0' ? '1M' : key === 'tpmstate0' ? '4M' : `${m[2]}G`;
  return [`${m[1]}:${name}`, ...rest, `size=${size}`].join(',');
}

/** Apply a config.set; returns the changes or a refusal. */
export function applyConfig(rec: ConfigRec, running: boolean, body: Record<string, unknown>): { changes: ConfigChange[] } | Refusal {
  const set = (body.set ?? {}) as Record<string, string>;
  const del = (body.delete ?? []) as string[];
  const revert = (body.revert ?? []) as string[];
  if (typeof body.digest === 'string' && body.digest && body.digest !== digestOf(rec))
    return { status: 409, code: 'digest_mismatch', detail: 'The configuration changed since it was loaded. Review it again.' };
  const restricted = new Set(restrictedKeys(rec));
  for (const k of [...Object.keys(set), ...del]) {
    if (restricted.has(k) || /^(args|hookscript|hostpci\d+|usb\d+|lxc\.|raw\.)/.test(k)) return { status: 403, code: 'not_allowed', detail: `${k} can only be changed in the platform's own interface.` };
    const v = set[k];
    if (v !== undefined && (v.split(',')[0]!.startsWith('/') || v.includes('import-from='))) return { status: 403, code: 'not_allowed', detail: `${k}: host paths can only be set in the platform's own interface.` };
  }
  if (del.some((k) => /^unused\d+$/.test(k)) && body.confirm !== true) return { status: 400, code: 'confirm_required', detail: 'Deleting an unused disk destroys it: send "confirm": true.' };
  // Proxmox's parameter checks the UI leaves to the platform: the answer names the fields.
  const fields: Record<string, string> = {};
  if (rec.platform === 'pve' && set.memory !== undefined && !/^\d+$/.test(set.memory)) fields.memory = 'type check (\'integer\') failed - got \'' + set.memory + '\'';
  for (const k of ['name', 'hostname']) {
    const v = set[k];
    if (rec.platform === 'pve' && v !== undefined && !/^(?=.{1,63}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(v)) fields[k] = 'invalid format - value does not look like a valid DNS name';
  }
  if (Object.keys(fields).length) return { status: 400, code: 'invalid_value', detail: 'Parameter verification failed.', fields };
  const changes: ConfigChange[] = [];
  for (const k of revert) {
    if (k in rec.pending) {
      changes.push({ key: k, old: mask(k, rec.pending[k]), new: mask(k, rec.values[k]) });
      delete rec.pending[k];
    }
    rec.pendingDelete = rec.pendingDelete.filter((x) => x !== k);
  }
  for (const [k, raw] of Object.entries(set)) {
    const live = !running || appliesLive(rec, k);
    const old = rec.pending[k] ?? rec.values[k];
    if (old === raw && !SECRET.test(k)) continue;
    const v = SECRET.test(k) ? '**********' : allocate(rec, k, raw);
    // Incus: a key set to "" goes away.
    if (rec.platform === 'incus' && v === '') {
      if (!(k in rec.values)) continue;
      delete rec.values[k];
      changes.push({ key: k, old: mask(k, old) });
      continue;
    }
    if (live) {
      rec.values[k] = v;
      delete rec.pending[k];
    } else rec.pending[k] = v;
    // Attaching an unused disk takes it off the unused list (Proxmox does the same).
    const file = v.split(',')[0]!;
    for (const [u, vol] of Object.entries(rec.values)) if (/^unused\d+$/.test(u) && vol === file && u !== k) delete rec.values[u];
    if (rec.platform === 'incus') rec.inherited = rec.inherited.filter((x) => x !== k);
    changes.push({ key: k, old: mask(k, old), new: mask(k, raw), ...(live ? {} : { pending: true }) });
  }
  for (const k of del) {
    if (!(k in rec.values)) continue;
    const live = !running || appliesLive(rec, k);
    const v = rec.values[k]!;
    if (live) {
      // Detaching a disk keeps it as unusedN; deleting unusedN destroys it.
      delete rec.values[k];
      if (rec.platform === 'pve' && /^(ide|sata|scsi|virtio|mp)\d+$/.test(k) && !v.includes('media=cdrom')) {
        let i = 0;
        while (`unused${i}` in rec.values) i++;
        rec.values[`unused${i}`] = v.split(',')[0]!;
      }
    } else if (!rec.pendingDelete.includes(k)) rec.pendingDelete.push(k);
    changes.push({ key: k, old: mask(k, v), ...(live ? {} : { pending: true }) });
  }
  return { changes };
}

// ---------------------------------------------------------------- routes

const G = String.raw`^\/servers\/([^/]+)\/guests\/([^/]+)`;
const S = String.raw`^\/servers\/([^/]+)`;

function running(g: Guest): boolean {
  return g.state === 'running' || g.state === 'unhealthy' || g.state === 'paused';
}

export const manageRoutes: ManageRoute[] = [
  {
    method: 'GET',
    re: new RegExp(`${G}\\/config$`),
    handler: (c, [s, g]) => {
      const t = manageGuest(c, decode(s), decode(g));
      if ('status' in t) return refuse(t);
      return json(200, configJson(t.config, running(t.guest)));
    },
  },
  {
    method: 'PUT',
    re: new RegExp(`${G}\\/config$`),
    handler: (c, [s, g]) => {
      const t = manageGuest(c, decode(s), decode(g));
      if ('status' in t) return refuse(t);
      const r = applyConfig(t.config, running(t.guest), bodyObject(c.req));
      if ('status' in r) return refuse(r);
      auditManage(c, t.rec.id, t.guest.id, { op: 'config.set', changes: r.changes.map((x) => `${x.key}: ${x.old ?? ''} → ${x.new ?? ''}`).join('; ') });
      return json(200, { ok: true, changes: r.changes, audit_id: `au_${randomHex(6)}` });
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${G}\\/disks\\/([^/]+)\\/resize$`),
    handler: (c, [s, g, d]) => {
      const t = manageGuest(c, decode(s), decode(g));
      if ('status' in t) return refuse(t);
      const disk = decode(d);
      // Incus names the device ("root"); its config key is device.root.
      const key = t.config.platform === 'incus' ? `device.${disk}` : disk;
      const cur = t.config.values[key];
      if (!cur) return problem(404, 'not_found', `${disk} does not exist.`);
      const size = String(bodyObject(c.req).size ?? '');
      const m = /^(\+)?(\d+(?:\.\d+)?)G$/.exec(size);
      if (!m) return problem(400, 'invalid_value', 'Size is "+NG" or the new total "NG".');
      const now = (sizeBytes(cur) ?? 0) / 1024 ** 3;
      const next = m[1] ? now + Number(m[2]) : Number(m[2]);
      if (next < now) return problem(400, 'invalid_value', 'Disks can only grow.');
      const rec = t.config;
      const task = startTask(c, {
        server: t.rec.id,
        type: t.guest.kind === 'vm' ? 'qmresize' : 'resize',
        guest: t.guest.id,
        durationMs: 2500,
        lines: [`resizing ${disk} to ${next}G`, `Image resized.`],
        onDone: () => {
          const size = rec.platform === 'incus' ? `size=${next}GiB` : `size=${next}G`;
          rec.values[key] = /size=/.test(cur) ? cur.replace(/size=[^,]*/, size) : `${cur},${size}`;
          if (rec.platform === 'incus') rec.inherited = rec.inherited.filter((x) => x !== key);
        },
      });
      auditManage(c, t.rec.id, t.guest.id, { op: 'disk.resize', disk, size, task: task.id });
      return accepted(task);
    },
  },
  {
    method: 'POST',
    re: new RegExp(`${G}\\/disks\\/([^/]+)\\/move$`),
    handler: (c, [s, g, d]) => {
      const t = manageGuest(c, decode(s), decode(g));
      if ('status' in t) return refuse(t);
      const disk = decode(d);
      const cur = t.config.values[disk];
      if (!cur) return problem(404, 'not_found', `${disk} does not exist.`);
      const b = bodyObject(c.req);
      const storage = String(b.storage ?? '');
      if (!choicesFor(c, t.rec.id, t.config.platform).storages.some((x) => x.id === storage && x.content.includes(t.config.kind === 'vm' ? 'images' : 'rootdir')))
        return problem(400, 'invalid_value', `${storage} does not hold guest disks.`);
      const rec = t.config;
      const task = startTask(c, {
        server: t.rec.id,
        type: t.guest.kind === 'vm' ? 'qmmove' : 'move_volume',
        guest: t.guest.id,
        durationMs: 6000,
        lines: [`create full clone of drive ${disk} (${cur.split(',')[0]})`, 'transferred 8.0 GiB of 64.0 GiB (12.50%)', 'transferred 32.0 GiB of 64.0 GiB (50.00%)', 'transferred 64.0 GiB of 64.0 GiB (100.00%)'],
        onDone: () => {
          const [file, ...rest] = cur.split(',');
          const vol = file!.split(':')[1] ?? file!;
          rec.values[disk] = [`${storage}:${vol}`, ...rest].join(',');
          if (!b.delete_source) {
            let i = 0;
            while (`unused${i}` in rec.values) i++;
            rec.values[`unused${i}`] = file!;
          }
        },
      });
      auditManage(c, t.rec.id, t.guest.id, { op: 'disk.move', disk, storage, task: task.id });
      return accepted(task);
    },
  },
  {
    method: 'GET',
    re: new RegExp(`${G}\\/metrics$`),
    handler: (c, [s, g]) => {
      const guest = findManagedGuest(c, decode(s), decode(g));
      return guest ? guestMetrics(c, decode(s), guest) : problem(404, 'guest_not_found', 'No such guest on this server.');
    },
  },
  {
    method: 'GET',
    re: new RegExp(`${S}\\/manage\\/choices$`),
    handler: (c, [s]) => {
      const h = manageHost(c, decode(s));
      if ('status' in h) return refuse(h);
      return json(200, choicesFor(c, h.rec.id, hostPlatform(c, h.rec.id)));
    },
  },
  {
    method: 'GET',
    re: new RegExp(`${S}\\/tasks\\/([^/]+)$`),
    handler: (c, [s, id]) => {
      const h = manageHost(c, decode(s));
      if ('status' in h) return refuse(h);
      const t = manageState(c.st).tasks.get(decode(id));
      if (!t || t.server !== h.rec.id) return problem(404, 'not_found', 'No such task.');
      const start = Number.parseInt(c.req.query.get('log_start') ?? '0', 10);
      return json(200, taskStatus(c, t, Number.isFinite(start) ? start : 0));
    },
  },
  {
    method: 'DELETE',
    re: new RegExp(`${S}\\/tasks\\/([^/]+)$`),
    handler: (c, [s, id]) => {
      const h = manageHost(c, decode(s));
      if ('status' in h) return refuse(h);
      const t = manageState(c.st).tasks.get(decode(id));
      if (!t || t.server !== h.rec.id) return problem(404, 'not_found', 'No such task.');
      if (c.store.now() < t.startedMs + t.durationMs) t.stoppedMs = c.store.now();
      return json(200, { ok: true });
    },
  },
  {
    method: 'GET',
    re: new RegExp(`${G}\\/tasks$`),
    handler: (c, [s, g]) => {
      const t = manageGuest(c, decode(s), decode(g));
      if ('status' in t) return refuse(t);
      return json(200, { items: tasksOf(c, t.rec.id, t.guest.id) });
    },
  },
  {
    method: 'GET',
    re: new RegExp(`${S}\\/tasks$`),
    handler: (c, [s]) => {
      const h = manageHost(c, decode(s));
      if ('status' in h) return refuse(h);
      return json(200, { items: tasksOf(c, h.rec.id) });
    },
  },
];

/**
 * History of one guest (GET .../guests/{id}/metrics, every role): series
 * drawn around the guest's current numbers; nothing while it is stopped.
 */
function guestMetrics(c: Ctx, serverId: string, g: Guest): FxResponse {
  const q = c.req.query.get('range') ?? '24h';
  const range = (q in RANGE_STEPS ? q : '24h') as keyof typeof RANGE_STEPS;
  const { n, stepMin } = RANGE_STEPS[range];
  const asOf = Date.parse(c.fx().fleet.as_of);
  const timestamps = Array.from({ length: n }, (_, i) => new Date(asOf - (n - 1 - i) * stepMin * 60000).toISOString().replace('.000Z', 'Z'));
  const on = g.state !== 'stopped';
  const series = (name: string, now: number | null | undefined, amp: number, max: number) => {
    if (!on || now == null) return Array.from({ length: n }, () => null);
    return gen(`${serverId}-${g.id}-${name}-${range}`, n, stepMin, { base: now, amp, noise: amp / 2, spikes: 2, spikeH: amp * 2, now, min: 0, max }).map(round1);
  };
  return json(200, {
    server: serverId,
    range,
    step_seconds: stepMin * 60,
    points: n,
    as_of: c.fx().fleet.as_of,
    timestamps,
    series: {
      cpu_pct: series('cpu', g.cpu_pct, Math.max(2, (g.cpu_pct ?? 0) / 3), 100),
      mem_mb: series('mem', g.memory_used_mb, (g.memory_used_mb ?? 0) / 20, g.memory_limit_mb ?? 1e6),
      net_rx_mbps: series('rx', g.net_rx_mbps ?? 0.4, 1, 1e4),
      net_tx_mbps: series('tx', g.net_tx_mbps ?? 0.2, 0.6, 1e4),
      disk_read_mbs: series('rd', g.disk_read_mbs ?? 0.3, 0.8, 1e4),
      disk_write_mbs: series('wr', g.disk_write_mbs ?? 0.2, 0.6, 1e4),
    },
  });
}

/** Tasks of a host (or one guest), newest first: the ones started in this browser and a few older ones. */
export function tasksOf(c: Ctx, serverId: string, guestId?: string): TaskStatus[] {
  const live = [...manageState(c.st).tasks.values()].filter((t) => t.server === serverId && (!guestId || t.guest === guestId)).map((t) => taskStatus(c, t, -1));
  const vmid = guestId?.split(':')[1];
  const at = (h: number) => iso(Date.parse(c.fx().fleet.as_of) - h * 3600_000);
  const old: TaskStatus[] =
    serverId === 'shale' && vmid
      ? [
          { id: `UPID:shale:00001A2B:00C0FFEE:67100000:vzdump:${vmid}:root@pam:`, type: 'vzdump', guest: vmid, user: 'root@pam', started: at(20), ended: at(19.9), status: 'ok', message: 'OK' },
          { id: `UPID:shale:00001A2C:00C0FFEF:670F0000:qmstart:${vmid}:root@pam:`, type: guestId?.startsWith('pve:2') ? 'vzstart' : 'qmstart', guest: vmid, user: 'root@pam', started: at(96), ended: at(95.99), status: 'ok', message: 'OK' },
        ]
      : [];
  return [...live, ...old].sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
}

