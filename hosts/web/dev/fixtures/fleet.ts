// Fixture-mode implementation of GET /fleet and GET /fleet/series.
// Recomputes every number for the selected group (G2) from the fixture's
// servers, exactly as the hub is meant to (SCREENS.md 2.2, PRODUCT-SPEC F2..F7).

import type { Fleet, FleetSeries, FleetServer, Range, SeriesValues, TopGuest } from '../../src/api/types.ts';
import { gen, round1 } from './gen.ts';
import { fleetHints } from './hints.ts';

export const RANGE_MINUTES: Record<Range, number> = { '1h': 60, '6h': 360, '24h': 1440, '7d': 10080, '30d': 43200, '90d': 129600 };

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

export function serversInGroup(fleet: Fleet, group: string): FleetServer[] {
  return fleet.servers.filter((s) => group === 'All' || s.group === group);
}

const isOnline = (s: FleetServer): boolean => s.status !== 'offline' && s.current !== null;

export function computeFleet(base: Fleet, group: string): Fleet {
  const servers = serversInGroup(base, group);
  const online = servers.filter(isOnline);
  const ids = new Set(servers.map((s) => s.id));
  const onlineIds = new Set(online.map((s) => s.id));
  const alerts = base.alerts.filter((a) => ids.has(a.server));

  const cur = (s: FleetServer) => s.current ?? { cpu_pct: 0, mem_pct: 0, temp_max_c: null, disk_used_pct: 0, disk_wear_max_pct: null };
  const memTotal = sum(online.map((s) => s.memory_total_gb ?? 0));
  const memUsed = sum(online.map((s) => ((s.memory_total_gb ?? 0) * (cur(s).mem_pct ?? 0)) / 100));
  const capTotal = sum(online.map((s) => s.storage_capacity_tb ?? 0));
  const capUsed = sum(online.map((s) => ((s.storage_capacity_tb ?? 0) * (cur(s).disk_used_pct ?? 0)) / 100));
  const critical = alerts.filter((a) => a.severity === 'critical').length;

  const top = (list: TopGuest[]): TopGuest[] =>
    list.filter((t) => onlineIds.has(t.server)).sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 5);

  const w = online.map((s) => s.workloads);
  const isPve = (s: FleetServer) => s.detail_view === 'proxmox' || (s.hypervisor?.stacks.includes('proxmox') ?? false);
  const qemuRunning = sum(w.map((x) => x.qemu.running));
  const pveRunning = sum(online.filter(isPve).map((s) => s.workloads.qemu.running));

  return {
    ...base,
    servers,
    alerts,
    kpis: {
      servers_online: online.length,
      servers_total: servers.length,
      cpu_avg_pct: online.length ? Math.round(mean(online.map((s) => cur(s).cpu_pct ?? 0))) : null,
      memory_pct: memTotal ? Math.round((memUsed / memTotal) * 100) : null,
      memory_used_gb: Math.round(memUsed),
      memory_total_gb: memTotal,
      storage_used_tb: round1(capUsed),
      storage_total_tb: capTotal,
      storage_pct: capTotal ? Math.round((capUsed / capTotal) * 100) : null,
      disks_over_75_wear: online.filter((s) => (cur(s).disk_wear_max_pct ?? 0) >= 75).length,
      open_alerts: alerts.length,
      open_alerts_critical: critical,
      open_alerts_warning: alerts.length - critical,
    },
    top_guests_by_cpu: {
      docker: top(base.top_guests_by_cpu.docker),
      incus: top(base.top_guests_by_cpu.incus),
      qemu: top(base.top_guests_by_cpu.qemu),
    },
    platform_summary: {
      docker: {
        running: sum(w.map((x) => x.docker.running)),
        stopped: sum(w.map((x) => x.docker.stopped)),
        unhealthy: sum(w.map((x) => x.docker.unhealthy)),
      },
      incus: {
        containers_running: sum(w.map((x) => x.incus.containers_running)),
        vms_running: sum(w.map((x) => x.incus.vms_running)),
        stopped: sum(w.map((x) => x.incus.stopped)),
      },
      qemu: {
        running: qemuRunning,
        stopped: sum(w.map((x) => x.qemu.stopped)),
        proxmox_vms_running: pveRunning,
        libvirt_vms_running: qemuRunning - pveRunning,
      },
    },
    agents_connected: online.length,
    pending_enrollments: 0,
    hints: fleetHints(base, servers),
  };
}

const SPARK_POINTS = 60;
const HEAT_BUCKETS = 48;

/** Minutes since the server's last sample (offline servers), else 0. */
function silentMinutes(s: FleetServer, asOf: string): number {
  if (isOnline(s)) return 0;
  return s.last_seen ? Math.max(0, (Date.parse(asOf) - Date.parse(s.last_seen)) / 60000) : 0;
}

export function computeFleetSeries(base: Fleet, group: string, range: Range): FleetSeries {
  const servers = serversInGroup(base, group);
  const mins = RANGE_MINUTES[range];
  const out: FleetSeries = {
    range,
    as_of: base.as_of,
    kpi: { step_s: (mins * 60) / SPARK_POINTS, cpu_pct: [], mem_pct: [] },
    servers: {},
    heatmap: { buckets: HEAT_BUCKETS, bucket_s: (mins * 60) / HEAT_BUCKETS, cpu_pct: {} },
  };
  const blank = (vals: number[], n: number, off: number): SeriesValues =>
    vals.map((v, i) => ((n - 1 - i) * mins) / (n - 1) < off ? null : round1(v));

  for (const s of servers) {
    const vals = s.current ?? s.last_known ?? {};
    const cpu = vals.cpu_pct ?? 0;
    const mem = vals.mem_pct ?? 0;
    const k = s.id + range;
    const N = SPARK_POINTS;
    const H = HEAT_BUCKETS;
    const c = gen(k + 'c', N, mins / (N - 1), { base: cpu, amp: Math.max(3, cpu * 0.2), noise: cpu * 0.12, spikes: 2, spikeH: cpu * 0.6, now: cpu, min: 1, max: 99 });
    const m = gen(k + 'm', N, mins / (N - 1), { base: mem, amp: 1.2, noise: 0.5, saw: 3, now: mem, min: 5, max: 99 });
    const h = gen(k + 'h', H, mins / (H - 1), { base: cpu, amp: Math.max(3, cpu * 0.2), noise: cpu * 0.2, spikes: 3, spikeH: cpu * 0.7, now: cpu, min: 1, max: 99 });
    const off = silentMinutes(s, base.as_of);
    out.servers[s.id] = { step_s: out.kpi.step_s, cpu_pct: blank(c, N, off), mem_pct: blank(m, N, off) };
    out.heatmap.cpu_pct[s.id] = blank(h, H, off);
  }

  // KPI sparkline: mean over servers that have data in each bucket.
  const ids = servers.filter(isOnline).map((s) => s.id);
  for (const key of ['cpu_pct', 'mem_pct'] as const) {
    const avg: SeriesValues = [];
    for (let i = 0; i < SPARK_POINTS; i++) {
      const pts = ids.map((id) => out.servers[id]?.[key][i]).filter((v): v is number => typeof v === 'number');
      avg.push(pts.length ? round1(mean(pts)) : null);
    }
    out.kpi[key] = avg;
  }
  return out;
}
