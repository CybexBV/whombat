import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeskServerPage, deskServerPageValid } from '@whombat/control-contracts/local';
import type { HostAlert, HostGuest, HostServer } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  guestsOfDetail,
  toHostAlert,
  toHostFleet,
  toHostGuest,
  toHostSeries,
  toHostServerDetail,
} from '../hosts/map';
import { deskFleetOf } from './glance';
import {
  deskServerPage,
  downsample,
  readServerParts,
  type ServerPageInput,
  serverAlerts,
  serverGuests,
  serverHistory,
  serverNetwork,
  serverPageValid,
  serverVolumes,
} from './server-page';

/* The hosts service's own answers (the hand-off sample data the fake serves), through Whombat's mappers. */
const FIXTURES = join(import.meta.dirname, '../hosts/testing/fixtures');
const raw = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
const now = new Date('2026-10-11T14:00:00Z');
const fleetRaw = raw('fleet.json');
const fleet = toHostFleet({ fleet: fleetRaw }, now);
const cards = deskFleetOf(fleet.servers);
const rowOf = (id: string) => fleet.servers.find((s) => s.id === id) as HostServer;
const alerts = fleet.alerts;

function input(id: string, detailRaw: unknown, over: Partial<ServerPageInput> = {}): ServerPageInput {
  const detail = toHostServerDetail(detailRaw, alerts, null, now);
  return {
    row: rowOf(id),
    card: cards.cards.find((c) => c.id === id) as ServerPageInput['card'],
    detail,
    series: toHostSeries({ ...raw('timeseries-basalt-24h.json'), server: id }, id, null, now),
    guests: guestsOfDetail(detail),
    alerts,
    range: '24h',
    now,
    titles: true,
    ...over,
  };
}

/** The page as the console would take it (`DeskServerPage`, `deskServerPageValid`). */
function valid(page: DeskServerPage): DeskServerPage {
  expect(deskServerPageValid(DeskServerPage.parse(page))).toBe(true);
  expect(serverPageValid(page, page.server.id ?? '')).toBe(true);
  return page;
}

/** A plain Linux server's detail, as the hosts service answers one with no guests (`volumes` since 2026-10-13). */
const linux = (health: Record<string, unknown>, disks: unknown[] = []) => ({
  as_of: '2026-10-11T14:00:00Z',
  server: {
    id: 'granite',
    status: 'online',
    os: { name: 'Debian GNU/Linux', version: '13', kernel: '6.12' },
    cpu: { model: 'Ryzen 7 7700', cores: 8, threads: 16 },
    memory: { total_gb: 62.6 },
    uptime_s: 5 * 3600,
  },
  live: { cpu_pct: 22, load_avg: [0.42, 0.3, 0.2], mem_pct: 48, mem_used_gb: 30.1 },
  sensors: [],
  disks,
  ...health,
  workloads: {},
});

