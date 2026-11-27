/**
 * The hosts service's JSON (snake_case, Rackoon's `web/src/api/types.ts`, `internal/hub/model`) → the contracts' `Host*`
 * shapes (camelCase, `@whombat/core` domain/hosts.ts). Pure. Lenient on input: the hub may leave parts out, send `null`
 * for an empty list or a date where a time is expected; what can't be read becomes null, an empty list or is left out,
 * never an error, so one odd field never empties a server's page (one-whombat-servers.md ONE-DH08).
 *
 * Main shapes are mapped field by field; rarely used nested parts (virtualization, health, cluster, choices, firewall)
 * by `camel`, which renames keys and keeps the keys of data maps (`values`, `options`, `series`, …) as they are.
 */

import {
  HOST_CONTROL_LEVELS,
  HOST_SCREEN_CODES,
  HOST_SCREEN_LIMITS,
  type HostAlert,
  type HostBackupJob,
  type HostBackupVolume,
  type HostChoices,
  type HostConfigChange,
  type HostConsoleSession,
  type HostControlLevel,
  type HostDisk,
  type HostDiskUsage,
  type HostEnrollment,
  type HostFirewall,
  type HostFleet,
  type HostGuest,
  type HostGuestConfig,
  type HostGuestCount,
  type HostHint,
  type HostIncusDetail,
  type HostIncusProfile,
  type HostInspectKind,
  type HostInspectResult,
  type HostLibvirtDetail,
  type HostMacHelper,
  type HostMacosDetail,
  type HostMacScreen,
  type HostMaintenance,
  type HostManageResult,
  type HostMapPlace,
  type HostMapPoint,
  type HostNetworkLease,
  type HostOsFamily,
  type HostPendingEnrollment,
  type HostPlatformWorkload,
  type HostRemoteControl,
  type HostRemoteToggles,
  type HostScreenCode,
  type HostScreenOp,
  type HostScreenResult,
  type HostSensor,
  type HostSeries,
  type HostServer,
  type HostServerDetail,
  type HostServerInfo,
  type HostServerPlatform,
  type HostServerSettings,
  type HostSnapshot,
  type HostStorageVolume,
  type HostTask,
  type HostUiApp,
  type HostUiElement,
  type HostUnraidDetail,
  type HostUnraidDisk,
  type HostUnraidParityRun,
  hostWatchLimit,
} from '@whombat/core';
import { toAgentUpdate, withAgentUpdateHints } from './agent-updates';
import { rememberEnglish } from './localize';
import { serverVerdict } from './quiet-lines';

type J = Record<string, unknown>;

/* Readers ------------------------------------------------------------------------------------------------------------ */

