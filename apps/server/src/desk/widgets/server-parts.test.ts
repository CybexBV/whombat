import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DeskWidgetSpec, DeskWidgetView, type HostServer } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { guestsOfDetail, toHostFleet, toHostSeries, toHostServerDetail } from '../../hosts/map';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { deskFleetOf } from '../glance';
import type { ServerParts } from '../server-page';
import type { DeskServer } from '../shapes';
import { WidgetResolver } from './resolve';
import { type ServerPart, serverPartOf, serverPartRange, serverPartView } from './server-parts';

/* The hosts service's own answers (the hand-off sample data), through Whombat's mappers, as the server page's test. */
const FIXTURES = join(import.meta.dirname, '../../hosts/testing/fixtures');
const raw = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
const now = new Date('2026-10-11T14:00:00Z');
const fleet = toHostFleet({ fleet: raw('fleet.json') }, now);
const cards = deskFleetOf(fleet.servers);
const rowOf = (id: string) => fleet.servers.find((s) => s.id === id) as HostServer;
const cardOf = (id: string) => cards.cards.find((c) => c.id === id) as DeskServer;

function parts(id: string, detailRaw: unknown): ServerParts {
  const detail = toHostServerDetail(detailRaw, fleet.alerts, null, now);
  return {
    detail,
    series: toHostSeries({ ...raw('timeseries-basalt-24h.json'), server: id }, id, null, now),
    guests: guestsOfDetail(detail),
    alerts: fleet.alerts,
  };
}

const shale = parts('shale', raw('server-shale-proxmox.json'));

function view(show: ServerPart, over: Partial<Parameters<typeof serverPartView>[0]> = {}) {
  const r = serverPartView({
    id: `w_${show}`,
    show,
    serverId: 'shale',
    card: cardOf('shale'),
    row: rowOf('shale'),
    parts: shale,
    range: '24h',
    now,
    timeZone: 'Europe/Amsterdam',
    ...over,
  });
  // Every part is a view every screen takes.
  if (r) expect(DeskWidgetView.safeParse(r.view).success).toBe(true);
  return r;
}

