/**
 * A server's own screen on the desk (docs/decisions/desk-display.md DK-83, DK-84; desk-display-server.md DK-S83…DK-S88):
 * what the hosts service knows of one server, made into `DeskServerPage`. `readServerParts` asks the service what
 * Whombat's server page asks it (the detail and the metrics with the range, the guests, the open alerts) through the
 * same mappers (`hosts/map.ts`); `deskServerPage` is pure: the card, the OS and uptime, four figures, the chart's two
 * series, storage per volume, the guests, the network now and the alerts, every string cut to the contract's length.
 */
import {
  DESK_SERVER_ALERTS,
  DESK_SERVER_GUESTS,
  DESK_SERVER_MAX_BYTES,
  DESK_SERVER_POINTS,
  DESK_SERVER_VOLUMES,
  DeskServerPage,
  deskServerPageValid,
} from '@whombat/control-contracts/local';
import {
  DESK_BOX_TONES,
  type DeskGuestState,
  type DeskServerRange,
  deskBoxSize,
  deskMemoryFigure,
  deskMemoryTotal,
  formatDeskRate,
  type HostAlert,
  type HostGuest,
  type HostSeries,
  type HostServer,
  type HostServerDetail,
} from '@whombat/core';
import { HOSTS_API, seg } from '../hosts/client';
import { arr, obj, toHostAlert, toHostGuest, toHostSeries, toHostServerDetail } from '../hosts/map';
import { type HostsService, WHOMBAT_ACTOR } from '../hosts/service';
import { DESK_HOSTS_WAIT_MS, meter, screenText, tempTone, uptimeNote, within } from './glance';
import type { DeskServer } from './shapes';

/* Reading ----------------------------------------------------------------------------------------------------------- */

/** The series the chart and the network line need (the hosts service's names, Mb/s for the network). */
export const SERVER_PAGE_SERIES = 'cpu_pct,mem_pct,net_rx_mbps,net_tx_mbps';

/** What a server's screen is made of, in the contracts' shapes. */
export interface ServerParts {
  detail: HostServerDetail;
  /** Null when the metrics didn't come: the chart is empty, the network unknown. */
  series: HostSeries | null;
  /** Null when the guests didn't come: the screen shows none. */
  guests: HostGuest[] | null;
  /** The fleet's open alerts (every server's). */
  alerts: HostAlert[];
}

/**
 * Reads one server for its screen, as Whombat (a viewer), in parallel (DK-S83): the detail with the range (its sensors'
 * highs follow it), the metrics with the range, the server's guests (cached 30 s by the service) and the fleet's open
 * alerts (cached 5 s). The detail is the screen: when it fails, this throws (`HostsError` 404 for a server the service
 * doesn't know); the rest is left out when it fails or takes longer than `ms`.
 */
export async function readServerParts(
  hosts: Pick<HostsService, 'call' | 'guestsRaw' | 'openAlertsRaw'>,
  id: string,
  range: DeskServerRange,
  now: Date,
  ms = DESK_HOSTS_WAIT_MS,
): Promise<ServerParts> {
  const path = `${HOSTS_API}/servers/${seg(id)}`;
  const [detail, series, guests, alerts] = await Promise.all([
    within(hosts.call<unknown>({ path, query: { range }, actor: WHOMBAT_ACTOR, timeoutMs: ms }), ms),
    within(
      hosts.call<unknown>({
        path: `${path}/metrics`,
        query: { range, series: SERVER_PAGE_SERIES },
        actor: WHOMBAT_ACTOR,
        timeoutMs: ms,
      }),
      ms,
    ).catch(() => null),
    within(hosts.guestsRaw(id), ms).catch(() => null),
    within(hosts.openAlertsRaw(), ms).catch(() => [] as unknown[]),
  ]);
  return {
    detail: toHostServerDetail(detail, alerts, null, now),
    series: series === null ? null : toHostSeries(series, id, null, now),
    guests: guests === null ? null : guests.map((g) => toHostGuest(g, id)),
    alerts: arr(alerts).map((a) => toHostAlert(obj(a))),
  };
}

/* Building ---------------------------------------------------------------------------------------------------------- */