export const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** An ISO time with an offset, or null: a bare date becomes its midnight UTC; anything else null. */
export function ts(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/** A link like `#storage` as a section name (`storage`), or null. */
const section = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const clean = s.replace(/^#/, '').trim();
  return clean || null;
};

/** Only the defined values (a contract's optional field is absent, not undefined). */
function defined<T extends J>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** Keys whose values are data maps: their own keys stay as the service wrote them. */
const DATA_MAPS = new Set([
  'values',
  'pending',
  'options',
  'series',
  'summary',
  'platforms',
  'tags',
  'unavailable',
  'field_errors',
]);

const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** snake_case keys → camelCase, deep; the keys of data maps (`DATA_MAPS`) are kept. */
export function camel(v: unknown, keepKeys = false): unknown {
  if (Array.isArray(v)) return v.map((x) => camel(x));
  if (!v || typeof v !== 'object') return v;
  const out: J = {};
  for (const [k, val] of Object.entries(v as J)) {
    const key = keepKeys ? k : camelKey(k);
    out[key] = DATA_MAPS.has(k) ? camelData(val) : camel(val);
  }
  return out;
}

/** A data map: its keys kept, its values converted. */
function camelData(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return camel(v);
  const out: J = {};
  for (const [k, val] of Object.entries(v as J)) out[k] = camel(val);
  return out;
}

/* Status and switches ------------------------------------------------------------------------------------------------ */

/** Open alerts of a server by severity, from a list of hub alerts. */
export function alertCounts(
  alerts: readonly unknown[],
  serverId: string,
): { critical: number; warning: number } {
  let critical = 0;
  let warning = 0;
  for (const raw of alerts) {
    const a = obj(raw);
    if (a.server !== serverId || (a.state !== undefined && a.state !== 'open')) continue;
    if (a.severity === 'critical') critical += 1;
    else warning += 1;
  }
  return { critical, warning };
}

/** Whether a fleet card's agent never reported (enrolled, no data yet). */
export function neverReported(card: J): boolean {
  return card.os == null && card.last_seen == null && card.current == null;
}

/** `serverVerdict` from the card and the open alerts only. */
export function alertVerdict(server: J, alerts: readonly unknown[], pending = neverReported(server)) {
  const id = text(server.id, 'unknown');
  return serverVerdict({
    card: { id, status: text(server.status), statusNote: str(server.status_note) },
    pending,
    alerts: alerts.filter((a) => obj(a).server === id).map(toHostAlert),
    now: new Date(),
  });
}

const SWITCHES = ['console', 'power', 'host_shell', 'host_power', 'manage', 'diagnose'] as const;

/** The detail's `remote_control` (effective switches, the agent's flags, reasons). */
export function remoteControl(v: unknown): HostRemoteControl {
  const rc = obj(v);
  const out: J = { console: bool(rc.console), power: bool(rc.power) };
  for (const s of SWITCHES) {
    const c = camelKey(s);
    if (s !== 'console' && s !== 'power' && typeof rc[s] === 'boolean') out[c] = rc[s];
    const agent = rc[`agent_${s}`];
    if (typeof agent === 'boolean') out[camelKey(`agent_${s}`)] = agent;
    const reason = rc[`${s}_reason`];
    if (typeof reason === 'string' && reason) out[`${c}Reason`] = reason.slice(0, 300);
  }
  return out as HostRemoteControl;
}

/** The hub's switches or the agent's policy (`/agents`, `/servers/{id}/settings`). */
export function toggles(v: unknown): HostRemoteToggles {
  const t = obj(v);
  return defined({
    console: bool(t.console),
    power: bool(t.power),
    hostShell: optBool(t.host_shell),
    hostPower: optBool(t.host_power),
    manage: optBool(t.manage),
    diagnose: optBool(t.diagnose),
  });
}

/**
 * What may be done on a server from `/agents`' two sides: each switch on only when the hub's and the agent's are, with
 * the reason when one is off. Diagnose is on unless one side turned it off.
 */
export function remoteControlFromAgent(agent: unknown): HostRemoteControl {
  const a = obj(agent);
  const hub = obj(a.remote_control);
  const policy = obj(a.agent_policy);
  const out: J = {};
  for (const s of SWITCHES) {
    const fallback = s === 'diagnose';
    const hubOn = typeof hub[s] === 'boolean' ? (hub[s] as boolean) : fallback;
    const agentOn = typeof policy[s] === 'boolean' ? (policy[s] as boolean) : fallback;
    const c = camelKey(s);
    out[c] = hubOn && agentOn;
    out[camelKey(`agent_${s}`)] = agentOn;
    if (!agentOn) out[`${c}Reason`] = 'Off in the server’s agent settings.';
    else if (!hubOn) out[`${c}Reason`] = 'Off for this server in Whombat.';
  }
  return out as HostRemoteControl;
}

/** The fallback when Whombat doesn't know the switches: consoles as the card says, nothing else. */
function remoteControlFromCard(card: J): HostRemoteControl {
  return { console: bool(card.console_on), power: false };
}

/* Fleet -------------------------------------------------------------------------------------------------------------- */

const SERVER_KINDS = new Set(['proxmox', 'incus', 'unraid', 'libvirt', 'macos']);

/** The hub's `detail_view` as the server's kind of page (IU-03): an unknown one is a standard page. */
export function serverPlatform(detailView: unknown): HostServerPlatform {
  const v = text(detailView);
  return SERVER_KINDS.has(v) ? (v as HostServerPlatform) : 'standard';
}

/**
 * The hub's `os_family` (macos-servers.md): `macos` for a Mac; anything else is left out (Linux, as before Macs),
 * but a Mac's page is a Mac whatever the hub said.
 */
export function osFamily(raw: unknown, detailView?: unknown): HostOsFamily | undefined {
  if (raw === 'macos' || detailView === 'macos') return 'macos';
  return raw === 'linux' ? 'linux' : undefined;
}

/** Running and total guests per platform from a card's counts (`qemu` is Proxmox's on a Proxmox node, else libvirt). */
export function guestCounts(card: J): HostGuestCount[] {
  const w = obj(card.workloads);
  const docker = obj(w.docker);
  const incus = obj(w.incus);
  const qemu = obj(w.qemu);
  const out: HostGuestCount[] = [];
  const dRun = int(docker.running) ?? 0;
  const dUnhealthy = int(docker.unhealthy) ?? 0;
  const dTotal = dRun + (int(docker.stopped) ?? 0) + dUnhealthy;
  if (dTotal > 0) out.push({ platform: 'docker', running: dRun, total: dTotal, unhealthy: dUnhealthy });
  const iRun = (int(incus.containers_running) ?? 0) + (int(incus.vms_running) ?? 0);
  const iTotal = iRun + (int(incus.stopped) ?? 0);
  if (iTotal > 0) out.push({ platform: 'incus', running: iRun, total: iTotal });
  const qRun = int(qemu.running) ?? 0;
  const qTotal = qRun + (int(qemu.stopped) ?? 0);
  if (qTotal > 0)
    out.push({ platform: card.detail_view === 'proxmox' ? 'pve' : 'libvirt', running: qRun, total: qTotal });
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface FleetInputs {
  fleet: unknown;
  /** `/fleet/series?range=24h` (for `cpu24h`), when it answered. */
  series?: unknown;
  /** `/agents`, when it answered (switches, agent versions). */
  agents?: unknown;
}

/** One card of `/fleet` as a row of the servers table. */
export function toHostServer(
  cardRaw: unknown,
  alerts: readonly unknown[],
  extra: { cpu24h?: unknown; agent?: unknown } = {},
): HostServer {
  const card = obj(cardRaw);
  const id = text(card.id, 'unknown');
  const current = card.current ? obj(card.current) : null;
  const last = card.last_known ? obj(card.last_known) : null;
  const memTotal = num(card.memory_total_gb);
  const memPct = num(current?.mem_pct) ?? null;
  const storageTb = num(card.storage_capacity_tb);
  const diskPct = num(current?.disk_used_pct) ?? null;
  const temp = num(current?.temp_max_c);
  const agent = extra.agent ? obj(extra.agent) : null;
  const counts = alertCounts(alerts, id);
  const maintenance = card.maintenance ? obj(card.maintenance) : null;
  const cpu = card.cpu ? obj(card.cpu) : null;
  const verdict = alertVerdict(card, alerts);
  return defined({
    id,
    name: text(card.id, id).slice(0, 120) || id,
    group: text(card.group).slice(0, 120),
    status: verdict.status,
    statusNote: verdict.note,
    platform: serverPlatform(card.detail_view),
    hostsThisWhombat: card.hosts_this_whombat === true ? true : undefined,
    os: str(card.os),
    osFamily: osFamily(card.os_family, card.detail_view),
    cpu: cpu ? { model: text(cpu.model), cores: int(cpu.cores) ?? 0, threads: int(cpu.threads) ?? 0 } : null,
    cpuPct: num(current?.cpu_pct) ?? null,
    memory: {
      usedPct: memPct,
      usedGb: memPct !== null && memTotal !== null ? round1((memTotal * memPct) / 100) : null,
      totalGb: memTotal,
    },
    storage: {
      usedPct: diskPct,
      usedTb: diskPct !== null && storageTb !== null ? round1((storageTb * diskPct) / 100) : null,
      capacityTb: storageTb,
    },
    temperature: temp === null ? null : { maxC: temp, limitC: num(current?.temp_limit_c) ?? 85 },
    diskWearMaxPct: num(current?.disk_wear_max_pct) ?? num(last?.disk_wear_max_pct),
    guests: guestCounts(card).slice(0, 8),
    agent: { version: agent ? str(agent.version) : null, connected: bool(card.agent_connected) },
    lastSeen: ts(card.last_seen),
    cpu24h: arr(extra.cpu24h)
      .slice(-48)
      .map((p) => num(p)),
    remoteControl: agent ? remoteControlFromAgent(agent) : remoteControlFromCard(card),
    alerts: counts,
    maintenance:
      maintenance && ts(maintenance.until)
        ? { id: text(maintenance.id), until: ts(maintenance.until) as string, note: text(maintenance.note) }
        : null,
    parent: str(card.parent),
  }) as HostServer;
}

/** `/fleet` (+ its 24 h series and the agents) as `HostFleet`. */
export function toHostFleet(inputs: FleetInputs, now: Date): HostFleet {
  const f = obj(inputs.fleet);
  const alerts = arr(f.alerts);
  // 24 hours in 30-minute buckets: the heatmap's 48; else the last 48 of the server's sparkline (WHOMBAT.md §3).
  const heat = obj(obj(obj(inputs.series).heatmap).cpu_pct);
  const spark = obj(obj(inputs.series).servers);
  const agents = new Map<string, unknown>();
  for (const a of arr(inputs.agents)) agents.set(text(obj(a).server_id), a);
  const k = obj(f.kpis);
  return {
    asOf: ts(f.as_of) ?? now.toISOString(),
    groups: arr(f.groups).map((g) => ({ name: text(obj(g).name), count: int(obj(g).count) ?? 0 })),
    kpis: defined({
      serversOnline: int(k.servers_online) ?? 0,
      serversTotal: int(k.servers_total) ?? 0,
      cpuAvgPct: num(k.cpu_avg_pct),
      memoryPct: num(k.memory_pct),
      memoryUsedGb: num(k.memory_used_gb) ?? 0,
      memoryTotalGb: num(k.memory_total_gb) ?? 0,
      storageUsedTb: num(k.storage_used_tb) ?? 0,
      storageTotalTb: num(k.storage_total_tb) ?? 0,
      storagePct: num(k.storage_pct),
      disksOver75Wear: int(k.disks_over_75_wear) ?? 0,
      openAlerts: int(k.open_alerts) ?? 0,
      openAlertsCritical: int(k.open_alerts_critical) ?? 0,
      openAlertsWarning: int(k.open_alerts_warning) ?? 0,
      openAlertsAttention: int(k.open_alerts_attention) ?? undefined,
    }),
    servers: arr(f.servers).map((s) => {
      const id = text(obj(s).id);
      return toHostServer(s, alerts, { cpu24h: heat[id] ?? obj(spark[id]).cpu_pct, agent: agents.get(id) });
    }),
    alerts: alerts.map(toHostAlert),
    hints: arr(f.hints).map(toHostHint),
    agentsConnected:
      int(f.agents_connected) ?? arr(f.servers).filter((s) => obj(s).status !== 'offline').length,
    pendingEnrollments: int(f.pending_enrollments) ?? 0,
  };
}

/* Alerts, hints ------------------------------------------------------------------------------------------------------ */

export function toHostAlert(raw: unknown): HostAlert {
  const a = obj(raw);
  const ack = a.acknowledged ? obj(a.acknowledged) : null;
  const state = a.state === 'resolved' ? 'resolved' : 'open';
  return defined({
    id: text(a.id, 'unknown'),
    serverId: str(a.server) || null,
    severity: a.severity === 'critical' ? ('critical' as const) : ('warning' as const),
    title: text(a.title),
    detail: text(a.detail),
    openedAt: ts(a.opened_at) ?? new Date(0).toISOString(),
    rule: text(a.rule),
    state,
    resolvedAt: ts(a.resolved_at),
    section: section(a.link),
    acknowledged:
      ack && ts(ack.at)
        ? { at: ts(ack.at) as string, by: text(ack.by), note: text(ack.note), until: ts(ack.until) }
        : null,
    muted: optBool(a.muted),
    suppressedBy: str(a.suppressed_by),
    attention:
      typeof a.attention === 'boolean'
        ? a.attention
        : state === 'open' && !ack && !a.muted && !a.suppressed_by,
    // What it is about and its condition's key (hosts HS-191; contracts CT-1066).
    entity: str(a.entity)?.slice(0, 200) || undefined,
    key: str(a.key)?.slice(0, 300) || undefined,
  }) as HostAlert;
}

/** The hub's guest ids a hint lists (`guests`), kept beside the mapped hint (the contract's `HostHint` has none). */
const HINT_GUESTS = new WeakMap<HostHint, string[]>();

/** The guests a hint is about, as the hub listed them (for what “until another guest” compares, QN-S52). */
export function hintGuests(h: HostHint): string[] | undefined {
  return HINT_GUESTS.get(h);
}

export function toHostHint(raw: unknown): HostHint {
  const h = obj(raw);
  const kind = text(h.kind);
  const entity = text(h.entity);
  const hint: HostHint = {
    serverId: text(h.server, 'unknown') || 'unknown',
    kind,
    severity: h.severity === 'warning' ? 'warning' : 'info',
    entity,
    title: text(h.title),
    detail: text(h.detail),
    section: section(h.link) ?? '',
    // Its stable id on the server (hosts HS-192); an older hub's joined the same way.
    id: (str(h.id) || `${kind}:${entity}`).slice(0, 200),
  };
  const guests = arr(h.guests).filter((g): g is string => typeof g === 'string');
  if (guests.length) HINT_GUESTS.set(hint, guests);
  // What Ignore compares stays the hub's English whatever language the words are in.
  rememberEnglish(hint, h);
  return hint;
}

/* Guests ------------------------------------------------------------------------------------------------------------- */

const PLATFORMS = new Set(['docker', 'incus', 'libvirt', 'pve']);
const STATES = new Set(['running', 'stopped', 'unhealthy', 'paused']);
const PROTOCOLS = new Set(['vnc', 'spice', 'serial', 'shell', 'tty', 'logs']);

export function toHostGuest(raw: unknown, serverId: string, serverOnline?: boolean): HostGuest {
  const g = obj(raw);
  const id = text(g.id, 'unknown');
  const platform = PLATFORMS.has(text(g.platform)) ? text(g.platform) : (id.split(':')[0] ?? 'docker');
  const c = obj(g.console);
  const protocols = arr(c.protocols).filter((p): p is string => typeof p === 'string' && PROTOCOLS.has(p));
  const backup = g.last_backup ? obj(g.last_backup) : null;
  const online = typeof g.server_online === 'boolean' ? g.server_online : serverOnline;
  return defined({
    id,
    serverId: text(g.server, serverId) || serverId,
    serverOnline: online,
    name: text(g.name, id),
    platform: (PLATFORMS.has(platform) ? platform : 'docker') as HostGuest['platform'],
    kind: g.kind === 'vm' ? ('vm' as const) : ('container' as const),
    image: text(g.image),
    state: (STATES.has(text(g.state)) ? text(g.state) : 'stopped') as HostGuest['state'],
    vcpu: num(g.vcpu) ?? undefined,
    cpuPct: num(g.cpu_pct),
    memoryUsedMb: num(g.memory_used_mb),
    memoryLimitMb: num(g.memory_limit_mb),
    diskReadMbs: num(g.disk_read_mbs) ?? undefined,
    diskWriteMbs: num(g.disk_write_mbs) ?? undefined,
    netRxMbps: num(g.net_rx_mbps) ?? undefined,
    netTxMbps: num(g.net_tx_mbps) ?? undefined,
    snapshots: num(g.snapshots) ?? undefined,
    uptimeS: num(g.uptime_s),
    lastExit: str(g.last_exit) ?? undefined,
    console: defined({
      available: bool(c.available),
      protocols: protocols.length ? (protocols as HostGuest['console']['protocols']) : undefined,
      defaultProtocol: PROTOCOLS.has(text(c.default_protocol))
        ? (text(c.default_protocol) as NonNullable<HostGuest['console']['defaultProtocol']>)
        : undefined,
      resolution: str(c.resolution) ?? undefined,
      unavailable:
        c.unavailable && typeof c.unavailable === 'object'
          ? (c.unavailable as Record<string, string>)
          : undefined,
    }),
    vmid: int(g.vmid) ?? undefined,
    node: str(g.node) ?? undefined,
    lastBackup:
      backup && ts(backup.at) ? { result: text(backup.result), at: ts(backup.at) as string } : undefined,
    addresses: Array.isArray(g.addresses)
      ? g.addresses.filter((x): x is string => typeof x === 'string')
      : undefined,
    lock: str(g.lock) || undefined,
    restarts: num(g.restarts) ?? undefined,
    exitCode: num(g.exit_code) ?? undefined,
    oomKilled: optBool(g.oom_killed),
    project: str(g.project) || undefined,
    // Whombat's own containers (`whombat.service=1`, and the backup app it installs, shown under Backups kept here
    // instead): the apps leave them out of what people see.
    labels: ['1', 'backup-place'].includes(String(obj(g.labels)['whombat.service']))
      ? { 'whombat.service': '1' }
      : undefined,
    updateAvailable: optBool(g.update_available),
    diskUsedGb: num(g.disk_used_gb) ?? undefined,
    processes: num(g.processes) ?? undefined,
    tags: Array.isArray(g.tags) ? g.tags.filter((x): x is string => typeof x === 'string') : undefined,
    pendingChanges: num(g.pending_changes) ?? undefined,
    guestAgent: g.guest_agent === 'running' || g.guest_agent === 'not_running' ? g.guest_agent : undefined,
    oldestSnapshot: str(g.oldest_snapshot) ?? undefined,
    backupJob: typeof g.backup_job === 'boolean' ? g.backup_job : undefined,
    haState: str(g.ha_state) ?? undefined,
    // 0.83 (IU-02, §2.3): the guest this Whombat runs in, autostart (Docker on unRAID, libvirt), a container's web
    // page and whether a dockerMan template exists (Proxmox's own `template` means a template guest: not this).
    self: g.self === true ? true : undefined,
    autostart: optBool(g.autostart),
    webUi:
      platform === 'docker' && (typeof g.web_ui === 'string' || g.web_ui === null) ? g.web_ui : undefined,
    template: platform === 'docker' ? optBool(g.template) : undefined,
  }) as HostGuest;
}

function workload(raw: unknown, serverId: string): HostPlatformWorkload {
  const w = obj(raw);
  return defined({
    running: int(w.running) ?? 0,
    total: int(w.total) ?? 0,
    cpuPct: num(w.cpu_pct),
    memoryGb: num(w.memory_gb),
    containers: int(w.containers) ?? undefined,
    vms: int(w.vms) ?? undefined,
    paused: int(w.paused) ?? undefined,
    guests: arr(w.guests).map((g) => toHostGuest(g, serverId, true)),
    warnings: Array.isArray(w.warnings) ? (camel(w.warnings) as HostPlatformWorkload['warnings']) : undefined,
  }) as HostPlatformWorkload;
}

/** `GET /servers/{id}/guests` or `/guests` as `HostGuestPage`. */
export function toHostGuestPage(raw: unknown, serverId: string | null) {
  const p = obj(raw);
  const counts = p.counts ? obj(p.counts) : null;
  return defined({
    guests: arr(p.guests).map((g) => toHostGuest(g, serverId ?? text(obj(g).server))),
    total: int(p.total) ?? arr(p.guests).length,
    nextCursor: str(p.next_cursor),
    counts: counts
      ? {
          all: num(counts.all) ?? 0,
          running: num(counts.running) ?? 0,
          stopped: num(counts.stopped) ?? 0,
          unhealthy: num(counts.unhealthy) ?? 0,
        }
      : undefined,
    platforms:
      p.platforms && typeof p.platforms === 'object' ? (p.platforms as Record<string, number>) : undefined,
    tags: p.tags && typeof p.tags === 'object' ? (p.tags as Record<string, number>) : undefined,
  });
}

/* Server detail ------------------------------------------------------------------------------------------------------ */

function serverInfo(raw: unknown, alerts: readonly unknown[], agent: unknown): HostServerInfo {
  const s = obj(raw);
  const id = text(s.id, 'unknown');
  const os = s.os ? obj(s.os) : null;
  const cpu = s.cpu ? obj(s.cpu) : null;
  const mem = s.memory ? obj(s.memory) : null;
  const ag = obj(s.agent);
  const maintenance = s.maintenance ? obj(s.maintenance) : null;
  const verdict = alertVerdict(s, alerts, os === null && ag.last_sync_s_ago == null);
  return defined({
    id,
    group: text(s.group),
    status: verdict.status,
    statusNote: verdict.note,
    roles: arr(s.roles).filter((r): r is string => typeof r === 'string'),
    os: os ? { name: text(os.name), version: text(os.version), kernel: text(os.kernel) } : null,
    osFamily: osFamily(s.os_family, s.detail_view),
    cpu: cpu ? { model: text(cpu.model), cores: int(cpu.cores) ?? 0, threads: int(cpu.threads) ?? 0 } : null,
    memory: mem ? { totalGb: num(mem.total_gb) ?? 0, type: str(mem.type) } : null,
    uptimeS: num(s.uptime_s),
    lastBoot: ts(s.last_boot),
    address: str(s.address),
    location: str(s.location),
    agent: defined({
      version: str(ag.version) ?? (agent ? str(obj(agent).version) : null),
      lastSyncSAgo: num(ag.last_sync_s_ago),
      connected: optBool(ag.connected),
      clockSkewS: num(ag.clock_skew_s) ?? undefined,
    }),
    platform: serverPlatform(s.detail_view),
    hostsThisWhombat: s.hosts_this_whombat === true ? true : undefined,
    remoteControl: s.remote_control
      ? remoteControl(s.remote_control)
      : agent
        ? remoteControlFromAgent(agent)
        : { console: false, power: false },
    collectors: Array.isArray(s.collectors)
      ? s.collectors.map((c) => ({ name: text(obj(c).name), ok: bool(obj(c).ok), error: str(obj(c).error) }))
      : undefined,
    maintenance:
      maintenance && ts(maintenance.until)
        ? { id: text(maintenance.id), until: ts(maintenance.until) as string, note: text(maintenance.note) }
        : null,
    parent: str(s.parent),
  }) as HostServerInfo;
}

function sensor(raw: unknown): HostSensor {
  const s = obj(raw);
  return defined({
    id: text(s.id, 'sensor') || 'sensor',
    label: text(s.label),
    group: str(s.group) ?? undefined,
    source: text(s.source),
    nowC: num(s.now_c),
    maxC: num(s.max_24h_c) ?? num(s.max_c),
    limitC: num(s.limit_c),
  }) as HostSensor;
}

function disk(raw: unknown): HostDisk {
  const d = obj(raw);
  const type = text(d.type);
  const health = text(d.health);
  return defined({
    device: text(d.device),
    type: type === 'nvme' || type === 'hdd' || type === 'ssd' ? type : undefined,
    model: text(d.model),
    role: str(d.role) ?? undefined,
    pool: str(d.pool) ?? undefined,
    capacityGb: num(d.capacity_gb),
    usedGb: num(d.used_gb),
    wearPct: num(d.wear_pct),
    writtenTb: num(d.written_tb),
    ratedTbw: num(d.rated_tbw),
    tempC: num(d.temp_c),
    powerOnHours: num(d.power_on_hours),
    health: health === 'healthy' || health === 'wear_high' || health === 'failing' ? health : undefined,
    healthReason: str(d.health_reason),
    smart: d.smart && typeof d.smart === 'object' ? (camel(d.smart) as HostDisk['smart']) : undefined,
    io: d.io && typeof d.io === 'object' ? (camel(d.io) as HostDisk['io']) : d.io === null ? null : undefined,
  }) as HostDisk;
}

/** A Proxmox task or failed Incus operation of the health part, or a manage task status, as `HostTask`. */
export function toHostTask(raw: unknown): HostTask {
  const t = obj(raw);
  const status = text(t.status);
  // Health tasks carry `ok` and a free status; manage tasks the four states.
  const state: HostTask['status'] =
    status === 'running' || status === 'ok' || status === 'warning' || status === 'error'
      ? status
      : t.end == null && t.ended == null && !t.ok
        ? 'running'
        : t.ok === false
          ? 'error'
          : 'ok';
  const started = ts(t.started) ?? ts(t.start) ?? new Date(0).toISOString();
  const id = text(t.id) || `${text(t.type, 'task')}:${text(t.node)}:${started}`;
  return defined({
    id: id.slice(0, 500),
    type: text(t.type, 'task'),
    platform: str(t.platform) ?? undefined,
    guestId: str(t.guest) ?? (t.start !== undefined ? str(t.id) : null) ?? undefined,
    node: str(t.node) ?? undefined,
    user: str(t.user),
    started,
    ended: ts(t.ended) ?? ts(t.end),
    status: state,
    message: str(t.message) ?? (status && state !== status ? status : undefined) ?? undefined,
    log: Array.isArray(t.log) ? t.log.filter((x): x is string => typeof x === 'string') : undefined,
    logNext: int(t.log_next) ?? undefined,
    // An Incus operation says whether it may be cancelled (0.83, §2.2).
    cancellable: optBool(t.cancellable) ?? optBool(t.may_cancel),
    // A package task (0.98, server-updates.md SWU-04): why it ended early, and what it did once it ended.
    code: str(t.code) || undefined,
    packages: toPackagesResult(t.packages),
  }) as HostTask;
}

/** A package task's result (`installed`, `kept_back`, `warning`), or undefined while it runs or on another task. */
function toPackagesResult(raw: unknown): HostTask['packages'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const p = obj(raw);
  return {
    installed: Math.max(0, int(p.installed) ?? 0),
    keptBack: arr(p.kept_back).filter((x): x is string => typeof x === 'string'),
    warning: str(p.warning)?.trim() || null,
  };
}

/** The server's package task and how the last one ended (0.98, CT-501), as the contract has them; else null. */
function packageReport(system: J): J {
  const task = obj(system.packageTask);
  const last = obj(system.packageLast);
  const op = (v: unknown) => (v === 'install' ? 'install' : v === 'check' ? 'check' : null);
  if ('packageTask' in system)
    system.packageTask =
      str(task.id) && op(task.op) && ts(task.startedAt)
        ? { id: task.id, op: op(task.op), startedAt: ts(task.startedAt) }
        : null;
  if ('packageLast' in system)
    system.packageLast =
      op(last.op) && ts(last.finishedAt)
        ? {
            op: op(last.op),
            status: last.status === 'ok' ? 'ok' : 'failed',
            finishedAt: ts(last.finishedAt),
            installed: int(last.installed),
            message: str(last.message)?.trim() || null,
            code: str(last.code) || null,
          }
        : null;
  return system;
}

function health(d: J): HostServerDetail['health'] {
  const h: J = {};
  if (d.system !== undefined) h.system = d.system === null ? null : packageReport(obj(camel(d.system)));
  for (const k of ['network', 'volumes', 'arrays', 'ups', 'gpus', 'fans'] as const)
    if (Array.isArray(d[k])) h[k] = camel(d[k]);
  if (Array.isArray(d.tasks)) h.tasks = d.tasks.map(toHostTask);
  if (Array.isArray(d.pve_replication)) h.pveReplication = camel(d.pve_replication);
  if (d.ceph !== undefined) h.ceph = d.ceph === null ? null : camel(d.ceph);
  return h as HostServerDetail['health'];
}

/** `GET /servers/{id}` (+ open alerts and the agent row) as `HostServerDetail`. */
export function toHostServerDetail(
  raw: unknown,
  alerts: readonly unknown[],
  agent: unknown,
  now: Date,
): HostServerDetail {
  const d = obj(raw);
  const server = obj(d.server);
  const id = text(server.id, 'unknown');
  const live = d.live ? obj(d.live) : null;
  const banner = d.banner ? obj(d.banner) : null;
  const proxmox = server.detail_view === 'proxmox' || d.cluster !== undefined || d.storages !== undefined;
  const out: HostServerDetail = {
    asOf: ts(d.as_of) ?? now.toISOString(),
    server: serverInfo(server, alerts, agent),
    live: live
      ? (defined({
          refreshIntervalS: num(live.refresh_interval_s) ?? 10,
          cpuPct: num(live.cpu_pct),
          cpuUserPct: num(live.cpu_user_pct),
          cpuSystemPct: num(live.cpu_system_pct),
          cpuIowaitPct: num(live.cpu_iowait_pct),
          loadAvg: Array.isArray(live.load_avg) ? live.load_avg.map((x) => num(x) ?? 0) : null,
          memPct: num(live.mem_pct),
          memUsedGb: num(live.mem_used_gb),
          memCacheGb: num(live.mem_cache_gb) ?? undefined,
          zfsArcGb: num(live.zfs_arc_gb) ?? undefined,
          memFreeGb: num(live.mem_free_gb),
          swapUsedGb: num(live.swap_used_gb),
          swapTotalGb: num(live.swap_total_gb),
        }) as HostServerDetail['live'])
      : null,
    banner: banner
      ? defined({
          severity: banner.severity === 'critical' ? ('critical' as const) : ('warning' as const),
          title: text(banner.title),
          detail: text(banner.detail),
          section: section(banner.link),
          // The alert it shows (contracts CT-1068), so a client matches it by id.
          rule: str(banner.rule)?.slice(0, 80) || undefined,
          alertId: str(banner.alert_id)?.slice(0, 200) || undefined,
        })
      : null,
    sensors: arr(d.sensors).map(sensor),
    disks: arr(d.disks).map(disk),
    virtualization: d.virtualization ? (camel(d.virtualization) as HostServerDetail['virtualization']) : null,
    // Whombat's Worth a look about the agent's updates, and the hub's “differs from the hub” only where it still helps
    // (agent-updates-server.md AU-S05).
    hints: withAgentUpdateHints(
      arr(d.hints).map(toHostHint),
      id,
      agent && obj(agent).update ? toAgentUpdate(obj(agent).update) : null,
    ),
    alerts: alerts.filter((a) => obj(a).server === id).map(toHostAlert),
    health: health(d),
  };
  if (Array.isArray(d.disk_usage)) {
    const list = d.disk_usage.map((u) => toHostDiskUsage(u, now)).filter((u) => u.mount.length > 0);
    if (list.length) out.diskUsage = list;
  }
  if (d.incus && typeof d.incus === 'object') out.incus = toHostIncusDetail(d.incus);
  if (d.unraid && typeof d.unraid === 'object') out.unraid = toHostUnraidDetail(d.unraid);
  if (d.libvirt && typeof d.libvirt === 'object') out.libvirt = toHostLibvirtDetail(d.libvirt);
  if (d.macos && typeof d.macos === 'object') out.macos = toHostMacosDetail(d.macos);
  if (!proxmox) {
    const w = obj(d.workloads);
    const workloads: Record<string, HostPlatformWorkload> = {};
    for (const k of ['docker', 'incus', 'libvirt'] as const) if (w[k]) workloads[k] = workload(w[k], id);
    out.workloads = workloads as HostServerDetail['workloads'];
  } else {
    const g = obj(d.guests);
    const backups = d.backups ? obj(d.backups) : null;
    out.proxmox = {
      cluster: d.cluster ? (camel(d.cluster) as NonNullable<HostServerDetail['proxmox']>['cluster']) : null,
      storages: arr(d.storages).map((s) => {
        const st = obj(s);
        return {
          id: text(st.id),
          type: text(st.type),
          content: text(st.content),
          usedGb: num(st.used_gb) ?? 0,
          capacityGb: num(st.capacity_gb) ?? 0,
        };
      }),
      backups: backups
        ? (defined({
            lastJob: backups.last_job ? (camel(backups.last_job) as J) : null,
            nextRun: ts(backups.next_run),
            target: str(backups.target),
          }) as NonNullable<HostServerDetail['proxmox']>['backups'])
        : null,
      guests: defined({
        vm: g.vm ? workload(g.vm, id) : undefined,
        container: g.container ? workload(g.container, id) : undefined,
      }),
    };
  }
  return out;
}

/* Incus and unRAID (0.83, IU-04, IU-05; the build brief §2.2, §2.3) ------------------------------------------------- */

const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
const count = (v: unknown): number => int(v) ?? (Array.isArray(v) ? v.length : 0);

/** The Incus part of a detail: projects, pools, networks, profiles, images, custom volumes. */
export function toHostIncusDetail(raw: unknown): HostIncusDetail {
  const i = obj(raw);
  return {
    version: text(i.version),
    clustered: bool(i.clustered),
    projects: arr(i.projects).map((x) => {
      const p = obj(x);
      return {
        name: text(p.name),
        description: text(p.description),
        instances: int(p.instances) ?? 0,
        running: int(p.running) ?? 0,
      };
    }),
    pools: arr(i.pools).map((x) => {
      const p = obj(x);
      return {
        name: text(p.name),
        driver: text(p.driver),
        status: text(p.status),
        description: text(p.description),
        usedBytes: num(p.used_bytes),
        totalBytes: num(p.total_bytes),
        volumes: int(p.volumes) ?? 0,
      };
    }),
    networks: arr(i.networks).map((x) => {
      const n = obj(x);
      return {
        name: text(n.name),
        type: text(n.type),
        managed: bool(n.managed),
        description: text(n.description),
        ipv4: str(n.ipv4) || null,
        ipv6: str(n.ipv6) || null,
        nat: typeof n.nat === 'boolean' ? n.nat : null,
        usedBy: count(n.used_by),
      };
    }),
    profiles: arr(i.profiles).map((x) => {
      const p = obj(x);
      return {
        name: text(p.name),
        project: text(p.project, 'default') || 'default',
        description: text(p.description),
        usedBy: count(p.used_by),
      };
    }),
    // An image is named by its fingerprint: one without isn't one Whombat can act on.
    images: arr(i.images)
      .filter((x) => str(obj(x).fingerprint))
      .map((x) => {
        const m = obj(x);
        return {
          fingerprint: text(m.fingerprint),
          aliases: strs(m.aliases),
          description: text(m.description),
          type: m.type === 'virtual-machine' ? ('virtual-machine' as const) : ('container' as const),
          architecture: text(m.architecture),
          sizeBytes: num(m.size_bytes) ?? 0,
          uploadedAt: ts(m.uploaded_at),
          lastUsedAt: ts(m.last_used_at),
          autoUpdate: bool(m.auto_update),
          cached: bool(m.cached),
          project: text(m.project, 'default') || 'default',
        };
      }),
    volumes: arr(i.volumes).map(toHostStorageVolume),
  };
}

export function toHostStorageVolume(raw: unknown): HostStorageVolume {
  const v = obj(raw);
  const content = text(v.content_type);
  return {
    pool: text(v.pool),
    name: text(v.name),
    project: text(v.project, 'default') || 'default',
    type: 'custom',
    contentType: content === 'block' || content === 'iso' ? content : 'filesystem',
    sizeBytes: num(v.size_bytes),
    usedBytes: num(v.used_bytes),
    usedBy: strs(v.used_by),
    description: text(v.description),
  };
}

const DISK_STATUS = new Set(['ok', 'disabled', 'emulated', 'missing', 'new', 'invalid', 'wrong', 'empty']);
const DISK_SLOTS = new Set(['parity', 'data', 'pool', 'flash']);

export function toHostUnraidDisk(raw: unknown): HostUnraidDisk {
  const d = obj(raw);
  const status = text(d.status);
  const slot = text(d.slot);
  return {
    name: text(d.name),
    slot: (DISK_SLOTS.has(slot) ? slot : 'data') as HostUnraidDisk['slot'],
    device: str(d.device) || null,
    model: str(d.model) || null,
    serial: str(d.serial) || null,
    status: (DISK_STATUS.has(status) ? status : 'invalid') as HostUnraidDisk['status'],
    statusRaw: text(d.status_raw),
    sizeBytes: num(d.size_bytes) ?? 0,
    usedBytes: num(d.used_bytes),
    freeBytes: num(d.free_bytes),
    fsType: str(d.fs_type) || null,
    tempC: num(d.temp_c),
    spunDown: bool(d.spun_down),
    errors: int(d.errors) ?? 0,
    rotational: typeof d.rotational === 'boolean' ? d.rotational : null,
  };
}

function parityRun(raw: unknown): HostUnraidParityRun | null {
  const r = obj(raw);
  const at = ts(r.at);
  if (!at) return null;
  const result = text(r.result);
  return {
    at,
    durationS: num(r.duration_s),
    speedMbs: num(r.speed_mbs),
    errors: int(r.errors) ?? 0,
    result: (['ok', 'errors', 'cancelled', 'failed'].includes(result)
      ? result
      : 'ok') as HostUnraidParityRun['result'],
    action: str(r.action) || null,
  };
}

const ARRAY_STATES = new Set(['started', 'stopped', 'starting', 'stopping', 'invalid']);
const PARITY_ACTIONS = new Set(['check', 'correct', 'rebuild', 'clear']);

/** The unRAID part of a detail: the array with parity and disks, pools, shares, plugins, notifications, updates. */
export function toHostUnraidDetail(raw: unknown): HostUnraidDetail {
  const u = obj(raw);
  const a = obj(u.array);
  const p = obj(a.parity);
  const state = text(a.state);
  const pState = text(p.state);
  const pAction = text(p.action);
  const osUpdate = u.os_update ? obj(u.os_update) : null;
  const docker = obj(u.docker);
  return {
    version: text(u.version),
    name: text(u.name),
    license: str(u.license) || null,
    osUpdate: osUpdate && str(osUpdate.version) ? { version: text(osUpdate.version) } : null,
    array: {
      state: (ARRAY_STATES.has(state) ? state : 'invalid') as HostUnraidDetail['array']['state'],
      stateRaw: text(a.state_raw),
      startOnBoot: bool(a.start_on_boot),
      sizeBytes: num(a.size_bytes) ?? 0,
      usedBytes: num(a.used_bytes) ?? 0,
      freeBytes: num(a.free_bytes) ?? 0,
      disabled: int(a.disabled) ?? 0,
      invalid: int(a.invalid) ?? 0,
      missing: int(a.missing) ?? 0,
      moverRunning: bool(a.mover_running),
      parity: {
        state: (pState === 'running' || pState === 'paused' ? pState : 'idle') as
          | 'idle'
          | 'running'
          | 'paused',
        action: (PARITY_ACTIONS.has(pAction)
          ? pAction
          : null) as HostUnraidDetail['array']['parity']['action'],
        pct: num(p.pct),
        speedMbs: num(p.speed_mbs),
        etaS: num(p.eta_s),
        errors: int(p.errors) ?? 0,
        last: p.last ? parityRun(p.last) : null,
        history: arr(p.history)
          .map(parityRun)
          .filter((r): r is HostUnraidParityRun => r !== null)
          .slice(0, 10),
        schedule: str(p.schedule) || null,
      },
      disks: arr(a.disks).map(toHostUnraidDisk),
    },
    pools: arr(u.pools).map((x) => {
      const pool = obj(x);
      return {
        name: text(pool.name),
        fsType: text(pool.fs_type),
        profile: str(pool.profile) || null,
        sizeBytes: num(pool.size_bytes) ?? 0,
        usedBytes: num(pool.used_bytes) ?? 0,
        freeBytes: num(pool.free_bytes) ?? 0,
        disks: arr(pool.disks).map(toHostUnraidDisk),
      };
    }),
    flash: u.flash ? toHostUnraidDisk(u.flash) : null,
    shares: arr(u.shares).map((x) => {
      const sh = obj(x);
      const mover = text(sh.mover_action);
      return {
        name: text(sh.name),
        comment: text(sh.comment),
        usedBytes: num(sh.used_bytes) ?? 0,
        freeBytes: num(sh.free_bytes) ?? 0,
        primary: text(sh.primary, 'array') || 'array',
        secondary: str(sh.secondary) || null,
        moverAction: mover === 'to_array' || mover === 'to_pool' ? mover : null,
        smb: str(sh.smb) || null,
        nfs: bool(sh.nfs),
        encrypted: bool(sh.encrypted),
      };
    }),
    plugins: arr(u.plugins).map((x) => {
      const pl = obj(x);
      return {
        name: text(pl.name),
        file: text(pl.file),
        version: text(pl.version),
        update: str(pl.update) || null,
        author: str(pl.author) || null,
        supportUrl: str(pl.support_url) || null,
      };
    }),
    notifications: arr(u.notifications)
      .filter((x) => str(obj(x).id))
      .map((x) => {
        const n = obj(x);
        const importance = text(n.importance);
        return {
          id: text(n.id).slice(0, 200),
          at: ts(n.at) ?? new Date(0).toISOString(),
          importance: (importance === 'alert' || importance === 'warning' ? importance : 'normal') as
            | 'alert'
            | 'warning'
            | 'normal',
          event: text(n.event),
          subject: text(n.subject),
          description: text(n.description),
        };
      })
      .slice(0, 50),
    docker: { enabled: bool(docker.enabled), imageUsedPct: num(docker.image_used_pct) },
    vms: { enabled: bool(obj(u.vms).enabled) },
  };
}

/* macOS (macos-servers.md) ---------------------------------------------------------------------------- */

/** A name the hub sends as `""` for none (`auto_login`, `console_user`, `account`) as null. */
const named = (v: unknown, max = 200): string | null => {
  const s = str(v)?.trim();
  return s ? s.slice(0, max) : null;
};

/** A boolean the hub leaves out when unknown (`sip`, `filevault`, `locked`, `ax`) as null. */
const known = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** A size the hub sends as 0 when it has none as null. */
const pixels = (v: unknown): number | null => {
  const n = int(v);
  return n !== null && n > 0 ? n : null;
};

/** A time Go sends as its zero value (`0001-01-01T00:00:00Z`) when there is none as null. */
const goTime = (v: unknown): string | null => {
  const t = ts(v);
  return t && Date.parse(t) > Date.parse('2000-01-01T00:00:00Z') ? t : null;
};

/** A Mac's screen as its agent reports it (`macos.screen`, a screen step's `status`). */
export function toHostMacScreen(raw: unknown): HostMacScreen {
  const s = obj(raw);
  const signIn = str(s.sign_in);
  return {
    sharing: bool(s.sharing),
    account: named(s.account),
    signIn: signIn === 'ok' || signIn === 'failed' ? signIn : null,
    signInAt: goTime(s.sign_in_at),
    locked: known(s.locked),
    w: pixels(s.w),
    h: pixels(s.h),
  };
}

/** Whombat Helper on a Mac as its agent reports it (`macos.helper`, a screen step's `helper`). */
export function toHostMacHelper(raw: unknown): HostMacHelper {
  const h = obj(raw);
  return {
    installed: bool(h.installed),
    version: named(h.version, 60),
    running: bool(h.running),
    ax: known(h.ax),
    user: named(h.user),
    // Helpers before 1.1.0 don't say how long the Mac has been left alone: unknown, not “just now”.
    ...(h.idle_s === undefined ? {} : { idleS: idleSeconds(h.idle_s) }),
  };
}

/** Whole seconds since someone last used the Mac, or null when the helper couldn't tell. */
const idleSeconds = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.floor(n) : null;
};

/** A place the Mac's geocoder found, or null (nothing found, or a part that can't be read). */
function toHostMapPlace(raw: unknown): HostMapPlace | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = obj(raw);
  const lat = num(p.lat);
  const lon = num(p.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, accuracyM: Math.max(0, num(p.accuracy_m) ?? 0) };
}

