/**
 * UniFi Network's and Hetzner Cloud's pages and tiles from recorded answers (connection-pages.md CP-09, CP-11, CP-16;
 * connection-pages-server.md CP-S14, CP-S15; dashboards.md DS-12, DS-13). Pure.
 */
import { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { gridTimes, type RawPoint } from '../series';
import {
  agentNote,
  euros,
  HETZNER_CHECKS,
  type HetznerInput,
  type HetznerServer,
  type HetznerSnapshot,
  hetznerCharts,
  hetznerFacts,
  hetznerGlanceOf,
  hetznerMetrics,
  hetznerNotices,
  hetznerRows,
  hetznerServer,
  hetznerSkipped,
  hetznerView,
  metricsServers,
  parseSnapshots,
  sameServer,
  sentPoints,
  whombatServers,
} from './hetzner';
import { slotProblems } from './slots';
import {
  BUSY_WINDOW_MS,
  downloadedByDay,
  gatewayCpuOf,
  UNIFI_CHECKS,
  type UnifiDevice,
  type UnifiInput,
  type UnifiSnapshot,
  unifiDevice,
  unifiDeviceRows,
  unifiGateway,
  unifiGlanceOf,
  unifiNotices,
  unifiSkipped,
  unifiView,
} from './unifi';

/* Recorded answers (UniFi Network 9.1 `/v1/sites/{id}/devices`, `…/statistics/latest`; Hetzner `/v1/servers`). */

const UNIFI_DEVICES = {
  offset: 0,
  limit: 200,
  count: 4,
  totalCount: 4,
  data: [
    {
      id: 'gw',
      name: 'Gateway',
      model: 'UCG-Ultra',
      macAddress: 'aa',
      ipAddress: '10.100.0.1',
      state: 'ONLINE',
      features: ['switching'],
    },
    {
      id: 'ap1',
      name: 'Kitchen AP',
      model: 'U7-Pro',
      ipAddress: '10.100.0.21',
      state: 'ONLINE',
      features: ['accessPoint'],
    },
    {
      id: 'ap2',
      name: 'Garden AP',
      model: 'U6-Mesh',
      ipAddress: '10.100.0.22',
      state: 'OFFLINE',
      features: ['accessPoint'],
    },
    {
      id: 'sw1',
      name: 'Office switch',
      model: 'USW-Lite-8-PoE',
      ipAddress: '10.100.0.30',
      state: 'ONLINE',
      features: ['switching'],
    },
  ],
};
const UNIFI_DETAILS: Record<string, unknown> = {
  gw: { firmwareVersion: '4.1.13', firmwareUpdatable: false },
  ap1: { firmwareVersion: '7.0.66', firmwareUpdatable: true },
  ap2: { firmwareVersion: '6.6.77', firmwareUpdatable: false },
  sw1: { firmwareVersion: '7.1.26', firmwareUpdatable: false },
};
const UNIFI_STATS = {
  uptimeSec: 1_036_800,
  cpuUtilizationPct: 12.4,
  memoryUtilizationPct: 48.1,
  uplink: { txRateBps: 40_200_000, rxRateBps: 312_400_000 },
};

function unifiSnap(): UnifiSnapshot {
  const devices = UNIFI_DEVICES.data.map((d) => unifiDevice(d, UNIFI_DETAILS[d.id]));
  return {
    readAt: new Date(),
    version: '9.1.120',
    devices,
    clients: 174,
    gateway: unifiGateway(devices[0] as ReturnType<typeof unifiDevice>, UNIFI_STATS),
  };
}

const UNIFI_NOW = new Date('2026-10-18T12:00:00Z');

/** `days` days of readings every 5 minutes up to now: 100 Mb/s down, 170 to 200 clients, 480 Mb/s once today. */
function history(days: number): Map<string, RawPoint[]> {
  const step = 5 * 60_000;
  const n = Math.floor((days * 86_400_000) / step);
  const at = (i: number) => new Date(UNIFI_NOW.getTime() - (n - 1 - i) * step);
  const down = Array.from({ length: n }, (_, i) => ({ at: at(i), value: i === n - 3 ? 480 : 100 }));
  const clients = Array.from({ length: n }, (_, i) => ({ at: at(i), value: 170 + (i % 30) }));
  return new Map([
    ['wan_rx_mbps', down],
    ['clients', clients],
  ]);
}

function unifiInput(over: Partial<UnifiInput> = {}): UnifiInput {
  const timestamps = gridTimes('24h', UNIFI_NOW).map((d) => d.toISOString());
  return {
    snapshot: { ...unifiSnap(), readAt: UNIFI_NOW },
    points: {
      timestamps,
      down: timestamps.map((_, i) => 300 + (i % 4)),
      up: timestamps.map((_, i) => 40 + (i % 4)),
      cpuRaw: [],
    },
    history: history(14),
    now: UNIFI_NOW,
    timeZone: 'Europe/Amsterdam',
    machineKnown: false,
    ...over,
  };
}

describe('UniFi Network', () => {
  it('knows the gateway by its model and the firmware from the details', () => {
    const s = unifiSnap();
    expect(s.devices[0]).toMatchObject({ gateway: true, firmware: '4.1.13' });
    expect(s.devices[1]).toMatchObject({ accessPoint: true, updatable: true });
    expect(s.gateway).toMatchObject({ cpuPct: 12.4, rxMbps: 312.4, txMbps: 40.2, uptimeS: 1_036_800 });
  });

  it('the tile: the internet line, access points online, clients; the dot from the lines', () => {
    const s = unifiSnap();
    expect(unifiGlanceOf(s)).toEqual({
      status: 'warn',
      line: '4 devices',
      facts: [
        { label: 'Internet', value: '312 / 40', unit: 'Mb/s' },
        { label: 'Access points', value: '1 of 2', note: 'online' },
        { label: 'Clients', value: '174' },
      ],
      reason: 'Garden AP is offline',
    });
    // Only a heads-up left: fine.
    const up = { ...s, devices: s.devices.map((d) => ({ ...d, state: 'ONLINE' })) };
    expect(unifiGlanceOf(up)).toMatchObject({ status: 'ok' });
    expect(unifiGlanceOf(up).reason).toBeUndefined();
  });

  it('notices and the Devices table, without anyone’s client list', () => {
    const s = unifiSnap();
    expect(unifiNotices(s).map((n) => [n.tone, n.nature, n.title, n.detail])).toEqual([
      ['warn', 'problem', 'Garden AP is offline', undefined],
      ['info', 'fyi', 'Kitchen AP has an update', undefined],
    ]);
    const rows = unifiDeviceRows(s);
    expect(rows[0]?.cells.name?.text).toBe('Garden AP');
    expect(rows[0]?.cells.state).toEqual({ text: 'Offline', dot: 'bad' });
    expect(rows.find((r) => r.id === 'ap1')?.cells.firmware).toEqual({
      text: '7.0.66',
      mono: true,
      note: 'update',
      tone: 'warn',
    });
    expect(JSON.stringify(rows)).not.toMatch(/client/i);
  });

  it('in slots: the network now, what is on it, the internet this week; the internet over the range below', () => {
    const v = unifiView(unifiInput());
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    expect(v.machine).toBe('after');
    for (const p of v.panels) ThingPagePanel.parse(p);
    expect(v.panels.map((p) => [p.id, p.place ?? null])).toEqual([
      ['now', 'chart'],
      ['equipment', 'chart'],
      ['week', 'chart'],
      ['internet', 'main'],
      ['devices', 'main'],
    ]);
    const now = v.panels[0];
    if (now?.kind !== 'list') throw new Error('no live list');
    expect(now.meta).toBe('Gateway up 12 days');
    expect(now.items.map((i) => [i.id, i.title, i.figure?.value, i.detail])).toEqual([
      ['internet', 'Internet', '312 / 40 Mb/s', 'Down · up now · busiest today 480 Mb/s'],
      ['clients', 'Connected now', '174', 'Phones, laptops and more · most today 199'],
      ['online', 'Devices online', '3 of 4', 'Access points, switches and the gateway'],
    ]);
    expect(now.items[2]).toMatchObject({ tone: 'warn', figure: { tone: 'warn', note: '1 offline' } });
    // The gateway's own load only when the card is another machine's.
    const known = unifiView(unifiInput({ machineKnown: true })).panels[0];
    expect(known?.kind === 'list' && known.items.at(-1)).toMatchObject({
      id: 'gateway',
      figure: { value: '12 %' },
      detail: 'Gateway busy now · memory 48 %',
    });
    // Nobody's client list (CP-09): only how many.
    expect(JSON.stringify(v.panels)).not.toMatch(/iPhone|Anna/);
    const equipment = v.panels[1];
    if (equipment?.kind !== 'list') throw new Error('no inventory');
    expect(equipment.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['Access points', '2', '1 offline'],
      ['Switches', '1', 'All online'],
      ['Gateway', '1', 'All online'],
      ['Updates waiting', '1', 'Firmware'],
    ]);
    expect(equipment.items[2]?.detail).toBe('UCG-Ultra');
    expect(equipment.items[3]?.detail).toBe('Kitchen AP · 7.0.66 now');
    // The gateway's own chart is gone: the machine card and Worth a look say it.
    expect(v.panels.some((p) => p.id === 'gateway')).toBe(false);
    const chart = v.panels.find((p) => p.id === 'internet');
    expect(chart?.kind === 'chart' && chart.series.map((x) => [x.label, x.color, x.latest])).toEqual([
      ['Down', 'green', '312 Mb/s'],
      ['Up', 'orange', '40 Mb/s'],
    ]);
  });

  it('the internet this week: about how much came down per day, from Whombat’s readings', () => {
    const v = unifiView(unifiInput());
    const week = v.panels.find((p) => p.id === 'week');
    if (week?.kind !== 'chart') throw new Error('no trend');
    expect(week.labels?.at(-1)).toBe('Today');
    // 100 Mb/s all day is 1,080 GB; today until 14:00 in Amsterdam is 14 hours of it, with one 480 Mb/s reading.
    expect(week.series[0]?.values.slice(-2)).toEqual([1080, 644.3]);
    expect(week.figure?.value).toMatch(/^about /);
    expect(week.meta).toContain('About');
    // Two weeks read: the change on the week before.
    expect(week.stats?.[0]?.[0]?.text).toBe('+0 %');
    // Under two days of readings there is no Trend.
    const one = unifiView(unifiInput({ history: history(0.25) }));
    expect(one.panels.some((p) => p.id === 'week')).toBe(false);
  });

  it('counts a reading until the next one, at most an hour, so a partly watched day counts that part', () => {
    const tz = 'UTC';
    const now = new Date('2026-10-18T12:00:00Z');
    const pts: RawPoint[] = [
      { at: new Date('2026-10-17T10:00:00Z'), value: 80 },
      { at: new Date('2026-10-17T10:05:00Z'), value: 80 },
      // A gap of three hours counts one.
      { at: new Date('2026-10-17T13:00:00Z'), value: 8 },
      { at: new Date('2026-10-18T11:55:00Z'), value: 16 },
    ];
    const got = downloadedByDay(pts, ['2026-10-17', '2026-10-18'], tz, now);
    // 80 Mb/s × 5 min + 80 × 1 h + 8 × 1 h = 3 + 36 + 3.6 GB; today 16 × 5 min = 0.6 GB.
    expect(got.map((g) => Math.round((g ?? 0) * 10) / 10)).toEqual([42.6, 0.6]);
  });

  it('the machine: the gateway’s own figures on a console, the known machine’s card on a server', () => {
    const own = unifiView(unifiInput());
    expect(own.slots?.own).toMatchObject({ name: 'Gateway · UCG-Ultra', figures: { cpuPct: 12.4 } });
    expect(own.slots?.machine.map((b) => [b.label, b.value, b.sub ?? null])).toEqual([
      ['Memory', '48 %', null],
      ['UniFi Network', '9.1.120', null],
      ['Gateway firmware', '4.1.13', 'Up to date'],
      ['Gateway up', '12 days', null],
    ]);
    const known = unifiView(unifiInput({ machineKnown: true }));
    expect(known.slots?.own).toBeUndefined();
    expect(known.slots?.machine.map((b) => b.label)).toEqual([
      'UniFi Network',
      'Gateway firmware',
      'Gateway up',
    ]);
  });

  it('a gateway that is offline is bad', () => {
    const s = unifiSnap();
    const down = { ...s, devices: s.devices.map((d) => (d.gateway ? { ...d, state: 'OFFLINE' } : d)) };
    expect(unifiGlanceOf(down)).toMatchObject({ status: 'bad', reason: 'The gateway is offline' });
    expect(unifiNotices(down)[0]).toMatchObject({
      tone: 'bad',
      title: 'The gateway Gateway is offline',
      nature: 'problem',
      check: 'unifi.gateway_offline',
      ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
      confirm: 2,
    });
    expect(unifiNotices(down)[0]?.subject).toBeUndefined();
  });
});