/** One point per this many seconds when the service didn't say (its steps per range, REST-API metrics). */
const RANGE_STEP_S: Record<DeskServerRange, number> = { '1h': 60, '24h': 900, '7d': 7_200 };

/** Bytes in a GiB: the service's memory figures are GiB (`/ rules.GiB`), its storage ones decimal GB and TB. */
const GIB = 1_073_741_824;
const GB = 1_000_000_000;
const TB = 1_000_000_000_000;
/** The service's network series are megabits per second; the screen writes bytes per second (`formatDeskRate`). */
const MBIT_BYTES = 125_000;

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const pct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));
const size = (bytes: number) => screenText(deskBoxSize(bytes), 16);

/**
 * At most `max` points, each the mean of a bucket of `per` points (null when nothing was measured in it), the buckets
 * counted back from the last point so the last one ends now; `ends[i]` is the index of the last point of bucket `i`.
 */
export function downsample(
  points: readonly (number | null)[],
  max = DESK_SERVER_POINTS,
): { points: (number | null)[]; per: number; ends: number[] } {
  const per = Math.max(1, Math.ceil(points.length / max));
  const count = Math.ceil(points.length / per);
  const out: (number | null)[] = [];
  const ends: number[] = [];
  for (let b = 0; b < count; b++) {
    const end = points.length - (count - 1 - b) * per;
    const seen = points.slice(Math.max(0, end - per), end).filter(finite);
    out.push(seen.length ? seen.reduce((a, p) => a + p, 0) / seen.length : null);
    ends.push(end - 1);
  }
  return { points: out, per, ends };
}

/**
 * The chart (DK-83, DK-S86): CPU and memory over the range, at most `DESK_SERVER_POINTS` points (the service's own
 * ranges have at most 96, so they come as they are), whole percents, gaps null; `stepS` the step of a point; CPU's
 * highest point with when it ended (the first of equal ones), memory's mean; both null without points.
 */
export function serverHistory(
  series: HostSeries | null,
  range: DeskServerRange,
  now: Date,
): DeskServerPage['history'] {
  const cpuRaw = series?.series.cpu_pct ?? [];
  const memRaw = series?.series.mem_pct ?? [];
  const n = Math.max(cpuRaw.length, memRaw.length);
  const cpu = downsample(Array.from({ length: n }, (_, i) => cpuRaw[i] ?? null));
  const memory = downsample(Array.from({ length: n }, (_, i) => memRaw[i] ?? null));
  const step = series?.stepSeconds ?? RANGE_STEP_S[range];
  const end = Date.parse(series?.asOf ?? '') || now.getTime();
  const stamps = series?.timestamps.length === n ? series.timestamps : null;
  const timeOf = (i: number) => stamps?.[i] ?? new Date(end - (n - 1 - i) * step * 1000).toISOString();
  const cpuPoints = cpu.points.map((p) => (p === null ? null : pct(p)));
  const memPoints = memory.points.map((p) => (p === null ? null : pct(p)));
  let top = -1;
  for (let i = 0; i < cpuPoints.length; i++) {
    const p = cpuPoints[i] ?? null;
    if (p !== null && (top < 0 || p > (cpuPoints[top] ?? 0))) top = i;
  }
  const peak = top < 0 ? null : { percent: cpuPoints[top] ?? 0, at: timeOf(cpu.ends[top] ?? 0) };
  const measured = memPoints.filter((p): p is number => p !== null);
  return {
    range,
    stepS: Math.min(86_400, Math.max(1, Math.round(step * cpu.per))),
    cpu: cpuPoints,
    memory: memPoints,
    cpuPeak: peak,
    memoryAvg: measured.length ? pct(measured.reduce((a, p) => a + p, 0) / measured.length) : null,
  };
}

/** “Proxmox VE 9.0.10”: the detail's name and version, else the fleet's line; empty when not known. */
export function serverOs(detail: HostServerDetail, row: Pick<HostServer, 'os'>): string {
  const os = detail.server.os;
  const name = os?.name.trim() ?? '';
  const version = os?.version.trim() ?? '';
  const line = name && version && !name.includes(version) ? `${name} ${version}` : name || row.os || '';
  return screenText(line, 60);
}

