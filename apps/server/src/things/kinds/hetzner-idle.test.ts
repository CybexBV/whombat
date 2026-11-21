/**
 * Optional idle paid cloud server check on Hetzner (`hetzner.idle`, starts off).
 */
import { ThingPageNotice } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../services';
import type { ThingQuiet } from '../quiet/store';
import type { RawPoint } from '../series';
import {
  activityPoints,
  HETZNER_CHECKS,
  type HetznerServer,
  type HetznerServerActivity,
  type HetznerSnapshot,
  hetznerNotices,
  hetznerPage,
  hetznerSeen,
  hetznerSkipped,
  IDLE_BATCH_CONCURRENCY,
  idleEligibleServers,
  isIdlePaidServer,
  METRICS_SERVERS,
} from './hetzner';
import { rowOf } from './media/testing';
import type { KindCtx } from './types';

const hz = vi.hoisted(() => ({
  servers: [] as Record<string, unknown>[],
  metricsCalls: [] as string[],
  busyIds: new Set<string>(),
  delayMs: 0,
  inFlight: 0,
  maxInFlight: 0,
}));

vi.mock('../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (_s: unknown, _r: unknown, req: { url: string }) => {
      const parsed = new URL(req.url);
      const path = parsed.pathname;
      if (path === '/v1/servers') {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify({ servers: hz.servers, meta: { pagination: { total_entries: hz.servers.length } } }),
          ),
        };
      }
      if (path === '/v1/volumes') {
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ volumes: [] })) };
      }
      if (path === '/v1/images') {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ images: [], meta: { pagination: { total_entries: 0 } } })),
        };
      }
      const match = path.match(/^\/v1\/servers\/([^/]+)\/metrics$/);
      if (match) {
        const id = match[1] as string;
        const isActivity = parsed.searchParams.get('type') === 'cpu,network';
        if (isActivity) {
          hz.metricsCalls.push(id);
          hz.inFlight += 1;
          hz.maxInFlight = Math.max(hz.maxInFlight, hz.inFlight);
          if (hz.delayMs > 0) await new Promise((r) => setTimeout(r, hz.delayMs));
          hz.inFlight -= 1;
        }
        const tsStart = Math.floor((NOW.getTime() - 14 * 24 * 3600_000) / 1000);
        const busy = hz.busyIds.has(id);
        const cpuVal = busy ? '40.0' : '0.1';
        const netVal = busy ? '5000' : '0.1';
        const cpuVals = Array.from({ length: 14 * 24 }, (_, i) => [tsStart + i * 3600, cpuVal]);
        const netVals = Array.from({ length: 14 * 24 }, (_, i) => [tsStart + i * 3600, netVal]);
        return {
          status: 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify({
              metrics: {
                time_series: {
                  cpu: { values: cpuVals },
                  'network.0.bandwidth.in': { values: netVals },
                  'network.0.bandwidth.out': { values: netVals },
                },
              },
            }),
          ),
        };
      }
      return { status: 404, headers: {}, body: Buffer.from('{}') };
    },
  };
});

const NOW = new Date('2026-10-21T12:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function server(over: Partial<HetznerServer> = {}): HetznerServer {
  return {
    id: '42',
    name: 'staging-1',
    status: 'running',
    type: 'cx22',
    cores: 2,
    memoryGb: 4,
    diskGb: 40,
    location: 'fsn1',
    city: 'Falkenstein',
    ipv4: '203.0.113.12',
    ipv6: null,
    os: 'Debian 13',
    monthlyEur: 4.51,
    backups: true,
    deleteProtection: true,
    outgoingBytes: 0,
    includedBytes: 20e12,
    createdAt: new Date(NOW.getTime() - 45 * DAY),
    ...over,
  };
}

function series(hours: number, value: number | ((i: number) => number)): RawPoint[] {
  return Array.from({ length: hours }, (_, i) => ({
    at: new Date(NOW.getTime() - (hours - 1 - i) * HOUR),
    value: typeof value === 'function' ? value(i) : value,
  }));
}

function activityOf(
  serverId: string,
  opts: { hours?: number; cpu?: number | ((i: number) => number); netIn?: number; netOut?: number } = {},
): HetznerServerActivity {
  const hours = opts.hours ?? 14 * 24;
  return {
    serverId,
    cpu: series(hours, opts.cpu ?? 0.2),
    netIn: series(hours, opts.netIn ?? 20),
    netOut: series(hours, opts.netOut ?? 15),
  };
}

