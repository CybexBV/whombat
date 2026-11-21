/**
 * Optional idle paid cloud server check on Hetzner (`hetzner.idle`, starts off).
 */
import { ThingPageNotice } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { RawPoint } from '../series';
import {
  activityPoints,
  HETZNER_CHECKS,
  type HetznerServer,
  type HetznerServerActivity,
  type HetznerSnapshot,
  hetznerNotices,
  hetznerSkipped,
  isIdlePaidServer,
} from './hetzner';

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
    expect(
      isIdlePaidServer(
        s,
        activityOf(s.id, { cpu: (i) => (i % 10 === 0 ? 12 : 0.1) }),
        NOW,
      ),
    ).toBe(false);
    // Active network
    expect(isIdlePaidServer(s, activityOf(s.id, { netIn: 400, netOut: 300 }), NOW)).toBe(false);
    // Created 5 days ago
    expect(isIdlePaidServer(server({ createdAt: new Date(NOW.getTime() - 5 * DAY) }), activityOf(s.id), NOW)).toBe(
      false,
    );
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
});