/** CPU now (DK-S87): the detail's live figure, else the fleet's; its cores and the 1-minute load with one decimal. */
export function cpuFigure(row: HostServer, detail: HostServerDetail): DeskServerPage['cpu'] {
  const now = detail.live?.cpuPct ?? row.cpuPct;
  if (!finite(now)) return null;
  const m = meter(pct(now), DESK_BOX_TONES.cpu);
  const cores = detail.server.cpu?.cores || row.cpu?.cores || 0;
  const load = detail.live?.loadAvg?.[0];
  return {
    percent: m.value,
    cores: Number.isInteger(cores) && cores >= 1 && cores <= 4096 ? cores : null,
    load: finite(load) && load >= 0 ? screenText(load.toFixed(1), 8) : '',
    tone: m.tone,
  };
}

/** Memory now (DK-S87): as computers count it (the service's GB are GiB), used big, “of” the size it was sold as. */
export function memoryFigure(row: HostServer, detail: HostServerDetail): DeskServerPage['memory'] {
  const now = detail.live?.memPct ?? row.memory.usedPct;
  const totalGb = detail.server.memory?.totalGb || row.memory.totalGb || 0;
  if (!finite(now) || !(totalGb > 0)) return null;
  const m = meter(pct(now), DESK_BOX_TONES.memory);
  const usedGb = detail.live?.memUsedGb ?? (totalGb * now) / 100;
  const used = deskMemoryFigure(Math.max(0, usedGb) * GIB);
  return {
    percent: m.value,
    used: { value: screenText(used.value, 8) || '0', unit: screenText(used.unit, 8) || 'GB' },
    total: screenText(deskMemoryTotal(totalGb * GIB), 16),
    tone: m.tone,
  };
}

/**
 * The disk (DK-80, DK-S87): the card's figure, the fleet's storage (decimal TB, as “How it’s doing” writes sizes); the
 * used part without its unit when the total has the same (mockup 2's “1.2 of 3.6 TB”).
 */
export function diskFigure(row: HostServer): DeskServerPage['disk'] {
  const now = row.storage.usedPct;
  const capacityTb = row.storage.capacityTb;
  if (!finite(now) || !finite(capacityTb) || capacityTb <= 0) return null;
  const m = meter(pct(now), DESK_BOX_TONES.storage);
  const used = size((capacityTb * TB * m.value) / 100);
  const total = size(capacityTb * TB);
  const [figure, unit] = used.split(' ');
  return {
    percent: m.value,
    used: figure && unit && unit === total.split(' ')[1] ? figure : used,
    total,
    tone: m.tone,
  };
}

/**
 * The temperature (DK-S87): the card's (the fleet's hottest sensor and its limit), so the screen's figure is the one
 * that made the card say “hot”; else the detail's sensor reading highest now, against its limit (85° without one).
 */
export function tempFigure(row: HostServer, detail: HostServerDetail): DeskServerPage['temp'] {
  const fleet = row.temperature;
  if (fleet && finite(fleet.maxC)) {
    const value = Math.round(fleet.maxC);
    const limit = finite(fleet.limitC) ? fleet.limitC : null;
    return { value, limit: Math.round(limit ?? 85), tone: tempTone(value, limit) };
  }
  const hottest = detail.sensors
    .filter((s): s is typeof s & { nowC: number } => finite(s.nowC))
    .sort((a, b) => b.nowC - a.nowC)[0];
  if (!hottest) return null;
  const value = Math.round(hottest.nowC);
  const limit = finite(hottest.limitC) ? hottest.limitC : null;
  return { value, limit: Math.round(limit ?? 85), tone: tempTone(value, limit) };
}

/** A Proxmox storage's kind in a word or two (“zfs”, “nfs share”); its type as Proxmox says it otherwise. */
const STORAGE_NOTES: Readonly<Record<string, string>> = {
  zfspool: 'zfs',
  zfs: 'zfs',
  dir: 'folder',
  lvm: 'lvm',
  lvmthin: 'lvm thin',
  nfs: 'nfs share',
  cifs: 'smb share',
  pbs: 'backup server',
  rbd: 'ceph',
  cephfs: 'ceph',
  btrfs: 'btrfs',
  iscsi: 'iscsi',
  iscsidirect: 'iscsi',
  glusterfs: 'gluster',
};