describe('UniFi Network: what Whombat watches (quiet-notices.md QN-01…QN-04)', () => {
  const ap = (i: number, state = 'OFFLINE'): UnifiDevice => ({
    id: `ap${i}`,
    name: `AP ${String(i).padStart(2, '0')}`,
    model: 'U6-Lite',
    state,
    ip: null,
    accessPoint: true,
    switching: false,
    gateway: false,
    firmware: '6.6.1',
    updatable: false,
  });
  const snap = (devices: UnifiDevice[], cpuPct: number | null = 10): UnifiSnapshot => ({
    readAt: new Date(),
    version: '9.1',
    devices,
    clients: 3,
    gateway: { id: 'gw', name: 'Gateway', cpuPct, memoryPct: 40, uptimeS: 1, rxMbps: 1, txMbps: 1 },
  });

  it('one line per offline device: its own subject, Ignore until it’s back online, two passes first', () => {
    const lines = unifiNotices(snap([ap(1), ap(2, 'CONNECTION_INTERRUPTED'), ap(3, 'ONLINE')]));
    expect(lines.map((n) => [n.id, n.check, n.subject?.id, n.subject?.name])).toEqual([
      ['offline-ap1', 'unifi.device_offline', 'device:ap1', 'AP 01'],
      ['offline-ap2', 'unifi.device_offline', 'device:ap2', 'AP 02'],
    ]);
    for (const n of lines) {
      expect(n).toMatchObject({ nature: 'problem', confirm: 2, link: { kind: 'ask' } });
      expect(n.ignore).toEqual({ lifts: 'fixed', words: 'Until it’s back online.' });
    }
    expect(lines[0]?.link).toMatchObject({ question: 'Why is AP 01 offline in UniFi?' });
    expect(lines[1]?.detail).toContain('Connection lost');
  });

  it('past three, the rest share the third line, whose episode is the rest’s ids', () => {
    const many = Array.from({ length: 11 }, (_, i) => ap(i + 1));
    const lines = unifiNotices(snap(many));
    expect(lines).toHaveLength(3);
    const more = lines[2];
    expect(more).toMatchObject({
      check: 'unifi.device_offline',
      subject: { id: '+more', name: '9 more' },
      ignore: { lifts: 'newer' },
      title: '9 more access points offline',
    });
    const other = unifiNotices(snap([...many.slice(0, 10), ap(12)]))[2];
    expect(other?.episode).toBeTruthy();
    expect(other?.episode).not.toBe(more?.episode);
  });

  it('a busy gateway: a heads-up for a peak, a problem when it averaged 80 % over half an hour', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const at = (minAgo: number, value: number) => ({ at: new Date(now.getTime() - minAgo * 60_000), value });
    const peak = gatewayCpuOf([at(5, 20), at(10, 30), at(15, 25), at(20, 22)], 95, now);
    const [p] = unifiNotices(snap([], 95), peak);
    expect(p).toMatchObject({ check: 'unifi.gateway_busy', nature: 'fyi', tone: 'info' });
    expect(p?.link).toBeUndefined();
    const busy = gatewayCpuOf([at(5, 85), at(10, 90), at(15, 82), at(25, 88), at(40, 10)], 70, now);
    expect(busy.readings).toBe(5);
    const [b] = unifiNotices(snap([], 70), busy);
    expect(b).toMatchObject({
      check: 'unifi.gateway_busy',
      nature: 'problem',
      tone: 'warn',
      link: { kind: 'ask' },
      ignore: { lifts: 'fixed', words: 'Until it calms down.' },
      badge: 'The gateway is busy',
    });
    // Too few readings to say it lasted: still a heads-up.
    expect(unifiNotices(snap([], 90), gatewayCpuOf([at(5, 90)], 90, now))[0]?.nature).toBe('fyi');
    // Calm: no line.
    expect(unifiNotices(snap([], 30), gatewayCpuOf([], 30, now))).toEqual([]);
    expect(BUSY_WINDOW_MS).toBe(30 * 60_000);
  });

  it('firmware: one heads-up for every device that has it, until newer firmware', () => {
    const lines = unifiNotices(snap([{ ...ap(1, 'ONLINE'), updatable: true }]));
    expect(lines).toEqual([
      expect.objectContaining({
        check: 'unifi.firmware',
        nature: 'fyi',
        tone: 'info',
        title: 'AP 01 has an update',
      }),
    ]);
    expect(lines[0]?.subject).toBeUndefined();
    expect(lines[0]?.ignore).toMatchObject({ lifts: 'newer' });
    const three = unifiNotices(snap([1, 2, 3].map((i) => ({ ...ap(i, 'ONLINE'), updatable: true }))));
    expect(three.map((n) => [n.check, n.title, n.detail])).toEqual([
      ['unifi.firmware', '3 devices have updates', 'AP 01 and 2 more'],
    ]);
    // Another firmware for one of them is news again.
    const newer = unifiNotices(
      snap(
        [1, 2, 3].map((i) => ({
          ...ap(i, 'ONLINE'),
          updatable: true,
          ...(i === 2 ? { firmware: '6.7.0' } : {}),
        })),
      ),
    );
    expect(newer[0]?.episode).not.toBe(three[0]?.episode);
  });

  it('what it couldn’t read doesn’t lift an Ignore; every check it raises is in its list', () => {
    expect(unifiSkipped(snap([]), true)).toEqual([]);
    expect(unifiSkipped(snap([], null), true)).toEqual(['unifi.gateway_busy']);
    expect(unifiSkipped({ ...snap([]), devicesCapped: true }, false)).toEqual([
      'unifi.gateway_offline',
      'unifi.device_offline',
      'unifi.firmware',
      'unifi.gateway_busy',
    ]);
    expect(unifiSkipped({ ...snap([]), firmwareUnread: true }, true)).toEqual(['unifi.firmware']);
    const checks = new Set(UNIFI_CHECKS.map((c) => c.check));
    const gw = { ...ap(9), id: 'gw', gateway: true, accessPoint: false };
    const all = unifiNotices(snap([gw, ap(1), { ...ap(2, 'ONLINE'), updatable: true }], 95));
    for (const n of all) expect(checks.has(n.check)).toBe(true);
  });
});