/** Where a pin is in a map picture, or null where it falls outside (or can't be read). */
function toHostMapPoint(raw: unknown): HostMapPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = obj(raw);
  const x = num(p.x);
  const y = num(p.y);
  return x === null || y === null ? null : { x, y };
}

/** The `macos` part of a Mac's detail: its facts, its screen and its helper. */
export function toHostMacosDetail(raw: unknown): HostMacosDetail {
  const m = obj(raw);
  return {
    version: text(m.version),
    build: named(m.build, 60),
    model: named(m.model, 60),
    modelName: named(m.model_name),
    chip: named(m.chip),
    sip: known(m.sip),
    filevault: known(m.filevault),
    autoLogin: named(m.auto_login),
    consoleUser: named(m.console_user),
    screen: toHostMacScreen(m.screen),
    helper: toHostMacHelper(m.helper),
  };
}

const SCREEN_CODES: ReadonlySet<string> = new Set(HOST_SCREEN_CODES);
/** Values the helper cuts to 200 characters; Whombat keeps a little more room. */
const uiText = (v: unknown, max = 400): string | null => {
  const s = str(v);
  return s ? s.slice(0, max) : null;
};

/** An element as Whombat Helper names it (`desc`, `ident`) or as the hub spells it out. */
export function toHostUiElement(raw: unknown): HostUiElement {
  const e = obj(raw);
  return {
    id: text(e.id).slice(0, 200),
    role: text(e.role).slice(0, 100),
    subrole: uiText(e.subrole, 100),
    title: uiText(e.title),
    description: uiText(e.desc ?? e.description),
    value: uiText(e.value),
    identifier: uiText(e.ident ?? e.identifier),
    enabled: e.enabled !== false,
    focused: bool(e.focused),
    x: int(e.x) ?? 0,
    y: int(e.y) ?? 0,
    w: int(e.w) ?? 0,
    h: int(e.h) ?? 0,
    actions: arr(e.actions)
      .filter((a): a is string => typeof a === 'string')
      .slice(0, 30)
      .map((a) => a.slice(0, 100)),
    app: uiText(e.app, 200),
    window: uiText(e.window, 300),
  };
}

