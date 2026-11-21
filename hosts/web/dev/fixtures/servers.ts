// Fixture-mode implementation of the per-server endpoints:
//   GET /servers, /servers/{id}, /servers/{id}/metrics, /servers/{id}/guests

import type {
  Fleet,
  GuestList,
  Metrics,
  MetricSummary,
  ProxmoxDetail,
  Range,
  SeriesValues,
  ServerDetail,
  ServerListItem,
  StandardDetail,
} from '../../src/api/types.ts';
import type { FixtureSet } from './data.ts';
import { gen, type GenOptions, round1 } from './gen.ts';
import { hostHints } from './hints.ts';

export const RANGE_STEPS: Record<Range, { n: number; stepMin: number }> = {
  '1h': { n: 60, stepMin: 1 },
  '6h': { n: 72, stepMin: 5 },
  '24h': { n: 96, stepMin: 15 },
  '7d': { n: 84, stepMin: 120 },
  '30d': { n: 120, stepMin: 360 },
  '90d': { n: 120, stepMin: 1080 },
};

export function serverList(fleet: Fleet): ServerListItem[] {
  return fleet.servers.map((s) => ({
    id: s.id,
    group: s.group,
    status: s.status,
    status_note: s.status_note,
    os: s.os,
    detail_view: s.detail_view,
  }));
}

/** Generator parameters per server (taken from the mockup's design source). */
interface SeriesParams {
  prefix: string;
  cpu: GenOptions;
  mem: GenOptions;
  io: GenOptions;
  net: GenOptions;
  temps: Record<string, { short: string; amp: number; noise: number; spikes: number; spikeH: number }>;
}

const TEMP_DEFAULTS: SeriesParams['temps'] = {
  cpu_package: { short: 'CPU', amp: 4, noise: 2, spikes: 3, spikeH: 10 },
  board_vrm: { short: 'VRM', amp: 2.5, noise: 1, spikes: 1, spikeH: 3 },
  nvme_hottest: { short: 'NVMe', amp: 2.5, noise: 1, spikes: 2, spikeH: 5 },
  dimm: { short: 'DIMM', amp: 1.5, noise: 0.6, spikes: 0, spikeH: 0 },
  hdd_hottest: { short: 'HDD', amp: 1.5, noise: 0.5, spikes: 0, spikeH: 0 },
  ssd_hottest: { short: 'SSD', amp: 1.5, noise: 0.5, spikes: 0, spikeH: 0 },
};

const PARAMS: Record<string, SeriesParams> = {
  basalt: {
    prefix: 'b',
    cpu: { base: 34, amp: 7, noise: 4, spikes: 3, spikeH: 30, now: 34, min: 2, max: 99 },
    mem: { base: 61, amp: 1.5, noise: 0.8, saw: 5, now: 61, min: 5, max: 99 },
    io: { base: 180, amp: 30, noise: 35, spikes: 3, spikeH: 160, now: 182, min: 5, max: 3000 },
    net: { base: 620, amp: 120, noise: 90, spikes: 3, spikeH: 500, now: 640, min: 10, max: 9000 },
    temps: TEMP_DEFAULTS,
  },
  shale: {
    prefix: 'p',
    cpu: { base: 71, amp: 8, noise: 5, spikes: 3, spikeH: 20, now: 71, min: 5, max: 99 },
    mem: { base: 83, amp: 1.2, noise: 0.6, saw: 3, now: 83, min: 5, max: 99 },
    io: { base: 400, amp: 60, noise: 70, spikes: 3, spikeH: 300, now: 412, min: 5, max: 4000 },
    net: { base: 1800, amp: 300, noise: 220, spikes: 3, spikeH: 900, now: 1900, min: 10, max: 9000 },
    temps: { ...TEMP_DEFAULTS, cpu_package: { short: 'CPU', amp: 3, noise: 1.5, spikes: 3, spikeH: 8 } },
  },
};

function detailFor(fx: FixtureSet, id: string): ServerDetail | null {
  if (id === 'basalt') return fx.basalt;
  if (id === 'shale') return fx.shale;
  return null;
}

function paramsFor(fx: FixtureSet, id: string): SeriesParams | null {
  const known = PARAMS[id];
  if (known) return known;
  const s = fx.fleet.servers.find((x) => x.id === id);
  if (!s) return null;
  const v = s.current ?? s.last_known ?? {};
  const cpu = v.cpu_pct ?? 10;
  const mem = v.mem_pct ?? 40;
  return {
    prefix: id,
    cpu: { base: cpu, amp: Math.max(3, cpu * 0.2), noise: cpu * 0.12, spikes: 3, spikeH: cpu * 0.6, now: cpu, min: 1, max: 99 },
    mem: { base: mem, amp: 1.2, noise: 0.5, saw: 3, now: mem, min: 5, max: 99 },
    io: { base: 40, amp: 8, noise: 8, spikes: 2, spikeH: 40, now: 40, min: 1, max: 3000 },
    net: { base: 120, amp: 20, noise: 20, spikes: 2, spikeH: 80, now: 120, min: 1, max: 9000 },
    temps: TEMP_DEFAULTS,
  };
}