const HETZNER_SERVERS = {
  servers: [
    {
      id: 42,
      name: 'web-1',
      status: 'running',
      public_net: { ipv4: { ip: '203.0.113.12' }, ipv6: { ip: '2001:db8:c0c:1234::/64' } },
      image: { name: 'debian-13', description: 'Debian 13' },
      outgoing_traffic: 17_592_186_044_416,
      ingoing_traffic: 1_000_000_000,
      included_traffic: 21_990_232_555_520,
      server_type: {
        name: 'cx22',
        cores: 2,
        memory: 4,
        disk: 40,
        prices: [
          { location: 'fsn1', price_monthly: { net: '3.79', gross: '4.5101000000' } },
          { location: 'nbg1', price_monthly: { net: '3.79', gross: '4.5101' } },
        ],
      },
      datacenter: { location: { name: 'fsn1', city: 'Falkenstein' } },
      backup_window: null,
      protection: { delete: false, rebuild: false },
    },
    {
      id: 43,
      name: 'db-1',
      status: 'off',
      public_net: { ipv4: { ip: '203.0.113.13' } },
      image: { name: 'ubuntu-24.04', description: 'Ubuntu 24.04' },
      outgoing_traffic: 0,
      included_traffic: 21_990_232_555_520,
      server_type: {
        name: 'cx32',
        cores: 4,
        memory: 8,
        disk: 80,
        prices: [{ location: 'nbg1', price_monthly: { gross: '8.3300' } }],
      },
      datacenter: { location: { name: 'nbg1', city: 'Nuremberg' } },
      backup_window: '22-02',
      protection: { delete: true, rebuild: true },
    },
  ],
};