function toHostUiApp(raw: unknown): HostUiApp {
  const a = obj(raw);
  return {
    name: text(a.name).slice(0, 200),
    bundleId: uiText(a.bundle_id ?? a.bundleId, 200),
    pid: int(a.pid) ?? 0,
    active: bool(a.active),
    windows: arr(a.windows)
      .filter((w): w is string => typeof w === 'string')
      .slice(0, 100)
      .map((w) => w.slice(0, 300)),
  };
}

/**
 * `POST /servers/{id}/screen`'s answer as `HostScreenResult`: the picture stays base64 as the hub sent
 * it, the rest in camelCase; a code the contract doesn't know is `failed`.
 */
export function toHostScreenResult(raw: unknown, serverId: string, op: HostScreenOp): HostScreenResult {
  const r = obj(raw);
  const code = str(r.code);
  const format = str(r.format);
  const n = (v: unknown) => {
    const x = int(v);
    return x !== null && x >= 0 ? x : undefined;
  };
  return defined({
    server: text(r.server, serverId) || serverId,
    op,
    ok: r.ok === true,
    code: code ? ((SCREEN_CODES.has(code) ? code : 'failed') as HostScreenCode) : undefined,
    message: str(r.message)?.slice(0, 2000) || undefined,
    imageB64: str(r.image_b64) || undefined,
    format: format === 'png' || format === 'jpeg' ? format : undefined,
    w: n(r.w),
    h: n(r.h),
    screenW: n(r.screen_w),
    screenH: n(r.screen_h),
    elements: Array.isArray(r.elements) ? r.elements.slice(0, 1000).map(toHostUiElement) : undefined,
    apps: Array.isArray(r.apps) ? r.apps.slice(0, 200).map(toHostUiApp) : undefined,
    element: r.element && typeof r.element === 'object' ? toHostUiElement(r.element) : undefined,
    status: r.status && typeof r.status === 'object' ? toHostMacScreen(r.status) : undefined,
    helper: r.helper && typeof r.helper === 'object' ? toHostMacHelper(r.helper) : undefined,
    truncated: r.truncated === true ? true : undefined,
    places: Array.isArray(r.places)
      ? r.places.slice(0, HOST_SCREEN_LIMITS.queries).map(toHostMapPlace)
      : undefined,
    points: Array.isArray(r.points)
      ? r.points.slice(0, HOST_SCREEN_LIMITS.pins).map(toHostMapPoint)
      : undefined,
    lat: num(r.lat) ?? undefined,
    lon: num(r.lon) ?? undefined,
    spanM: num(r.span_m) ?? undefined,
    auditId: str(r.audit_id)?.slice(0, 200) || undefined,
  }) as HostScreenResult;
}