function summarize(timestamps: string[], vals: SeriesValues): MetricSummary | null {
  let n = 0;
  let total = 0;
  let max = -Infinity;
  let at = -1;
  vals.forEach((v, i) => {
    if (v == null) return;
    n++;
    total += v;
    if (v > max) {
      max = v;
      at = i;
    }
  });
  if (!n) return null;
  return { avg: round1(total / n), max: round1(max), max_at: timestamps[at] ?? null };
}

/** GET /servers/{id}/metrics?range= ; null when the server is unknown. */
export function metricsFor(fx: FixtureSet, id: string, range: Range, wanted: string[] | null): Metrics | null {
  const p = paramsFor(fx, id);
  if (!p) return null;
  const { n, stepMin } = RANGE_STEPS[range];
  const asOf = Date.parse(fx.fleet.as_of);
  const timestamps = Array.from({ length: n }, (_, i) => new Date(asOf - (n - 1 - i) * stepMin * 60000).toISOString().replace('.000Z', 'Z'));

  const series: Record<string, SeriesValues> = {};
  const g = (name: string, o: GenOptions) => gen(`${p.prefix}-${name}${range}`, n, stepMin, o).map(round1);

  if (id === 'basalt' && range === '24h') {
    Object.assign(series, fx.basalt24h.series);
  } else {
    series.cpu_pct = g('cpu', p.cpu);
    series.mem_pct = g('mem', p.mem);
    const detail = detailFor(fx, id);
    for (const s of detail?.sensors ?? []) {
      const t = p.temps[s.id] ?? TEMP_DEFAULTS.dimm!;
      const now = s.now_c ?? 40;
      series[`temp_${s.id}_c`] = gen(`${p.prefix}-t-${t.short}${range}`, n, stepMin, {
        base: now, amp: t.amp, noise: t.noise, spikes: t.spikes, spikeH: t.spikeH, now, min: 20, max: 100,
      }).map(round1);
    }
  }
  series.guest_disk_io_mbs = g('io', p.io);
  series.guest_net_mbps = g('net', p.net);

  // Offline server: no samples after last_seen (gaps are null, never zero).
  const fs = fx.fleet.servers.find((x) => x.id === id);
  if (fs && fs.status === 'offline' && fs.last_seen) {
    const last = Date.parse(fs.last_seen);
    for (const key of Object.keys(series)) {
      series[key] = (series[key] ?? []).map((v, i) => (Date.parse(timestamps[i] ?? '') > last ? null : v));
    }
  }

  const keys = wanted ? Object.keys(series).filter((k) => wanted.includes(k)) : Object.keys(series);
  const picked: Record<string, SeriesValues> = {};
  const summary: Record<string, MetricSummary | null> = {};
  for (const k of keys) {
    const v = series[k] ?? [];
    picked[k] = v;
    summary[k] = summarize(timestamps, v);
  }
  return { server: id, range, step_seconds: stepMin * 60, points: n, as_of: fx.fleet.as_of, timestamps, series: picked, summary };
}

/**
 * GET /servers/{id}?range= ; adds the optional CONTRACT fields the fixtures do
 * not carry (SMART counters, remote_control) so the mockup states render, and
 * honors `range` for sensors[].max_24h_c.
 */
export function detailResponse(fx: FixtureSet, id: string, range: Range): ServerDetail | null {
  const d = detailFor(fx, id);
  if (!d) return null;
  d.server.detail_view = isProxmox(d) ? 'proxmox' : 'standard';
  d.server.remote_control ??= { console: true, power: true, agent_console: true, agent_power: true, ...(id === 'basalt' || id === 'shale' ? { manage: true, agent_manage: true } : {}) };
  d.server.agent.connected ??= true;
  if (isProxmox(d)) {
    for (const disk of d.disks) disk.smart ??= { passed: true };
  } else {
    for (const disk of d.disks) {
      disk.smart ??= disk.type === 'hdd' ? { passed: true, reallocated: 0, pending: 0, uncorrectable: 0 } : { passed: true };
    }
  }
  if (range !== '24h') {
    const m = metricsFor(fx, id, range, null);
    for (const s of d.sensors) {
      const vals = (m?.series[`temp_${s.id}_c`] ?? []).filter((v): v is number => v != null);
      if (vals.length) s.max_24h_c = Math.round(Math.max(...vals));
    }
  }
  d.hints = hostHints(fx.fleet, id);
  return d;
}

function isProxmox(d: ServerDetail): d is ProxmoxDetail {
  return 'cluster' in d || d.server.roles.includes('proxmox-node');
}

/** GET /servers/{id}/guests?platform=&kind= */
export function guestsFor(fx: FixtureSet, id: string, platform: string | null, kind: string | null, q: string | null): GuestList | null {
  const d = detailFor(fx, id);
  if (!d) return null;
  let src: { guests: GuestList['guests']; total: number } | undefined;
  if (isProxmox(d)) {
    const k = kind === 'container' || kind === 'ct' ? 'container' : 'vm';
    src = d.guests[k];
  } else {
    const std: StandardDetail = d;
    if (platform === 'docker' || platform === 'incus' || platform === 'libvirt') src = std.workloads?.[platform];
  }
  if (!src) return { guests: [], total: 0, next_cursor: null };
  const needle = (q ?? '').trim().toLowerCase();
  const guests = needle ? src.guests.filter((g) => g.name.toLowerCase().includes(needle)) : src.guests;
  return { guests, total: needle ? guests.length : src.total, next_cursor: null };
}