/** Hetzner's `GET /v1/servers/42/metrics?type=cpu,disk,network&step=900` (recorded, cut to an hour). */
function metricsAnswer(now: Date): unknown {
  const t = (minAgo: number) => now.getTime() / 1000 - minAgo * 60;
  const at = [60, 45, 30, 15, 0].map(t);
  const series = (values: string[]) => ({ values: at.map((x, i) => [x, values[i] as string]) });
  return {
    metrics: {
      start: new Date(at[0] as number).toISOString(),
      end: now.toISOString(),
      step: 900,
      time_series: {
        // 100 per vCPU: 14 % of two vCPUs is 7 %.
        cpu: series(['10.2', '14.0', '76.5', '12.1', '14.0']),
        'disk.0.iops.read': series(['0', '1', '0', '0', '0']),
        'disk.0.bandwidth.read': series(['200000', '150000', '0', '250000', '200000']),
        'disk.0.bandwidth.write': series(['1100000', '900000', '1300000', '1000000', '1100000']),
        'network.0.bandwidth.in': series(['262500', '250000', '300000', '275000', '262500']),
        'network.0.bandwidth.out': series(['425000', '400000', '450000', '410000', '425000']),
        'network.0.pps.in': series(['20', '20', '20', '20', '20']),
      },
    },
  };
}

