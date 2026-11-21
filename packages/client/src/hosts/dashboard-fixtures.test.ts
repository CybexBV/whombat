import { HostGuestPage, HostSeries, HostServerDetail } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_FIXTURE_IDS,
  dashboardFixtureAnswer,
  dashboardFixtures,
  withDashboardFixtures,
} from './fixtures';

const NOW = Date.parse('2026-10-18T16:00:00Z');
const fx = dashboardFixtures(NOW);
const get = (path: string, query: Record<string, string> = {}) => ({ method: 'GET', path, query, body: {} });

describe('the dashboard fixtures (AP-2020)', () => {
  it('are pages and histories the contracts accept, on the hosts service’s grid', () => {
    for (const id of DASHBOARD_FIXTURE_IDS) {
      const f = fx[id];
      expect(HostServerDetail.safeParse(f.detail).success, id).toBe(true);
      for (const [range, points, step] of [
        ['1h', 60, 60],
        ['24h', 96, 900],
        ['7d', 84, 7200],
        ['90d', 120, 64800],
      ] as const) {
        const s = f.series(range);
        expect(HostSeries.safeParse(s).success, `${id} ${range}`).toBe(true);
        expect([s.timestamps.length, s.stepSeconds, s.timestamps.at(-1)]).toEqual([
          points,
          step,
          new Date(NOW).toISOString(),
        ]);
        expect(s.series.cpu_pct?.every((v) => v != null && v >= 0 && v <= 100)).toBe(true);
      }
    }
  });

  it('draw the nightly backup as the day’s peak, the same at every range', () => {
    const s = fx['pve-02'].series('24h', ['cpu_pct']);
    const at = s.summary?.cpu_pct?.maxAt ?? '';
    // 01:10 UTC is 03:10 in Amsterdam; the 15-minute bucket ending 01:30 holds the backup's height.
    expect(new Date(at).getUTCHours()).toBe(1);
    expect(s.summary?.cpu_pct?.max).toBeGreaterThan(40);
    expect(fx['pve-02'].series('24h', ['cpu_pct'])).toEqual(s);
    const week = fx['pve-02'].series('7d', ['cpu_pct']);
    expect(week.summary?.cpu_pct?.avg).toBeGreaterThan(5);
  });

  it('answer the hosts routes for their servers and leave the rest to the main world', () => {
    const page = dashboardFixtureAnswer(fx, get('/servers/blackbox'));
    expect(page?.status).toBe(200);
    expect(HostServerDetail.parse(page?.body).unraid?.name).toBe('BlackBox');
    const metrics = dashboardFixtureAnswer(
      fx,
      get('/servers/pve-02/metrics', { range: '7d', series: 'cpu_pct,nope' }),
    );
    const series = HostSeries.parse(metrics?.body);
    expect(Object.keys(series.series)).toEqual(['cpu_pct', 'nope']);
    expect(series.series.nope?.every((v) => v === null)).toBe(true);
    const guest = dashboardFixtureAnswer(
      fx,
      get('/servers/pve-02/guests/pve%3A131/metrics', { range: '24h' }),
    );
    const one = HostSeries.parse(guest?.body);
    expect(one.guestId).toBe('pve:131');
    expect(one.series.cpu_pct?.length).toBe(96);
    const guests = dashboardFixtureAnswer(fx, get('/guests', { server: 'raspi' }));
    expect(HostGuestPage.parse(guests?.body).counts).toEqual({
      all: 5,
      running: 4,
      stopped: 1,
      unhealthy: 0,
    });
    expect(dashboardFixtureAnswer(fx, get('/servers/pve-01'))).toBeNull();
    expect(dashboardFixtureAnswer(fx, { ...get('/servers/pve-02'), method: 'PATCH' })).toBeNull();

    const handle = withDashboardFixtures(() => ({ status: 404, body: 'main world' }), NOW);
    expect(handle(get('/servers/kvm-lab'))?.status).toBe(200);
    expect(handle(get('/servers/pve-01'))?.body).toBe('main world');
  });
});