describe('a server’s parts as widgets (DK-153)', () => {
  it('reads the overview unless a part is chosen, a chart over its own range and the rest over the shortest', () => {
    expect(serverPartOf({})).toBeNull();
    expect(serverPartOf({ show: 'nonsense' })).toBeNull();
    expect(serverPartOf({ show: 'storage' })).toBe('storage');
    expect(serverPartRange('cpu', { range: '7d' })).toBe('7d');
    expect(serverPartRange('cpu', {})).toBe('24h');
    expect(serverPartRange('storage', { range: '7d' })).toBe('1h');
  });

  it('draws its processor and memory as charts with their figures now', () => {
    const cpu = view('cpu')?.view;
    expect(cpu).toMatchObject({
      kind: 'chart',
      title: 'Processor',
      name: 'shale',
      mark: 'proxmox',
      figure: { value: '71 %', rest: 'of 16 cores · load 19.8' },
    });
    if (cpu?.kind !== 'chart') throw new Error('a chart');
    expect(cpu.series[0]?.points.length).toBeGreaterThan(1);
    expect(cpu.stats?.[0]).toMatch(/^Last 24 hours · Avg \d+/);
    const memory = view('memory')?.view;
    expect(memory).toMatchObject({
      kind: 'chart',
      title: 'Memory',
      figure: { value: '83 %', rest: '159 GB of 192 GB', tone: 'warn' },
    });
  });

  it('draws its network in and out, and says when it doesn’t report it', () => {
    expect(view('network')?.view).toMatchObject({
      kind: 'text',
      body: 'It doesn’t say what goes in and out.',
    });
    const series = raw('timeseries-basalt-24h.json') as { series: Record<string, number[]>; points: number };
    const flow = (n: number) => Array.from({ length: series.points }, (_, i) => n + (i % 7));
    const withNet = toHostSeries(
      {
        ...series,
        server: 'shale',
        series: { ...series.series, net_rx_mbps: flow(80), net_tx_mbps: flow(9) },
      },
      'shale',
      null,
      now,
    );
    const network = view('network', { parts: { ...shale, series: withNet } })?.view;
    if (network?.kind !== 'chart') throw new Error('a chart');
    expect(network.series.map((s) => s.label)).toEqual(['In', 'Out']);
    expect(network.figure?.value).toMatch(/^↓ /);
    expect(network.figure?.rest).toMatch(/^↑ /);
  });

  it('lists its storage fullest first and its guests running first', () => {
    const storage = view('storage')?.view;
    if (storage?.kind !== 'list') throw new Error('a list');
    expect(storage.head).toBe('12.5 of 24 TB used');
    expect(storage.rows.map((r) => [r.title, r.meta, r.progress])).toEqual([
      ['vmdata', '83 %', 83],
      ['pbs-01', '70 %', 70],
      ['local', '44 %', 44],
      ['bulk', '40 %', 40],
      ['local-zfs', '8 %', 8],
    ]);
    const guests = view('guests')?.view;
    if (guests?.kind !== 'list') throw new Error('a list');
    expect(guests.head).toBe('11 running · 1 off');
    expect(guests.rows[0]).toMatchObject({ title: 'k3s-node-2', state: 'on', meta: '44 %', tone: 'ok' });
    expect(guests.count).toBe(12);
  });

  it('shows its hottest sensors, and its alerts as private words', () => {
    const temp = view('temp')?.view;
    if (temp?.kind !== 'figures') throw new Error('figures');
    expect(temp.items.length).toBeGreaterThanOrEqual(1);
    expect(temp.items[0]?.unit).toBe('°C');
    // The hottest first, with how close it is to too hot.
    expect(temp.line).toMatch(/ · hot from 85 °C$/);
    expect(temp.progress).toBe(Math.round((Number(temp.items[0]?.value) / 85) * 100));
    const alerts = view('alerts');
    expect(alerts?.private).toBe(true);
    expect(alerts?.view).toMatchObject({
      kind: 'list',
      rows: [{ title: 'CPU package at 83 °C', tone: 'warn' }],
    });
  });

  it('says so when the server is off, gone, or not read yet', () => {
    expect(view('cpu', { card: { ...cardOf('shale'), state: 'off' } })?.view).toMatchObject({
      kind: 'text',
      tone: 'off',
      body: 'It’s switched off.',
    });
    expect(view('storage', { card: undefined })?.view).toMatchObject({
      kind: 'text',
      title: 'Storage',
      body: 'shale isn’t one of your servers any more.',
    });
    expect(view('storage', { parts: null })).toBeNull();
    expect(view('storage', { parts: null, failed: true })?.view).toMatchObject({
      kind: 'text',
      body: 'I can’t read shale right now.',
    });
  });

  it('says what a server doesn’t report', () => {
    const bare = parts('granite', {
      as_of: '2026-10-11T14:00:00Z',
      server: { id: 'granite', status: 'online', os: null, uptime_s: 3600 },
      sensors: [],
      disks: [],
      workloads: {},
    });
    const none = { serverId: 'granite', card: cardOf('granite'), row: rowOf('granite'), parts: bare };
    expect(view('guests', { ...none, parts: { ...bare, guests: [] } })?.view).toMatchObject({
      kind: 'text',
      body: 'Nothing runs on it.',
    });
  });
});

describe('resolving a server’s parts', () => {
  it('reads a server once per range for all its parts, its overview as before', async () => {
    const reads: string[] = [];
    const services = { clock: () => now } as unknown as Services;
    const r = new WidgetResolver(
      services,
      () => ({ groups: async () => [], resolve: async () => new Map() }),
      {
        fleet: async () => ({ cards: [cardOf('shale')], rows: new Map([['shale', rowOf('shale')]]) }),
        line: async () => ({ spark: [1, 2], avg: 1, peak: null }),
        parts: async (id, range) => {
          reads.push(`${id} ${range}`);
          return shale;
        },
      },
    );
    const ctx = {
      services,
      viewer: {
        accountId: 'acc_1',
        burrowId: 'brw_1',
        principal: { id: 'prn_1', burrowId: 'brw_1' } as PrincipalRow,
      },
      now,
      timeZone: 'Europe/Amsterdam',
      assistant: 'Dusty',
    };
    const specs: DeskWidgetSpec[] = [
      { id: 'w_over', type: 'server' as const, ref: 'server:shale', opts: {} },
      { id: 'w_disk', type: 'server' as const, ref: 'server:shale', opts: { show: 'storage' } },
      { id: 'w_vms', type: 'server' as const, ref: 'server:shale', opts: { show: 'guests' } },
      { id: 'w_cpu', type: 'server' as const, ref: 'server:shale', opts: { show: 'cpu', range: '7d' } },
    ];
    const out = await r.resolve(ctx, specs, null, 1_000);
    expect(reads.sort()).toEqual(['shale 1h', 'shale 7d']);
    expect(out.get('w_over')?.view.kind).toBe('server');
    expect(out.get('w_disk')?.view).toMatchObject({ kind: 'list', title: 'Storage' });
    expect(out.get('w_vms')?.view).toMatchObject({ kind: 'list', title: 'VMs and containers' });
    expect(out.get('w_cpu')?.view).toMatchObject({ kind: 'chart', title: 'Processor' });
  });
});