/** The libvirt part of a detail (0.84, IU-13): pools, networks, unRAID's VM folders, firmware, the backups folder. */
export function toHostLibvirtDetail(raw: unknown): HostLibvirtDetail {
  const l = obj(raw);
  const folders = l.folders && typeof l.folders === 'object' ? obj(l.folders) : null;
  const fw = obj(l.firmware);
  const size = (v: unknown) => Math.max(0, num(v) ?? 0);
  return {
    version: text(l.version),
    qemu: str(l.qemu) || null,
    pools: arr(l.pools).map((x) => {
      const p = obj(x);
      return {
        name: text(p.name),
        type: text(p.type),
        active: bool(p.active),
        autostart: bool(p.autostart),
        path: str(p.path) || null,
        usedBytes: size(p.used_bytes),
        totalBytes: size(p.total_bytes),
        availBytes: size(p.avail_bytes),
        volumes: Math.max(0, int(p.volumes) ?? 0),
      };
    }),
    networks: arr(l.networks).map((x) => {
      const n = obj(x);
      return {
        name: text(n.name),
        active: bool(n.active),
        autostart: bool(n.autostart),
        bridge: str(n.bridge) || null,
        forward: str(n.forward) || null,
        ipv4: str(n.ipv4) || null,
        dhcp: bool(n.dhcp),
        usedBy: Math.max(0, count(n.used_by)),
      };
    }),
    folders: folders ? { domains: str(folders.domains) || null, isos: str(folders.isos) || null } : null,
    firmware: { uefi: bool(fw.uefi), secureBoot: bool(fw.secure_boot), tpm: bool(fw.tpm) },
    backupsDir: str(l.backups_dir) || null,
  };
}