describe('Hetzner Cloud', () => {
  const s: HetznerSnapshot = {
    readAt: new Date(),
    servers: HETZNER_SERVERS.servers.map(hetznerServer),
    volumes: [{ id: '1', name: 'data', sizeGb: 50, server: 'db-1', location: 'nbg1', createdAt: null }],
  };
  const now = new Date('2026-10-18T12:00:00Z');
  const web1 = s.servers[0] as ReturnType<typeof hetznerServer>;

  /** Two weeks of hourly readings up to now: 1 MB/s out, every hour. */
  const sent = (days: number): RawPoint[] =>
    Array.from({ length: days * 24 }, (_, i) => ({
      at: new Date(now.getTime() - (days * 24 - 1 - i) * 3600_000),
      value: 1e6,
    }));
  const hetznerInput = (over: Partial<HetznerInput> = {}): HetznerInput => ({
    snapshot: {
      ...s,
      volumes: [
        {
          id: '1',
          name: 'data',
          sizeGb: 50,
          server: 'db-1',
          location: 'nbg1',
          createdAt: new Date(now.getTime() - 86_400_000),
        },
      ],
    },
    metrics: [hetznerMetrics(metricsAnswer(now), web1, '24h', now)],
    whombat: new Map(),
    snapshots: {
      total: 3,
      created: [
        new Date(now.getTime() - 3600_000),
        new Date(now.getTime() - 2 * 86_400_000),
        new Date('2026-09-01T00:00:00Z'),
      ],
      sizeGb: 42,
    },
    sent: { points: [sent(14)], read: 1 },
    now,
    timeZone: 'Europe/Amsterdam',
    ...over,
  });

  it('servers with their price at their location, their OS and this month’s traffic', () => {
    expect(s.servers[0]).toMatchObject({
      type: 'cx22',
      cores: 2,
      memoryGb: 4,
      city: 'Falkenstein',
      os: 'Debian 13',
      ipv6: '2001:db8:c0c:1234::/64',
      monthlyEur: 4.5101,
      backups: false,
      includedBytes: 21_990_232_555_520,
    });
    expect(euros(4.5101 + 8.33)).toBe('€ 12.84');
  });

  it('metrics in plain units: CPU a share of all vCPUs, network in Mb/s, disk in MB/s (DS-12)', () => {
    const m = hetznerMetrics(metricsAnswer(now), web1, '1h', now);
    expect(m.timestamps).toHaveLength(60);
    const read = (v: (number | null)[]) => v.filter((x): x is number => x !== null);
    // The hour's first sample is where the range starts, so not in it.
    expect(read(m.cpu)).toEqual([7, 38.25, 6.05, 7]);
    expect(read(m.netIn)).toEqual([2, 2.4, 2.2, 2.1]);
    expect(read(m.netOut)).toEqual([3.2, 3.6, 3.28, 3.4]);
    expect(read(m.diskWrite)).toEqual([0.9, 1.3, 1, 1.1]);
    expect(metricsServers(s).map((x) => x.name)).toEqual(['web-1', 'db-1']);
  });

  it('CPU and Network over the range, below the slots; one server has its own lines', () => {
    const m = hetznerMetrics(metricsAnswer(now), web1, '24h', now);
    const charts = hetznerCharts(s, [m], now, 'Europe/Amsterdam');
    expect(charts.map((c) => [c.id, c.series.map((x) => [x.label, x.color, x.latest])])).toEqual([
      ['cpu', [['web-1', 'blue', '7 %']]],
      [
        'network',
        [
          ['In', 'green', '2.1 Mb/s'],
          ['Out', 'orange', '3.4 Mb/s'],
        ],
      ],
    ]);
    expect(charts.every((c) => c.place === undefined && c.span === undefined)).toBe(true);
    expect(charts[0]).toMatchObject({
      figure: { value: '7 %', rest: 'web-1' },
      axis: { min: 0, max: 100, unit: '%' },
    });
    expect(charts[0]?.stats?.map((l) => l.map((p) => p.text).join(''))).toEqual([
      'Avg 13 %',
      'Peak 38 % Sun 13:30',
    ]);
    const two = hetznerCharts(s, [m, { ...m, serverId: '43' }], now, 'Europe/Amsterdam');
    expect(two[1]?.series.map((x) => [x.key, x.label, x.color])).toEqual([
      ['s1', 'web-1', 'blue'],
      ['s2', 'db-1', 'orange'],
    ]);
    expect(two[0]?.figure?.rest).toBe('web-1');
  });

  it('in slots: servers now with their CPU and traffic, “Open” for a Whombat server, the project, the note below', () => {
    expect(sameServer(web1, '203.0.113.12')).toBe(true);
    expect(sameServer(web1, '2001:db8:c0c:1234::1')).toBe(true);
    expect(sameServer(web1, '2001:db8:c0c:9999::1')).toBe(false);
    const machines = [
      { serverId: 'web-1', guestId: null, addresses: ['2001:db8:c0c:1234::1'] },
      { serverId: 'pve-02', guestId: 'pve:131', addresses: ['203.0.113.13'] },
    ];
    const whombat = whombatServers(s, machines);
    expect([...whombat]).toEqual([['42', 'web-1']]);
    const v = hetznerView(hetznerInput({ whombat }));
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    for (const p of v.panels) ThingPagePanel.parse(p);
    expect(v.panels.map((p) => [p.id, p.place])).toEqual([
      ['servers', 'chart'],
      ['project', 'chart'],
      ['week', 'chart'],
      ['cpu', 'main'],
      ['network', 'main'],
    ]);
    const live = v.panels[0];
    if (live?.kind !== 'gallery') throw new Error('no live rows');
    expect(live).toMatchObject({ look: 'rows', shape: 'square', meta: '1 of 2 running · € 12.84 a month' });
    expect(live.items[0]).toMatchObject({
      title: 'web-1',
      sub: 'CX22 · 2 vCPU · 4 GB · Falkenstein',
      progress: 0.07,
      note: 'CPU 7 %',
      noteEnd: '2.1 Mb/s in · 3.4 Mb/s out',
      href: '/things/server%3Aweb-1',
    });
    expect(live.items[1]).toMatchObject({
      title: 'db-1',
      badge: { text: 'Off', tone: 'warn' },
      paused: true,
      progress: 0,
    });
    expect(live.items[1]?.href).toBeUndefined();
    const project = v.panels[1];
    if (project?.kind !== 'list') throw new Error('no inventory');
    expect(project.items.map((i) => [i.title, i.figure?.value, i.figure?.note, i.figure?.tone])).toEqual([
      ['Servers', '2', '1 not running', 'warn'],
      ['Volumes', '1', '+1 this week', 'ok'],
      ['Snapshots', '3', '+2 this week', 'ok'],
      ['Traffic this month', '16 TB', '40 % of 40 TB', undefined],
      ['Cost a month', '€ 12.84', 'servers, before traffic', undefined],
    ]);
    expect(project.items[2]?.detail).toBe('42 GB in all');
    // The note below the slots for a server Whombat doesn't watch.
    const others = hetznerView(hetznerInput());
    expect(others.panels.at(-1)).toEqual({
      kind: 'text',
      id: 'agent-note',
      place: 'main',
      body: 'Hetzner can’t see memory or disk space. Add web-1 as a server to see them here.',
      link: { kind: 'href', label: 'Add as a server', href: '/things/servers?add=1&address=203.0.113.12' },
    });
    expect(agentNote(s, whombat)).toBeNull();
  });

  it('traffic out this week: what the servers sent per day from Hetzner’s hourly readings', () => {
    const v = hetznerView(hetznerInput());
    const week = v.panels.find((p) => p.id === 'week');
    if (week?.kind !== 'chart') throw new Error('no trend');
    // 1 MB/s for every hour of a day is 86.4 GB; today’s readings from 00:00 to 14:00 in Amsterdam are 15 hours of it.
    expect(week.series[0]?.values.slice(-2)).toEqual([86.4, 54]);
    expect(week).toMatchObject({ title: 'Traffic out this week', meta: 'Sent per day · 1 of 2 servers' });
    expect(week.figure).toEqual({ value: 'about 572 GB', rest: 'out this week' });
    expect(week.series[0]?.color).toBe('orange');
    expect(week.stats?.[0]?.[0]?.text).toBe('+0 %');
    expect(hetznerView(hetznerInput({ sent: null })).panels.some((p) => p.id === 'week')).toBe(false);
    expect(
      sentPoints({ metrics: { time_series: { 'network.0.bandwidth.out': { values: [[1, '5']] } } } }),
    ).toEqual([{ at: new Date(1000), value: 5 }]);
  });

  it('reads the snapshots’ count, when the newest were made and their size', () => {
    const got = parseSnapshots({
      images: [
        { id: 1, type: 'snapshot', created: '2026-10-17T09:00:00+00:00', image_size: 2.5 },
        { id: 2, type: 'snapshot', created: '2026-09-01T09:00:00+00:00', image_size: 1.5 },
      ],
      meta: { pagination: { total_entries: 2 } },
    });
    expect(got).toEqual({
      total: 2,
      created: [new Date('2026-10-17T09:00:00Z'), new Date('2026-09-01T09:00:00Z')],
      sizeGb: 4,
    });
    // More than one page: the size of the first page alone would mislead.
    expect(parseSnapshots({ images: [], meta: { pagination: { total_entries: 60 } } })).toMatchObject({
      total: 60,
      sizeGb: null,
    });
    expect(
      hetznerServer({ ...HETZNER_SERVERS.servers[0], created: '2026-10-16T08:00:00+00:00' }).createdAt,
    ).toEqual(new Date('2026-10-16T08:00:00Z'));
  });

  it('notices, the tile, the head and the Servers tab', () => {
    expect(hetznerNotices(s).map((n) => [n.tone, n.nature, n.title, n.detail, n.link?.label])).toEqual([
      ['warn', 'problem', 'db-1 isn’t running', 'Off · CX32 · Nuremberg', 'Look into it'],
      ['info', 'fyi', 'web-1 has no backups', 'Hetzner’s backups are 20 % of the server price', undefined],
      [
        'info',
        'fyi',
        'Delete protection is off for web-1',
        'Turn it on in Hetzner so nothing is deleted by mistake.',
        undefined,
      ],
    ]);
    const busy = {
      ...s,
      servers: s.servers.map((x) => ({ ...x, outgoingBytes: (x.includedBytes ?? 0) * 0.83 })),
    };
    expect(hetznerNotices(busy, now)[1]).toMatchObject({
      tone: 'info',
      nature: 'fyi',
      title: 'Traffic is at 83 % of what’s included',
      detail: '33 of 40 TB going out this month',
      check: 'hetzner.traffic',
      band: 80,
      ignore: { lifts: 'period', words: 'Until next month.', until: '2026-11-01T00:00:00.000Z' },
    });
    const over = {
      ...s,
      servers: s.servers.map((x) => ({ ...x, outgoingBytes: (x.includedBytes ?? 0) * 1.1 })),
    };
    expect(hetznerNotices(over, now)[1]).toMatchObject({
      tone: 'warn',
      nature: 'problem',
      band: 100,
      link: { kind: 'ask' },
    });
    expect(hetznerGlanceOf(s)).toEqual({
      status: 'warn',
      reason: 'db-1 isn’t running',
      line: '2 servers',
      facts: [{ label: 'Servers', value: '1 of 2', note: 'running' }],
    });
    expect(hetznerFacts(s).map((l) => l.map((p) => p.text).join(''))).toEqual([
      '2 servers',
      'Falkenstein · Nuremberg',
    ]);
    expect(hetznerRows(s)[0]?.cells).toMatchObject({
      type: { text: 'CX22', note: '2 cores · 4 GB · 40 GB disk' },
      location: { text: 'Falkenstein · fsn1' },
      cost: { text: '€ 4.51' },
    });
  });
});