describe('a server’s screen (DK-83, mockup 2)', () => {
  it('shows a Proxmox node: its figures, storages fullest first and its guests, busiest first', () => {
    const page = valid(deskServerPage(input('shale', raw('server-shale-proxmox.json'))));
    expect(page.server).toMatchObject({ id: 'shale', name: 'shale', mark: 'proxmox', state: 'warn' });
    expect(page.os).toBe('Proxmox VE 9');
    expect(page.up).toBe('up 88 d');
    expect(page.cpu).toEqual({ percent: 71, cores: 16, load: '19.8', tone: 'ok' });
    // Memory as computers count it, of the size it was sold as; storage in decimal sizes.
    expect(page.memory).toEqual({
      percent: 83,
      used: { value: '159', unit: 'GB' },
      total: '192 GB',
      tone: 'warn',
    });
    expect(page.disk).toEqual({ percent: 52, used: '12.5', total: '24 TB', tone: 'ok' });
    // The card's temperature, so the figure is the one that coloured it.
    expect(page.temp).toEqual({ value: 83, limit: 85, tone: 'warn' });
    expect(page.volumes.map((v) => [v.name, v.note, v.percent])).toEqual([
      ['vmdata', 'zfs', 83],
      ['pbs-01', 'backup server', 70],
      ['local', 'folder', 44],
      ['bulk', 'zfs', 40],
      ['local-zfs', 'zfs', 8],
    ]);
    // Coloured as This Whombat's storage: amber from 85 %.
    expect(page.volumes[0]).toMatchObject({ used: '3.2 TB', total: '3.8 TB', tone: 'ok' });
    expect(page.guests?.running).toBe(11);
    expect(page.guests?.off).toBe(1);
    expect(page.guests?.items.map((g) => [g.name, g.cpu, g.memory])).toEqual([
      ['k3s-node-2', 44, '14.1 GB'],
      ['win-build', 38, '22.3 GB'],
      ['k3s-node-1', 31, '13.5 GB'],
      ['postgres-prod', 23, '11.8 GB'],
      ['gitlab-runner', 14, '6.2 GB'],
      ['opnsense-fw', 6, '1.9 GB'],
    ]);
    expect(page.history).toMatchObject({ range: '24h', stepS: 900 });
    expect(page.history.cpu).toHaveLength(96);
    expect(page.alerts).toEqual({ count: 1, items: [{ tone: 'warn', title: 'CPU package at 83 °C' }] });
  });

  it('shows a plain Linux server’s volumes, else its disks, and no guests', () => {
    const volumes = {
      volumes: [
        {
          entity: 'fs:/',
          kind: 'fs',
          label: '/',
          used_gb: 120,
          total_gb: 500,
          used_pct: 24,
          fs_type: 'ext4',
        },
        {
          entity: 'fs:/srv',
          kind: 'fs',
          label: '/srv',
          used_gb: 3500,
          total_gb: 4000,
          used_pct: 87.5,
          remote: true,
        },
        {
          entity: 'pool:tank',
          kind: 'pool',
          label: 'tank',
          used_gb: 9000,
          total_gb: 16000,
          used_pct: 56,
          layout: 'mirror',
        },
        {
          entity: 'fs:/mnt/x',
          kind: 'fs',
          label: '/mnt/x',
          used_gb: 0,
          total_gb: 0,
          used_pct: 0,
          error: 'stale',
        },
      ],
    };
    const detail = linux(volumes, [
      { device: 'nvme0n1', model: 'WD SN850X', capacity_gb: 2000, used_gb: 900 },
    ]);
    const page = valid(deskServerPage(input('granite', detail, { guests: [] })));
    expect(page.os).toBe('Debian GNU/Linux 13');
    expect(page.up).toBe('up 5 h');
    expect(page.cpu).toMatchObject({ cores: 8, load: '0.4' });
    expect(page.memory).toMatchObject({ used: { value: '30.1', unit: 'GB' }, total: '64 GB' });
    expect(page.volumes.map((v) => [v.name, v.note, v.percent])).toEqual([
      ['/srv', 'network share', 88],
      ['tank', 'mirror', 56],
      ['/', 'ext4', 24],
    ]);
    expect(page.guests).toBeNull();
    // An agent from before the volumes: the disks that say what they hold.
    const older = deskServerPage(
      input(
        'granite',
        linux({}, [{ device: 'nvme0n1', model: 'WD SN850X', capacity_gb: 2000, used_gb: 900 }]),
      ),
    );
    expect(older.volumes).toEqual([
      { name: 'nvme0n1', note: 'WD SN850X', percent: 45, used: '900 GB', total: '2 TB', tone: 'ok' },
    ]);
    expect(serverVolumes(toHostServerDetail(linux({}), [], null, now))).toEqual([]);
  });

  it('shows an off server’s card, its OS and its history, and nothing it measured before', () => {
    const page = valid(deskServerPage(input('marble', linux({}))));
    expect(page.server).toMatchObject({ id: 'marble', state: 'off' });
    expect(page).toMatchObject({
      up: '',
      cpu: null,
      memory: null,
      disk: null,
      temp: null,
      volumes: [],
      guests: null,
    });
    expect(page.network).toBeNull();
    expect(page.history.cpu.length).toBeGreaterThan(0);
    expect(page.alerts).toMatchObject({
      count: 1,
      items: [{ tone: 'bad', title: 'Whombat’s helper isn’t checking in' }],
    });
  });

  it('counts the alerts while locked; their titles show only unlocked or with Everything (DK-84)', () => {
    const at = (
      id: string,
      severity: 'critical' | 'warning',
      openedAt: string,
      over: Partial<HostAlert> = {},
    ) =>
      toHostAlert({
        id,
        server: 'shale',
        severity,
        title: `**${id}** to look at`,
        opened_at: openedAt,
        ...over,
      });
    const list = [
      at('a', 'warning', '2026-10-11T10:00:00Z'),
      at('b', 'critical', '2026-10-10T10:00:00Z'),
      at('c', 'warning', '2026-10-11T12:00:00Z'),
      at('d', 'warning', '2026-10-11T13:00:00Z'),
      // Acknowledged or resolved: no longer asking for a look.
      at('e', 'critical', '2026-10-11T13:30:00Z', {
        acknowledged: { at: '2026-10-11T13:31:00Z', by: 'mara' },
      } as never),
      at('f', 'critical', '2026-10-11T13:40:00Z', { state: 'resolved' } as never),
      toHostAlert({
        id: 'g',
        server: 'basalt',
        severity: 'critical',
        title: 'other',
        opened_at: '2026-10-11T13:00:00Z',
      }),
    ];
    expect(serverAlerts(list, 'shale', false)).toEqual({ count: 4, items: [] });
    const shown = serverAlerts(list, 'shale', true);
    expect(shown.count).toBe(4);
    expect(shown.items).toEqual([
      { tone: 'bad', title: 'b to look at' },
      { tone: 'warn', title: 'd to look at' },
      { tone: 'warn', title: 'c to look at' },
    ]);
    const locked = valid(
      deskServerPage(input('shale', raw('server-shale-proxmox.json'), { alerts: list, titles: false })),
    );
    expect(locked.alerts).toEqual({ count: 4, items: [] });
  });

  it('keeps every page within what the console reads', () => {
    const page = deskServerPage(input('shale', raw('server-shale-proxmox.json')));
    expect(serverPageValid(page, 'shale')).toBe(true);
    expect(serverPageValid(page, 'basalt')).toBe(false);
  });
});