type Volume = DeskServerPage['volumes'][number];

function volume(name: string, note: string, usedBytes: number, totalBytes: number): Volume | null {
  const shown = screenText(name, 40);
  if (!shown || !(totalBytes > 0) || !(usedBytes >= 0)) return null;
  const m = meter(pct((usedBytes / totalBytes) * 100), DESK_BOX_TONES.storage);
  return {
    name: shown,
    note: screenText(note, 40),
    percent: m.value,
    used: size(usedBytes),
    total: size(totalBytes),
    tone: m.tone,
  };
}

/**
 * Storage per volume (DK-83, DK-S84), fullest first, at most `DESK_SERVER_VOLUMES`, from the first source that has any:
 * a Proxmox node's storages; unRAID's array and pools; the agent's volumes (every filesystem and pool, since
 * 2026-10-13); else the disks that say what they hold (older agents).
 */
export function serverVolumes(detail: HostServerDetail): DeskServerPage['volumes'] {
  const sources: (() => (Volume | null)[])[] = [
    () =>
      (detail.proxmox?.storages ?? []).map((s) =>
        volume(s.id, STORAGE_NOTES[s.type] ?? s.type, s.usedGb * GB, s.capacityGb * GB),
      ),
    () => {
      const u = detail.unraid;
      if (!u) return [];
      const disks = u.array.disks.filter((d) => d.slot === 'data').length;
      return [
        volume(
          'array',
          disks ? `${disks} disk${disks === 1 ? '' : 's'}` : '',
          u.array.usedBytes,
          u.array.sizeBytes,
        ),
        ...u.pools.map((p) =>
          volume(p.name, [p.fsType, p.profile].filter(Boolean).join(' '), p.usedBytes, p.sizeBytes),
        ),
      ];
    },
    () =>
      (detail.health?.volumes ?? [])
        .filter((v) => !v.error)
        .map((v) =>
          volume(
            v.label || v.entity,
            v.kind === 'pool' ? (v.layout ?? 'pool') : v.remote ? 'network share' : (v.fsType ?? ''),
            v.usedGb * GB,
            v.totalGb * GB,
          ),
        ),
    () =>
      detail.disks.map((d) =>
        finite(d.usedGb) && finite(d.capacityGb)
          ? volume(d.device, d.model, d.usedGb * GB, d.capacityGb * GB)
          : null,
      ),
  ];
  for (const source of sources) {
    const found = source().filter((v): v is Volume => v !== null);
    if (found.length)
      return found
        .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name))
        .slice(0, DESK_SERVER_VOLUMES);
  }
  return [];
}

const RUNNING: ReadonlySet<DeskGuestState> = new Set(['running', 'unhealthy']);
const GUEST_ORDER: Record<DeskGuestState, number> = { running: 0, unhealthy: 0, paused: 1, stopped: 2 };
const MIB = 1_048_576;

/**
 * The guests (DK-83, DK-S85): how many run (an unhealthy container runs) and how many are off (stopped or paused); up to
 * `DESK_SERVER_GUESTS`, the running ones first, the busiest first, with their CPU and memory now (none while off). Null
 * when the server has no guests, or they didn't come.
 */
export function serverGuests(guests: readonly HostGuest[] | null): DeskServerPage['guests'] {
  if (!guests?.length) return null;
  const running = guests.filter((g) => RUNNING.has(g.state)).length;
  const items = [...guests]
    .sort(
      (a, b) =>
        GUEST_ORDER[a.state] - GUEST_ORDER[b.state] ||
        (b.cpuPct ?? -1) - (a.cpuPct ?? -1) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, DESK_SERVER_GUESTS)
    .map((g) => {
      const on = RUNNING.has(g.state);
      const mem = on && finite(g.memoryUsedMb) ? deskMemoryFigure(g.memoryUsedMb * MIB) : null;
      return {
        name: screenText(g.name, 60) || screenText(g.id, 60) || 'guest',
        kind: g.kind,
        state: g.state,
        cpu: on && finite(g.cpuPct) ? pct(g.cpuPct) : null,
        memory: mem ? screenText(`${mem.value} ${mem.unit}`, 16) : '',
      };
    });
  return { running, off: guests.length - running, items };
}

