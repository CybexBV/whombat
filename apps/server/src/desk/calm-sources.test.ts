/**
 * The calm glance's sources (desk-display-server.md DK-S140…DK-S147) without Postgres: what each makes of the hosts
 * service's answers, the update facts' states, and that a slow read never holds the glance up.
 */
import { describe, expect, it } from 'vitest';
import type { HostsService } from '../hosts/service';
import type { Services } from '../services';
import {
  ACTIVITY_FRESH_MS,
  activityOf,
  createDeskCalmSources,
  DISK_KEEP_MS,
  diskDaysOf,
  KeptReads,
  pointsOf,
  runningNames,
  SPARK_KEEP_MS,
  sparkOf,
  updateStateOf,
} from './calm-sources';

const NOW = new Date('2026-10-27T12:00:00Z');

function clock(start = NOW) {
  let at = start.getTime();
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** A promise and its resolve, to answer a read when the test says. */
function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('KeptReads', () => {
  it('answers a fresh read from what it kept, and reads again once it is old', async () => {
    const c = clock();
    const kept = new KeptReads(c.now, 1_000);
    let reads = 0;
    const load = async () => ++reads;
    expect(await kept.get('k', 60_000, load, 0)).toBe(1);
    expect(await kept.get('k', 60_000, load, 0)).toBe(1);
    c.advance(60_000);
    expect(await kept.get('k', 60_000, load, 0)).toBe(2);
  });

  it('goes on with what it had when a read is slow, and keeps the answer for the next one', async () => {
    const c = clock();
    const kept = new KeptReads(c.now, 5);
    const slow = later<string>();
    let reads = 0;
    const load = () => {
      reads++;
      return slow.promise;
    };
    expect(await kept.get('k', 60_000, load, 'none')).toBe('none');
    // The same read is still going: no second one.
    expect(await kept.get('k', 60_000, load, 'none')).toBe('none');
    expect(reads).toBe(1);
    slow.resolve('answer');
    await slow.promise;
    expect(await kept.get('k', 60_000, load, 'none')).toBe('answer');
  });

  it('keeps what it had when a read fails, and tries again within a minute', async () => {
    const c = clock();
    const kept = new KeptReads(c.now, 1_000);
    expect(await kept.get('k', DISK_KEEP_MS, async () => 7, 0)).toBe(7);
    c.advance(DISK_KEEP_MS);
    let tried = 0;
    const failing = async () => {
      tried++;
      throw new Error('down');
    };
    expect(await kept.get('k', DISK_KEEP_MS, failing, 0)).toBe(7);
    c.advance(30_000);
    expect(await kept.get('k', DISK_KEEP_MS, failing, 0)).toBe(7);
    expect(tried).toBe(1);
    c.advance(30_000);
    await kept.get('k', DISK_KEEP_MS, failing, 0);
    expect(tried).toBe(2);
  });
});

describe('updateStateOf', () => {
  it('says what the manager does now with a release', () => {
    expect(updateStateOf({ state: 'Downloading' })).toBe('downloading');
    expect(updateStateOf({ state: 'Assigned' })).toBe('downloading');
    expect(updateStateOf({ state: 'Activating' })).toBe('installing');
    expect(updateStateOf({ state: 'Verifying' })).toBe('restarting');
  });

  it('says nothing while one waits, after it, or without facts', () => {
    for (const state of ['Staged', 'WaitingForSafeBoundary', 'Healthy', 'Failed', 'RolledBack'] as const)
      expect(updateStateOf({ state })).toBeNull();
    expect(updateStateOf(null)).toBeNull();
    expect(updateStateOf(undefined)).toBeNull();
  });
});

describe('sparkOf', () => {
  it('draws the hour in at most 30 whole percents, oldest first, gaps left out', () => {
    const cpu = Array.from({ length: 60 }, (_, i) => (i < 4 ? null : i + 0.4));
    const spark = sparkOf(cpu);
    expect(spark).toHaveLength(28);
    expect(spark.every(Number.isInteger)).toBe(true);
    expect(spark[spark.length - 1]).toBe(59);
    expect(sparkOf([null, null])).toEqual([]);
    expect(sparkOf([140, -3])).toEqual([100, 0]);
  });
});

describe('diskDaysOf', () => {
  const week = (from: number, perDay: number) =>
    pointsOf(
      Array.from({ length: 85 }, (_, i) => from + (perDay * i) / 12),
      [],
      NOW.toISOString(),
      7_200,
    );

  it('counts the days to full at the week’s rate', () => {
    const days = diskDaysOf(week(80, 1), null, NOW);
    expect(days).not.toBeNull();
    expect(Math.round(days as number)).toBe(13);
  });

  it('is null for a disk that isn’t filling, whatever the hub says', () => {
    expect(diskDaysOf(week(88, 0), 3, NOW)).toBeNull();
    expect(diskDaysOf(week(88, -1), null, NOW)).toBeNull();
  });

  it('takes the hub’s forecast with less than two days of history', () => {
    const short = pointsOf([80, 81, 82], [], NOW.toISOString(), 7_200);
    expect(diskDaysOf(short, 9, NOW)).toBe(9);
    expect(diskDaysOf(short, null, NOW)).toBeNull();
    expect(diskDaysOf(short, 900, NOW)).toBeNull();
  });

  it('places points by their timestamps when the service gives them', () => {
    const points = pointsOf([1, 2], ['2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z'], NOW.toISOString(), 60);
    expect(points.map((p) => p.at.toISOString())).toEqual([
      '2026-10-20T00:00:00.000Z',
      '2026-10-27T00:00:00.000Z',
    ]);
  });
});

describe('runningNames', () => {
  it('names the running guests by name, an unhealthy container too', () => {
    expect(
      runningNames([
        { id: 'qemu:101', name: 'Plex', state: 'running' },
        { id: 'docker:ha', name: 'Home Assistant', state: 'unhealthy' },
        { id: 'qemu:102', name: 'Old', state: 'stopped' },
        { id: 'lxc:103', name: '', state: 'running' },
      ]),
    ).toEqual(['Home Assistant', 'lxc:103', 'Plex']);
  });
});

describe('activityOf', () => {
  const row = {
    id: 'con_plex',
    catalogId: 'plex',
    label: 'Plex',
    glance: {
      status: 'ok' as const,
      facts: [],
      activity: { active: true, value: '2 watching', detail: 'Dune' },
    },
    glanceAt: new Date(NOW.getTime() - 60_000),
  };

  it('keys it as Home’s thing, with the kind’s mark', () => {
    expect(activityOf(row, NOW)).toEqual({
      key: 'connection:con_plex',
      name: 'Plex',
      mark: 'plex',
      value: '2 watching',
      detail: 'Dune',
      active: true,
    });
  });

  it('says nothing from an old glance or one without an activity', () => {
    expect(activityOf({ ...row, glanceAt: new Date(NOW.getTime() - ACTIVITY_FRESH_MS - 1) }, NOW)).toBeNull();
    expect(activityOf({ ...row, glance: { status: 'ok', facts: [] } }, NOW)).toBeNull();
  });
});

/** A hosts service answering from the test's maps. */
function fakeHosts(answers: {
  metrics?: (id: string, query: Record<string, unknown>) => unknown;
  detail?: (id: string) => unknown;
  guests?: (id: string) => unknown[] | Promise<unknown[]>;
  serves?: boolean;
}) {
  const calls: string[] = [];
  const hosts: Pick<HostsService, 'serves' | 'call' | 'guestsRaw'> = {
    serves: async () => answers.serves ?? true,
    call: (async (req: { path: string; query?: Record<string, unknown> }) => {
      calls.push(req.path);
      const m = /\/servers\/([^/]+)(\/metrics)?$/.exec(req.path);
      if (!m) throw new Error(`unexpected ${req.path}`);
      const id = decodeURIComponent(m[1] as string);
      return m[2] ? answers.metrics?.(id, req.query ?? {}) : answers.detail?.(id);
    }) as HostsService['call'],
    guestsRaw: async (id: string) => {
      calls.push(`guests:${id}`);
      return answers.guests?.(id) ?? [];
    },
  };
  return { hosts, calls };
}

function sourcesWith(hosts: Pick<HostsService, 'serves' | 'call' | 'guestsRaw'>, more = {}) {
  const c = clock();
  const services = { clock: c.now } as unknown as Services;
  return { sources: createDeskCalmSources(services, { hosts, waitMs: 20, ...more }), clock: c };
}

describe('createDeskCalmSources over the hosts service', () => {
  it('draws each server’s last hour, reading each at most once a minute', async () => {
    const { hosts, calls } = fakeHosts({
      metrics: (id, q) => ({
        server: id,
        range: q.range,
        step_seconds: 60,
        series: { cpu_pct: Array.from({ length: 60 }, () => (id === 'pve-01' ? 12.4 : 50)) },
      }),
    });
    const { sources, clock: c } = sourcesWith(hosts);
    const sparks = await sources.sparks('brw_home', ['pve-01', 'nas'], NOW);
    expect(sparks.get('pve-01')).toHaveLength(30);
    expect(sparks.get('pve-01')?.[0]).toBe(12);
    expect(sparks.get('nas')?.[0]).toBe(50);
    await sources.sparks('brw_home', ['pve-01', 'nas'], NOW);
    expect(calls).toHaveLength(2);
    c.advance(SPARK_KEEP_MS);
    await sources.sparks('brw_home', ['pve-01'], NOW);
    expect(calls).toHaveLength(3);
  });

  it('doesn’t wait for a slow server: its line comes on the next glance', async () => {
    const slow = later<unknown>();
    const { hosts } = fakeHosts({ metrics: () => slow.promise });
    const { sources } = sourcesWith(hosts);
    expect((await sources.sparks('brw_home', ['pve-01'], NOW)).size).toBe(0);
    slow.resolve({ step_seconds: 60, series: { cpu_pct: [10, 20] } });
    await slow.promise;
    expect((await sources.sparks('brw_home', ['pve-01'], NOW)).get('pve-01')).toEqual([10, 20]);
  });

  it('reads nothing for a burrow the hosts service doesn’t serve', async () => {
    const { hosts, calls } = fakeHosts({ serves: false });
    const { sources } = sourcesWith(hosts);
    expect((await sources.sparks('brw_other', ['pve-01'], NOW)).size).toBe(0);
    expect(await sources.diskDays('brw_other', 'pve-01', NOW)).toBeNull();
    expect(await sources.runsOn('brw_other', 'pve-01')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('forecasts the fullest volume from its week', async () => {
    const asked: Record<string, unknown>[] = [];
    const { hosts } = fakeHosts({
      detail: (id) => ({
        server: { id },
        volumes: [
          {
            entity: 'fs:/',
            kind: 'fs',
            label: '/',
            used_gb: 40,
            total_gb: 100,
            used_pct: 40,
            full_in_days: null,
          },
          { entity: 'fs:/data', kind: 'fs', label: '/data', used_gb: 88, total_gb: 100, used_pct: 88 },
          {
            entity: 'nfs:/x',
            kind: 'fs',
            label: '/x',
            used_gb: 99,
            total_gb: 100,
            used_pct: 99,
            remote: true,
          },
        ],
      }),
      metrics: (_id, q) => {
        asked.push(q);
        return {
          range: '7d',
          step_seconds: 7_200,
          as_of: NOW.toISOString(),
          series: { 'vol_pct:fs:/data': Array.from({ length: 85 }, (_, i) => 81 + i / 12) },
        };
      },
    });
    const { sources } = sourcesWith(hosts);
    const days = await sources.diskDays('brw_home', 'pve-01', NOW);
    expect(Math.round(days as number)).toBe(12);
    expect(asked[0]).toMatchObject({ range: '7d', series: 'vol_pct:fs:/data' });
  });

  it('names a down server’s running guests', async () => {
    const { hosts } = fakeHosts({
      guests: () => [
        { id: 'qemu:101', name: 'Plex', state: 'running', platform: 'qemu' },
        { id: 'qemu:102', name: 'Backup', state: 'stopped', platform: 'qemu' },
      ],
    });
    const { sources } = sourcesWith(hosts);
    expect(await sources.runsOn('brw_home', 'pve-02')).toEqual(['Plex']);
  });

  it('says what the manager does now, and nothing without one', async () => {
    const { hosts } = fakeHosts({});
    let state: 'Activating' | 'Healthy' = 'Activating';
    const { sources } = sourcesWith(hosts, { updateFacts: () => ({ state }) });
    expect(await sources.update()).toBe('installing');
    state = 'Healthy';
    expect(await sources.update()).toBeNull();
    expect(await sourcesWith(hosts).sources.update()).toBeNull();
  });

  it('names each kind’s activity for Settings', () => {
    const { sources } = sourcesWith(fakeHosts({}).hosts);
    expect(sources.activityLine('plex')).toBe('Who’s watching');
    expect(sources.activityLine('homeassistant')).toBeNull();
    expect(sources.activityLine('no-such-kind')).toBeNull();
  });
});