describe('the chart (DK-S86)', () => {
  it('averages buckets counted back from now, a bucket without points null', () => {
    expect(downsample([1, 2, 3, 4, 5], 3)).toEqual({ points: [1, 2.5, 4.5], per: 2, ends: [0, 2, 4] });
    expect(downsample([1, 2, 3, 4, 5], 2)).toEqual({ points: [1.5, 4], per: 3, ends: [1, 4] });
    expect(downsample([null, null, 3, 5], 2)).toEqual({ points: [null, 4], per: 2, ends: [1, 3] });
    expect(downsample([7, null], 96)).toEqual({ points: [7, null], per: 1, ends: [0, 1] });
  });

  it('keeps at most 96 points, the step their bucket, CPU’s peak with when and memory’s mean', () => {
    const points = 200;
    const cpu = Array.from({ length: points }, (_, i) => (i === 150 ? 90 : i < 3 ? null : 10));
    const timestamps = Array.from({ length: points }, (_, i) =>
      new Date(now.getTime() - (points - 1 - i) * 3600_000).toISOString(),
    );
    const series = toHostSeries(
      {
        server: 'shale',
        range: 'custom',
        step_seconds: 3600,
        as_of: now.toISOString(),
        timestamps,
        series: { cpu_pct: cpu, mem_pct: cpu.map(() => 40.4) },
      },
      'shale',
      null,
      now,
    );
    const h = serverHistory(series, '7d', now);
    expect(h.cpu).toHaveLength(67);
    expect(h.memory).toHaveLength(67);
    expect(h.stepS).toBe(3 * 3600);
    expect(h.cpu[0]).toBeNull();
    // Buckets of three end with the last point (199, 196, …): the one ending at 151 holds the peak, (10 + 90 + 10) / 3.
    expect(h.cpuPeak).toEqual({ percent: 37, at: timestamps[151] });
    expect(h.memoryAvg).toBe(40);
    expect(serverHistory(null, '1h', now)).toEqual({
      range: '1h',
      stepS: 60,
      cpu: [],
      memory: [],
      cpuPeak: null,
      memoryAvg: null,
    });
  });
});

describe('the network and guests (DK-S85, DK-S87)', () => {
  it('writes the latest network point per second, as This Whombat’s', () => {
    const series = toHostSeries(
      { series: { net_rx_mbps: [100, 192, null], net_tx_mbps: [1, 24.8, null] } },
      'shale',
      null,
      now,
    );
    expect(serverNetwork(series)).toEqual({ down: '24 MB/s', up: '3.1 MB/s' });
    expect(serverNetwork(toHostSeries({ series: { cpu_pct: [1] } }, 'shale', null, now))).toBeNull();
  });

  it('counts unhealthy as running and paused as off, leaving off guests’ figures out', () => {
    const g = (name: string, state: string, cpu: number | null): HostGuest =>
      toHostGuest({ id: `docker:${name}`, name, state, cpu_pct: cpu, memory_used_mb: 512 }, 'granite');
    const list = serverGuests([
      g('plex', 'running', 22),
      g('db', 'unhealthy', 40),
      g('old', 'paused', 0),
      g('win11-test', 'stopped', null),
    ]);
    expect(list).toMatchObject({ running: 2, off: 2 });
    expect(list?.items.map((i) => [i.name, i.state, i.cpu, i.memory])).toEqual([
      ['db', 'unhealthy', 40, '512 MB'],
      ['plex', 'running', 22, '512 MB'],
      ['old', 'paused', null, ''],
      ['win11-test', 'stopped', null, ''],
    ]);
    expect(serverGuests(null)).toBeNull();
  });
});

describe('reading a server for its screen', () => {
  it('asks for the detail and the series with the range; a part that fails is left out, the detail isn’t', async () => {
    const asked: { path: string; query: unknown }[] = [];
    const hosts = {
      call: async <T>(req: { path: string; query?: unknown }) => {
        asked.push({ path: req.path, query: req.query });
        if (req.path.endsWith('/metrics')) throw new Error('no metrics');
        return raw('server-shale-proxmox.json') as T;
      },
      guestsRaw: async () => {
        throw new Error('no guests');
      },
      openAlertsRaw: async () => fleetRaw.alerts as unknown[],
    };
    const parts = await readServerParts(hosts, 'shale', '7d', now);
    expect(asked).toEqual([
      { path: '/api/v1/servers/shale', query: { range: '7d' } },
      {
        path: '/api/v1/servers/shale/metrics',
        query: { range: '7d', series: 'cpu_pct,mem_pct,net_rx_mbps,net_tx_mbps' },
      },
    ]);
    expect(parts.detail.server.id).toBe('shale');
    expect(parts).toMatchObject({ series: null, guests: null });
    expect(parts.alerts.map((a) => a.id)).toEqual(['al_01', 'al_02', 'al_03']);
    const down = { ...hosts, call: async () => Promise.reject(new Error('down')) };
    await expect(readServerParts(down, 'shale', '24h', now)).rejects.toThrow('down');
  });
});