/** `profile.get`: an Incus profile (the answer itself, or under `profile`). */
export function toHostIncusProfile(raw: unknown): HostIncusProfile {
  const r = obj(raw);
  const p = r.profile && typeof r.profile === 'object' ? obj(r.profile) : r;
  const devices: Record<string, Record<string, string>> = {};
  for (const [name, dev] of Object.entries(obj(p.devices)))
    devices[name] = Object.fromEntries(Object.entries(obj(dev)).map(([k, v]) => [k, String(v ?? '')]));
  return {
    name: text(p.name),
    project: text(p.project, 'default') || 'default',
    description: text(p.description),
    config: Object.fromEntries(Object.entries(obj(p.config)).map(([k, v]) => [k, String(v ?? '')])),
    devices,
    usedBy: strs(p.used_by),
    restricted: strs(p.restricted),
    digest: text(p.digest),
  };
}

/** `network.leases`: an Incus network's address leases. */
export function toHostNetworkLeases(raw: unknown): HostNetworkLease[] {
  return arr(obj(raw).items).map((x) => {
    const l = obj(x);
    return {
      hostname: text(l.hostname),
      address: text(l.address),
      hwaddr: text(l.hwaddr),
      type: text(l.type),
      guestId: str(l.guest) || str(l.guest_id) || null,
    };
  });
}