describe('Hetzner idle paid server check', () => {
  it('starts off by default and parses CPU + network activity from Hetzner metrics', () => {
    expect(HETZNER_CHECKS.find((c) => c.check === 'hetzner.idle')).toMatchObject({
      nature: 'you',
      perItem: true,
      startsOn: false,
    });
    const parsed = activityPoints(
      {
        metrics: {
          time_series: {
            // 2 vCPUs: 4.0% raw = 2.0% overall
            cpu: { values: [[1_700_000_000, '4.0']] },
            'network.0.bandwidth.in': { values: [[1_700_000_000, '30']] },
            'network.0.bandwidth.out': { values: [[1_700_000_000, '10']] },
          },
        },
      },
      { id: '42', cores: 2 },
    );
    expect(parsed.cpu[0]?.value).toBe(2);
    expect(parsed.netIn[0]?.value).toBe(30);
    expect(parsed.netOut[0]?.value).toBe(10);
  });

  it('flags a running paid server with near-zero CPU and network over 14 days and states monthly cost', () => {
    const s = server();
    const act = new Map([[s.id, activityOf(s.id)]]);
    expect(isIdlePaidServer(s, act.get(s.id), NOW)).toBe(true);

    const snap: HetznerSnapshot = { readAt: NOW, servers: [s], volumes: null };
    const notices = hetznerNotices(snap, NOW, act);
    expect(notices).toHaveLength(1);
    ThingPageNotice.parse(notices[0]);
    expect(notices[0]).toMatchObject({
      tone: 'info',
      icon: 'money',
      nature: 'you',
      check: 'hetzner.idle',
      subject: { id: 'server:42', name: 'staging-1' },
      ignore: { lifts: 'fixed' },
      link: { kind: 'url', url: 'https://console.hetzner.cloud/' },
    });
    expect(notices[0]?.title).toContain('staging-1');
    expect(notices[0]?.detail).toContain('€ 4.51');
  });

  it('does not flag busy, batch-bursty, newly created, stopped, or short-history servers', () => {
    const s = server();
    // Active CPU
    expect(isIdlePaidServer(s, activityOf(s.id, { cpu: 2.5 }), NOW)).toBe(false);
    // Periodic batch job: mostly idle, but 10% of hours spike to 12% CPU (p95 >= 5%)
    expect(isIdlePaidServer(s, activityOf(s.id, { cpu: (i) => (i % 10 === 0 ? 12 : 0.1) }), NOW)).toBe(false);
    // Active network
    expect(isIdlePaidServer(s, activityOf(s.id, { netIn: 400, netOut: 300 }), NOW)).toBe(false);
    // Created 5 days ago
    expect(
      isIdlePaidServer(server({ createdAt: new Date(NOW.getTime() - 5 * DAY) }), activityOf(s.id), NOW),
    ).toBe(false);
    // Stopped server (already covered by hetzner.not_running)
    expect(isIdlePaidServer(server({ status: 'off' }), activityOf(s.id), NOW)).toBe(false);
    // Free / unknown cost
    expect(isIdlePaidServer(server({ monthlyEur: null }), activityOf(s.id), NOW)).toBe(false);
    // Too little metric history (only 7 days)
    expect(isIdlePaidServer(s, activityOf(s.id, { hours: 7 * 24 }), NOW)).toBe(false);
  });

  it('marks hetzner.idle skipped when activity could not be read for an eligible running paid server', () => {
    const s1 = server({ id: '42', name: 'staging-1' });
    const s2 = server({ id: '43', name: 'staging-2' });
    const snap: HetznerSnapshot = { readAt: NOW, servers: [s1, s2], volumes: null };
    expect(hetznerSkipped(snap, new Map([[s1.id, activityOf(s1.id)]]))).toEqual(['hetzner.idle']);
    expect(
      hetznerSkipped(
        snap,
        new Map([
          [s1.id, activityOf(s1.id)],
          [s2.id, activityOf(s2.id)],
        ]),
      ),
    ).toEqual([]);
  });

  it('skips 14-day activity fetches in hetznerSeen while hetzner.idle is off, and fetches when on', async () => {
    const created = new Date(NOW.getTime() - 45 * DAY).toISOString();
    hz.servers = [
      {
        id: 101,
        name: 'staging-1',
        status: 'running',
        created,
        server_type: {
          name: 'cx22',
          cores: 2,
          memory: 4,
          disk: 40,
          prices: [{ location: 'fsn1', price_monthly: { gross: '4.51' } }],
        },
        datacenter: { location: { name: 'fsn1', city: 'Falkenstein' } },
        public_net: { ipv4: { ip: '203.0.113.12' }, ipv6: null },
        backup_window: '22-02',
        protection: { delete: true },
        outgoing_traffic: 0,
        included_traffic: 20e12,
      },
    ];
    const rowOff = rowOf('hetzner', { id: 'con_hz_off', baseUrl: 'https://api.hetzner.cloud' });
    const quietOff: ThingQuiet = { quiets: [], offs: [], ons: [] };
    hz.metricsCalls = [];
    const seenOff = await hetznerSeen({} as Services, rowOff, NOW, quietOff);
    expect(hz.metricsCalls).toEqual([]);
    expect(seenOff.notices?.some((n) => n.check === 'hetzner.idle')).toBe(false);

    const rowOn = rowOf('hetzner', { id: 'con_hz_on', baseUrl: 'https://api.hetzner.cloud' });
    const quietOn: ThingQuiet = { quiets: [], offs: [], ons: [{ checkId: 'hetzner.idle', at: NOW }] };
    hz.metricsCalls = [];
    const seenOn = await hetznerSeen({} as Services, rowOn, NOW, quietOn);
    expect(hz.metricsCalls).toEqual(['101']);
    expect(seenOn.notices?.some((n) => n.check === 'hetzner.idle')).toBe(true);
  });

  it('checks every eligible paid server beyond the six-server chart cap in bounded batches', async () => {
    const oldCreated = new Date(NOW.getTime() - 45 * DAY).toISOString();
    const youngCreated = new Date(NOW.getTime() - 3 * DAY).toISOString();
    const makeRaw = (id: number, over: { name?: string; status?: string; created?: string } = {}) => ({
      id,
      name: over.name ?? `srv-${id}`,
      status: over.status ?? 'running',
      created: over.created ?? oldCreated,
      server_type: {
        name: 'cx22',
        cores: 2,
        memory: 4,
        disk: 40,
        prices: [{ location: 'fsn1', price_monthly: { gross: '4.51' } }],
      },
      datacenter: { location: { name: 'fsn1', city: 'Falkenstein' } },
      public_net: { ipv4: { ip: `203.0.113.${id}` }, ipv6: null },
      backup_window: '22-02',
      protection: { delete: true },
      outgoing_traffic: 0,
      included_traffic: 20e12,
    });
    // 10 eligible paid servers (> METRICS_SERVERS=6), plus 1 young and 1 stopped server that are ineligible.
    hz.servers = [
      ...Array.from({ length: 10 }, (_, i) => makeRaw(i + 1)),
      makeRaw(11, { name: 'brand-new', created: youngCreated }),
      makeRaw(12, { name: 'stopped-box', status: 'off' }),
    ];
    // Servers 1..8 and 10 are busy; server 9 (outside the 6-server chart list) is idle.
    hz.busyIds = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '10']);
    hz.metricsCalls = [];
    hz.delayMs = 15;
    hz.inFlight = 0;
    hz.maxInFlight = 0;

    const quietOn: ThingQuiet = { quiets: [], offs: [], ons: [{ checkId: 'hetzner.idle', at: NOW }] };
    const rowSeen = rowOf('hetzner', { id: 'con_hz_many_seen', baseUrl: 'https://api.hetzner.cloud' });
    const seen = await hetznerSeen({} as Services, rowSeen, NOW, quietOn);

    expect(hz.metricsCalls.length).toBe(10);
    expect(hz.metricsCalls.length).toBeGreaterThan(METRICS_SERVERS);
    expect(hz.metricsCalls).not.toContain('11');
    expect(hz.metricsCalls).not.toContain('12');
    expect(hz.maxInFlight).toBeLessThanOrEqual(IDLE_BATCH_CONCURRENCY);
    const idleNotices = seen.notices?.filter((n) => n.check === 'hetzner.idle') ?? [];
    expect(idleNotices.map((n) => n.subject?.id)).toEqual(['server:9']);
    expect(seen.skipped).toEqual([]);

    // The page also flags server 9 while keeping its weekly traffic trend scoped to the 6 chart servers.
    hz.metricsCalls = [];
    hz.delayMs = 0;
    const rowPage = rowOf('hetzner', { id: 'con_hz_many_page', baseUrl: 'https://api.hetzner.cloud' });
    const ctx: KindCtx = {
      services: { db: null } as unknown as Services,
      row: rowPage,
      entry: {} as KindCtx['entry'],
      now: NOW,
      timeZone: 'UTC',
      machine: null,
      range: '24h',
      burrowId: 'brw_1',
      disk: { pct: [], gb: [] },
      quiet: quietOn,
    };
    const view = await hetznerPage(ctx);
    expect(view.notices.filter((n) => n.check === 'hetzner.idle').map((n) => n.subject?.id)).toEqual([
      'server:9',
    ]);
    expect(hz.metricsCalls).toContain('9');
    expect(idleEligibleServers({ readAt: NOW, servers: [server({ id: 'a' }), server({ id: 'b', status: 'off' })], volumes: null }, NOW).map((x) => x.id)).toEqual(['a']);
    hz.busyIds = new Set();
  });
});