/** The network now (DK-S87): the latest point of the host's interfaces, as This Whombat's panel writes it. */
export function serverNetwork(series: HostSeries | null): DeskServerPage['network'] {
  const rx = series?.series.net_rx_mbps ?? [];
  const tx = series?.series.net_tx_mbps ?? [];
  for (let i = Math.max(rx.length, tx.length) - 1; i >= 0; i--) {
    const down = rx[i];
    const up = tx[i];
    if (!finite(down) && !finite(up)) continue;
    return {
      down: screenText(formatDeskRate((finite(down) ? down : 0) * MBIT_BYTES), 16),
      up: screenText(formatDeskRate((finite(up) ? up : 0) * MBIT_BYTES), 16),
    };
  }
  return null;
}

/**
 * The server's open alerts that ask for a look (DK-84, DK-S88): those that make its card amber or red (not acknowledged,
 * muted or covered by another), counted always; their titles, the worst and then the newest first, only where words may
 * show (`titles`: unlocked, or *Everything* while locked).
 */
export function serverAlerts(
  alerts: readonly HostAlert[],
  id: string,
  titles: boolean,
): DeskServerPage['alerts'] {
  const open = alerts
    .filter((a) => a.serverId === id && a.state === 'open' && a.attention !== false)
    .sort(
      (a, b) =>
        (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) ||
        Date.parse(b.openedAt) - Date.parse(a.openedAt),
    );
  const items = titles
    ? open
        .map((a) => ({
          tone: a.severity === 'critical' ? ('bad' as const) : ('warn' as const),
          title: screenText(a.title, 120),
        }))
        .filter((a) => a.title)
        .slice(0, DESK_SERVER_ALERTS)
    : [];
  return { count: open.length, items };
}

/** What the builder takes: the fleet's row and its card (with the id asked for), what was read, and the lock. */
export interface ServerPageInput extends ServerParts {
  row: HostServer;
  card: DeskServer;
  range: DeskServerRange;
  now: Date;
  /** Whether the alerts' titles may show (DK-84): unlocked, or *Everything* while locked. */
  titles: boolean;
}

/**
 * A server's screen (mockup 2; DK-83, DK-S83). An off server has its card, its OS, no uptime, no figures, no volumes,
 * guests or network (they would be old), the history it has and its alerts.
 */
export function deskServerPage(input: ServerPageInput): DeskServerPage {
  const { row, card, detail, now } = input;
  const off = card.state === 'off';
  const uptime = detail.server.uptimeS;
  return {
    v: 1,
    now: now.toISOString(),
    server: card,
    os: serverOs(detail, row),
    up: !off && finite(uptime) && uptime > 0 ? screenText(uptimeNote(uptime), 40) : '',
    cpu: off ? null : cpuFigure(row, detail),
    memory: off ? null : memoryFigure(row, detail),
    disk: off ? null : diskFigure(row),
    temp: off ? null : tempFigure(row, detail),
    history: serverHistory(input.series, input.range, now),
    volumes: off ? [] : serverVolumes(detail),
    guests: off ? null : serverGuests(input.guests),
    network: off ? null : serverNetwork(input.series),
    alerts: serverAlerts(input.alerts, row.id, input.titles),
  };
}

/**
 * Whether the console takes the page (outside production the socket checks it, as the state): `deskServerPageValid`,
 * the id asked for, and at most `DESK_SERVER_MAX_BYTES` (the console reads no more).
 */
export function serverPageValid(page: DeskServerPage, id: string): boolean {
  const parsed = DeskServerPage.safeParse(page);
  return (
    parsed.success &&
    deskServerPageValid(parsed.data) &&
    page.server.id === id &&
    Buffer.byteLength(JSON.stringify(page)) <= DESK_SERVER_MAX_BYTES
  );
}