/** `log.get`: the last lines of an instance's log. */
export function toHostGuestLog(raw: unknown): { file: string; lines: string[] } {
  const r = obj(raw);
  return { file: text(r.file), lines: strs(r.lines).slice(-2000) };
}

/** Every guest of a detail (standard workloads or Proxmox's VMs and containers). */
export function guestsOfDetail(detail: HostServerDetail): HostGuest[] {
  if (detail.proxmox)
    return [...(detail.proxmox.guests.vm?.guests ?? []), ...(detail.proxmox.guests.container?.guests ?? [])];
  return Object.values(detail.workloads ?? {}).flatMap((w) => w?.guests ?? []);
}

/* Metrics ------------------------------------------------------------------------------------------------------------ */

export function toHostSeries(raw: unknown, serverId: string, guestId: string | null, now: Date): HostSeries {
  const m = obj(raw);
  const series: Record<string, (number | null)[]> = {};
  for (const [k, v] of Object.entries(obj(m.series))) series[k] = arr(v).map((p) => num(p));
  const summary: Record<string, { avg: number | null; max: number | null; maxAt: string | null } | null> = {};
  for (const [k, v] of Object.entries(obj(m.summary))) {
    const s = v ? obj(v) : null;
    summary[k] = s ? { avg: num(s.avg), max: num(s.max), maxAt: ts(s.max_at) } : null;
  }
  const range = text(m.range, '24h');
  const step = int(m.step_seconds);
  return defined({
    serverId: text(m.server, serverId) || serverId,
    guestId: guestId ?? (str(m.guest) || undefined),
    range: (['1h', '6h', '24h', '7d', '30d', '90d', 'custom'].includes(range)
      ? range
      : 'custom') as HostSeries['range'],
    stepSeconds: step && step > 0 ? step : 60,
    asOf: ts(m.as_of) ?? now.toISOString(),
    timestamps: arr(m.timestamps)
      .map((t) => ts(t))
      .filter((t): t is string => t !== null),
    series,
    summary: Object.keys(summary).length ? summary : undefined,
  }) as HostSeries;
}

/* Settings, maintenance, checks, enrollment -------------------------------------------------------------------------- */

export function toHostServerSettings(raw: unknown, agent: unknown): HostServerSettings {
  const s = obj(raw);
  const a = agent ? obj(agent) : null;
  const update = a?.update ? obj(a.update) : null;
  return defined({
    id: text(s.id),
    group: text(s.group),
    location: str(s.location),
    remoteControl: toggles(s.remote_control),
    agentPolicy: toggles(s.agent_policy),
    parent: str(s.parent) ?? undefined,
    detectedParent: str(s.detected_parent),
    agent: a
      ? defined({
          version: str(a.version),
          arch: str(a.arch) ?? undefined,
          install: str(a.install),
          certExpiresAt: ts(a.cert_expires_at),
          // The 0.99 fields (agent-updates.md AU-08; contracts CT-511) when the hub sends them.
          update: update ? toAgentUpdate(update) : undefined,
        })
      : undefined,
  }) as HostServerSettings;
}

export function toHostMaintenance(raw: unknown): HostMaintenance {
  const m = obj(raw);
  const scope = text(m.scope);
  return {
    id: text(m.id),
    scope: scope === 'group' || scope === 'all' ? scope : 'server',
    target: text(m.target),
    startsAt: ts(m.starts_at) ?? new Date(0).toISOString(),
    endsAt: ts(m.ends_at),
    weekdays: arr(m.weekdays)
      .map((d) => int(d))
      .filter((d): d is number => d !== null && d >= 0 && d <= 6),
    startTime: text(m.start_time),
    durationMin: int(m.duration_min) ?? 0,
    tz: text(m.tz, 'UTC') || 'UTC',
    note: text(m.note),
    createdBy: text(m.created_by),
    createdAt: ts(m.created_at) ?? new Date(0).toISOString(),
    active: bool(m.active),
    activeUntil: ts(m.active_until),
    nextStart: ts(m.next_start),
  };
}

export function toHostWatchLimits(raw: unknown) {
  return arr(obj(raw).limits).flatMap((row) => {
    const entry = obj(row);
    const rule = text(entry.rule);
    const range = hostWatchLimit(rule);
    const value = num(entry.value);
    if (!range || value === null || value < range.min || value > range.max) return [];
    const entity = str(entry.entity) || undefined;
    return [{ rule, entity, value }];
  });
}

export function toHostCheck(raw: unknown) {
  const c = obj(raw);
  const last = c.last ? obj(c.last) : null;
  const kind = text(c.kind);
  const status = text(c.status);
  return {
    id: text(c.id),
    name: text(c.name),
    kind: (['http', 'tcp', 'ping', 'dns', 'heartbeat'].includes(kind) ? kind : 'http') as
      | 'http'
      | 'tcp'
      | 'ping'
      | 'dns'
      | 'heartbeat',
    target: text(c.target),
    runner: text(c.runner, 'hub') || 'hub',
    intervalS: int(c.interval_s) ?? 60,
    timeoutS: int(c.timeout_s) ?? 10,
    graceS: int(c.grace_s) ?? 0,
    options: camel(obj(c.options)) as Record<string, unknown>,
    enabled: bool(c.enabled),
    ...(typeof c.owner === 'string' && c.owner ? { owner: c.owner } : {}),
    ...(typeof c.stale === 'boolean' ? { stale: c.stale } : {}),
    status: (['up', 'down', 'pending', 'disabled'].includes(status) ? status : 'pending') as
      | 'up'
      | 'down'
      | 'pending'
      | 'disabled',
    since: ts(c.since),
    last:
      last && ts(last.at)
        ? defined({
            at: ts(last.at) as string,
            ok: bool(last.ok),
            latencyMs: num(last.latency_ms),
            error: str(last.error) ?? undefined,
            statusCode: num(last.status_code) ?? undefined,
            certNotAfter: str(last.cert_not_after) ?? undefined,
            answer: Array.isArray(last.answer)
              ? last.answer.filter((x): x is string => typeof x === 'string')
              : undefined,
          })
        : null,
    lastPing: ts(c.last_ping),
    uptime24h: num(c.uptime_24h),
    latency24h: arr(c.latency_24h).map((p) => num(p)),
    pingUrl: str(c.ping_url),
    createdBy: text(c.created_by),
  };
}

/** A level the hub stored on an enrollment (0.85, SI-06), or null when it has none. */
function controlLevel(v: unknown): HostControlLevel | null {
  return typeof v === 'string' && (HOST_CONTROL_LEVELS as readonly string[]).includes(v)
    ? (v as HostControlLevel)
    : null;
}

export function toHostEnrollment(raw: unknown): HostEnrollment {
  const e = obj(raw);
  const control = controlLevel(e.control);
  return {
    id: text(e.id),
    expiresAt: ts(e.expires_at) ?? new Date(Date.now() + 3600_000).toISOString(),
    // The hub starts the command with a space (kept out of shell history); the copy button copies it as it is.
    installCommand: text(e.install_command).slice(0, 4000),
    ...(control ? { control } : {}),
    // Every enrollment Whombat makes is pre-approved (SI-07); an older hub doesn't say.
    ...(typeof e.approve === 'boolean' ? { preApproved: e.approve } : {}),
  };
}

export function toHostPendingEnrollment(raw: unknown): HostPendingEnrollment {
  const e = obj(raw);
  const state = text(e.state, 'pending');
  return defined({
    id: text(e.id),
    state: (['pending', 'issued', 'approved', 'rejected', 'expired'].includes(state)
      ? state
      : 'pending') as HostPendingEnrollment['state'],
    hostname: str(e.hostname),
    os: str(e.os),
    address: str(e.address),
    agentVersion: str(e.agent_version),
    requestedAt: ts(e.requested_at),
    createdAt: ts(e.created_at),
    expiresAt: ts(e.expires_at),
    serverId: str(e.server_id),
    // The level an approval applies and the name it was made for (0.85); null for an older enrollment.
    control: controlLevel(e.control),
    name: str(e.name),
  }) as HostPendingEnrollment;
}

/* Inspect, snapshots, manage ----------------------------------------------------------------------------------------- */