describe('Hetzner Cloud: what Whombat watches (quiet-notices.md QN-01…QN-04)', () => {
  const server = (id: number, status = 'off', over: Partial<HetznerServer> = {}): HetznerServer => ({
    ...hetznerServer(HETZNER_SERVERS.servers[0]),
    id: String(id),
    name: `srv-${id}`,
    status,
    backups: true,
    deleteProtection: true,
    outgoingBytes: 0,
    ...over,
  });
  const snap = (servers: HetznerServer[]): HetznerSnapshot => ({
    readAt: new Date(),
    servers,
    volumes: null,
  });

  it('one line per server that is off, after two passes, not while it starts, stops or moves', () => {
    const lines = hetznerNotices(
      snap([server(1), server(2, 'starting'), server(3, 'rebuilding'), server(4, 'unknown')]),
    );
    expect(lines.map((n) => [n.check, n.subject?.id, n.confirm, n.ignore?.words])).toEqual([
      ['hetzner.not_running', 'server:1', 2, 'Until it’s running.'],
      ['hetzner.not_running', 'server:4', 2, 'Until it’s running.'],
    ]);
  });

  it('standing choices are one heads-up each for all servers, without an agent', () => {
    const lines = hetznerNotices(snap([server(1, 'running', { backups: false, deleteProtection: false })]));
    expect(lines.map((n) => [n.check, n.nature, n.tone, n.subject, n.link])).toEqual([
      ['hetzner.no_backups', 'fyi', 'info', undefined, undefined],
      ['hetzner.delete_protection', 'fyi', 'info', undefined, undefined],
    ]);
    const three = hetznerNotices(
      snap([1, 2, 3].map((i) => server(i, 'running', { backups: false, deleteProtection: false }))),
    );
    expect(three.map((n) => [n.check, n.title])).toEqual([
      ['hetzner.no_backups', '3 servers have no backups'],
      ['hetzner.delete_protection', 'Delete protection is off for 3 servers'],
    ]);
    expect(three[0]?.detail).toContain('srv-1 and 2 more');
    expect(hetznerGlanceOf(snap([server(1, 'running', { backups: false })]))).toMatchObject({ status: 'ok' });
  });

  it('past three servers the rest share the third line; a capped list lifts nothing', () => {
    const many = Array.from({ length: 10 }, (_, i) => server(i + 1));
    const lines = hetznerNotices(snap(many));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ subject: { id: '+more', name: '8 more' }, ignore: { lifts: 'newer' } });
    expect(hetznerSkipped(snap(many))).toEqual([]);
    expect(hetznerSkipped({ ...snap(many), serversCapped: true })).toEqual(
      HETZNER_CHECKS.map((c) => c.check),
    );
  });
});
