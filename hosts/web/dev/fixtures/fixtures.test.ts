import { describe, expect, it } from 'vitest';
import { loadFixtures } from './data';
import { computeFleet, computeFleetSeries } from './fleet';
import { gen } from './gen';
import { guestsFor, metricsFor } from './servers';

describe('fixture server: /fleet recomputation (G2)', () => {
  const fx = loadFixtures();

  it('group All reproduces fleet.json exactly', () => {
    const out = computeFleet(fx.fleet, 'All');
    expect(out.kpis).toEqual(fx.fleet.kpis);
    expect(out.platform_summary).toEqual(fx.fleet.platform_summary);
    expect(out.alerts).toEqual(fx.fleet.alerts);
    expect(out.top_guests_by_cpu.docker.map((g) => g.name)).toEqual(fx.fleet.top_guests_by_cpu.docker.map((g) => g.name));
    expect(out.agents_connected).toBe(7);
  });

  it('group Lab matches fleet-overview-lab-7d.png', () => {
    const out = computeFleet(fx.fleet, 'Lab');
    expect(out.servers.map((s) => s.id)).toEqual(['quartz', 'onyx']);
    expect(out.kpis).toMatchObject({
      servers_online: 2,
      servers_total: 2,
      cpu_avg_pct: 21,
      memory_pct: 47,
      memory_used_gb: 60,
      memory_total_gb: 128,
      storage_used_tb: 14.6,
      storage_total_tb: 20,
      disks_over_75_wear: 0,
      open_alerts: 0,
    });
    expect(out.platform_summary.docker).toEqual({ running: 16, stopped: 2, unhealthy: 1 });
    expect(out.platform_summary.qemu).toMatchObject({ running: 3, stopped: 1, proxmox_vms_running: 0, libvirt_vms_running: 3 });
    expect(out.top_guests_by_cpu.incus.map((g) => g.name)).toEqual(['test-vm']);
  });

  it('series: 60 sparkline points, 48 heatmap buckets, offline server ends in nulls', () => {
    const s = computeFleetSeries(fx.fleet, 'All', '24h');
    expect(s.kpi.cpu_pct).toHaveLength(60);
    expect(s.heatmap.cpu_pct.basalt).toHaveLength(48);
    expect(s.heatmap.bucket_s).toBe(1800);
    const marble = s.heatmap.cpu_pct.marble ?? [];
    expect(marble[0]).not.toBeNull();
    expect(marble[47]).toBeNull();
    expect(s.servers.marble?.cpu_pct[59]).toBeNull();
    expect(s.kpi.cpu_pct.every((v) => v !== null)).toBe(true);
  });
});

describe('fixture server: metrics', () => {
  const fx = loadFixtures();

  it('the generator port reproduces timeseries-basalt-24h.json', () => {
    const cpu = gen('b-cpu24h', 96, 15, { base: 34, amp: 7, noise: 4, spikes: 3, spikeH: 30, now: 34, min: 2, max: 99 });
    const fixture = fx.basalt24h.series.cpu_pct ?? [];
    cpu.forEach((v, i) => expect(v).toBeCloseTo(fixture[i] ?? NaN, 0));
  });

  it('steps and points per range (API.md 2.4) with a summary', () => {
    const expected = { '1h': [60, 60], '6h': [72, 300], '24h': [96, 900], '7d': [84, 7200], '30d': [120, 21600] } as const;
    for (const [range, [points, step]] of Object.entries(expected)) {
      const m = metricsFor(fx, 'shale', range as keyof typeof expected, null);
      expect(m?.points).toBe(points);
      expect(m?.step_seconds).toBe(step);
      expect(m?.timestamps).toHaveLength(points);
      expect(m?.timestamps.at(-1)).toBe('2026-10-11T14:00:00Z');
      expect(m?.summary?.cpu_pct?.max).toBeGreaterThan(0);
      expect(Object.keys(m?.series ?? {})).toContain('temp_ssd_hottest_c');
    }
  });

  it('basalt 24h comes from the fixture file', () => {
    const m = metricsFor(fx, 'basalt', '24h', ['cpu_pct']);
    expect(m?.series.cpu_pct).toEqual(fx.basalt24h.series.cpu_pct);
    expect(Object.keys(m?.series ?? {})).toEqual(['cpu_pct']);
  });

  it('guests lists per platform', () => {
    expect(guestsFor(fx, 'basalt', 'incus', null, null)?.guests).toHaveLength(7);
    expect(guestsFor(fx, 'basalt', 'docker', null, null)?.total).toBe(16);
    expect(guestsFor(fx, 'shale', 'pve', 'container', null)?.guests).toHaveLength(4);
    expect(guestsFor(fx, 'granite', 'docker', null, null)).toBeNull();
  });
});