/** The agent's Go field names (`PID`, `CPUPct`) → the contract's (`pid`, `cpuPct`). */
function goItem(raw: unknown): J {
  const out: J = {};
  for (const [k, v] of Object.entries(obj(raw))) {
    const key = k
      .replace(/^(PID|PPID|CPU|RSS)/, (m) => m.toLowerCase())
      .replace(/^[A-Z]/, (c) => c.toLowerCase())
      .replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[key] = v;
  }
  return out;
}

export function toHostInspect(raw: unknown, kind: HostInspectKind, now: Date): HostInspectResult {
  const r = obj(raw);
  const items = arr(r.items).map((i) => {
    const x = goItem(i);
    if (kind === 'processes')
      return defined({
        pid: int(x.pid) ?? 0,
        ppid: int(x.ppid) ?? undefined,
        user: text(x.user),
        name: text(x.name),
        command: text(x.command),
        cpuPct: num(x.cpuPct) ?? 0,
        rssBytes: num(x.rssBytes) ?? 0,
        state: text(x.state),
        threads: num(x.threads) ?? undefined,
        container: str(x.container) || undefined,
        started: str(x.started) || undefined,
      });
    if (kind === 'ports')
      return defined({
        proto: text(x.proto),
        address: text(x.address),
        port: int(x.port) ?? 0,
        pid: int(x.pid) ?? undefined,
        process: str(x.process) || undefined,
      });
    if (kind === 'services')
      return defined({
        name: text(x.name),
        description: str(x.description) || undefined,
        load: str(x.load) || undefined,
        active: text(x.active),
        sub: str(x.sub) || undefined,
        enabled: str(x.enabled) || undefined,
        since: str(x.since) || undefined,
      });
    return defined({
      name: text(x.name),
      current: str(x.current) || undefined,
      new: text(x.new),
      security: optBool(x.security),
      source: str(x.source) || undefined,
    });
  });
  return {
    kind,
    asOf: ts(r.as_of) ?? now.toISOString(),
    truncated: bool(r.truncated),
    items,
  } as HostInspectResult;
}

/** One on-request disk usage breakdown (`GET /servers/{id}` `disk_usage`, `POST /servers/{id}/disk-usage`). */
export function toHostDiskUsage(raw: unknown, now: Date): HostDiskUsage {
  const r = obj(raw);
  const nonNeg = (v: unknown) => {
    const n = num(v);
    return n !== null && n >= 0 ? n : 0;
  };
  const categories = arr(r.categories)
    .map((item) => {
      const c = obj(item);
      const key = text(c.key).slice(0, 64);
      const label = text(c.label).slice(0, 120);
      if (!key || !label) return null;
      const reclaimable = num(c.reclaimable_bytes);
      return defined({
        key,
        label,
        bytes: nonNeg(c.bytes),
        reclaimableBytes: reclaimable !== null && reclaimable > 0 ? reclaimable : undefined,
        detail: str(c.detail)?.slice(0, 200) || undefined,
      });
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const folders = arr(r.folders)
    .map((item) => {
      const f = obj(item);
      const path = text(f.path).slice(0, 512);
      if (!path) return null;
      return defined({
        path,
        bytes: nonNeg(f.bytes),
        partial: f.partial === true ? true : undefined,
      });
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  const spunDown = arr(r.skipped_spun_down).filter((x): x is string => typeof x === 'string' && x.length > 0);
  const durationMs = num(r.duration_ms);
  return defined({
    mount: text(r.mount).slice(0, 512),
    fsType: str(r.fs_type)?.slice(0, 64) || undefined,
    device: str(r.device)?.slice(0, 256) || undefined,
    measuredAt: ts(r.measured_at) ?? now.toISOString(),
    durationMs: durationMs !== null && durationMs >= 0 ? durationMs : undefined,
    totalBytes: nonNeg(r.total_bytes),
    usedBytes: nonNeg(r.used_bytes),
    partial: r.partial === true ? true : undefined,
    skippedSpunDown: spunDown.length ? spunDown : undefined,
    categories,
    folders,
    ok: typeof r.ok === 'boolean' ? r.ok : undefined,
    code: str(r.code)?.slice(0, 64) || undefined,
    message: str(r.message)?.slice(0, 500) || undefined,
  }) as HostDiskUsage;
}

export function toHostSnapshots(raw: unknown): HostSnapshot[] {
  return arr(obj(raw).items).map((i) => {
    const x = goItem(i);
    return defined({
      name: text(x.name),
      created: str(x.created) || undefined,
      description: str(x.description) || undefined,
      parent: str(x.parent) || undefined,
      memory: optBool(x.withMemory) ?? optBool(x.memory),
      current: optBool(x.current),
      sizeBytes: num(x.sizeBytes) ?? undefined,
    }) as HostSnapshot;
  });
}

export function toHostGuestConfig(raw: unknown): HostGuestConfig {
  const c = camel(raw) as J;
  return {
    ...c,
    platform: c.platform === 'incus' || c.platform === 'libvirt' ? c.platform : 'pve',
    kind: c.kind === 'container' ? 'container' : 'vm',
    digest: text(c.digest),
    running: bool(c.running),
    values: Object.fromEntries(Object.entries(obj(c.values)).map(([k, v]) => [k, String(v ?? '')])),
  } as HostGuestConfig;
}

export const toHostChoices = (raw: unknown): HostChoices => {
  const c = camel(raw) as J;
  return {
    ...c,
    platform: c.platform === 'incus' || c.platform === 'libvirt' ? c.platform : 'pve',
    storages: arr(c.storages) as HostChoices['storages'],
    bridges: arr(c.bridges).filter((b): b is string => typeof b === 'string'),
  } as HostChoices;
};
export const toHostFirewall = (raw: unknown): HostFirewall => {
  const f = camel(raw) as J;
  return {
    ...f,
    options: obj(f.options),
    rules: arr(f.rules),
    clusterEnabled: bool(f.clusterEnabled),
  } as HostFirewall;
};
export const toHostBackupVolumes = (raw: unknown): HostBackupVolume[] =>
  arr(obj(raw).items).map((b) => camel(b) as HostBackupVolume);

/** A Proxmox backup job (the hub's `BackupJob`, the Proxmox build brief §2.1): ids, `null` for what isn't set. */
export function toHostBackupJob(raw: unknown): HostBackupJob {
  const j = obj(raw);
  const ids = (v: unknown) => arr(v).filter((x): x is string => typeof x === 'string' && x.length > 0);
  const keep = j.keep && typeof j.keep === 'object' ? obj(j.keep) : null;
  const selection = text(j.selection);
  const mode = text(j.mode);
  return defined({
    id: text(j.id, 'unknown') || 'unknown',
    enabled: j.enabled !== false,
    schedule: text(j.schedule),
    storage: text(j.storage),
    node: str(j.node),
    selection: (selection === 'guests' || selection === 'pool'
      ? selection
      : 'all') as HostBackupJob['selection'],
    guests: ids(j.guests),
    exclude: ids(j.exclude),
    pool: str(j.pool),
    mode: (mode === 'suspend' || mode === 'stop' ? mode : 'snapshot') as HostBackupJob['mode'],
    compress: str(j.compress),
    keep: keep
      ? (Object.fromEntries(
          ['last', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']
            .map((k) => [k, int(keep[k])] as const)
            .filter(([, v]) => v !== null && v >= 0),
        ) as HostBackupJob['keep'])
      : null,
    notesTemplate: str(j.notes_template),
    comment: str(j.comment),
    nextRun: ts(j.next_run),
    digest: str(j.digest) ?? undefined,
  }) as HostBackupJob;
}

export function toHostManageResult(raw: unknown): HostManageResult {
  const r = obj(raw);
  const task = r.task ? obj(r.task) : null;
  return defined({
    ok: r.ok !== false,
    task: task && str(task.id) ? { id: text(task.id) } : undefined,
    // A created guest's hub id, or a created backup job's id (`backupjob.create` answers `id`, CT-353).
    newId: str(r.new_id) ?? str(r.id) ?? undefined,
    changes: Array.isArray(r.changes)
      ? r.changes.map((c) => {
          const x = obj(c);
          return defined({
            key: text(x.key),
            old: str(x.old) ?? undefined,
            new: str(x.new) ?? undefined,
            pending: optBool(x.pending),
          }) as HostConfigChange;
        })
      : undefined,
    auditId: str(r.audit_id) ?? undefined,
  }) as HostManageResult;
}

/** The hub's console session (its own path and token stay on Whombat's side). */
export function toConsoleSession(raw: unknown, ours: { path: string; token: string }): HostConsoleSession {
  const s = obj(raw);
  const protocol = text(s.protocol);
  return defined({
    sessionId: text(s.session_id),
    path: ours.path,
    token: ours.token,
    protocol: (PROTOCOLS.has(protocol) ? protocol : 'logs') as HostConsoleSession['protocol'],
    expiresAt: ts(s.expires_at) ?? new Date(Date.now() + 30_000).toISOString(),
    idleTimeoutS:
      int(s.idle_timeout_s) && (int(s.idle_timeout_s) as number) > 0
        ? (int(s.idle_timeout_s) as number)
        : 900,
    requiresConfirmation: optBool(s.requires_confirmation),
  }) as HostConsoleSession;
}
