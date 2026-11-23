/** Unraid's page from its GraphQL API, when Whombat doesn't watch the server, and its health pass either way. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { slotProblems } from '../slots';
import { NAS_USED_KEY } from '../storage/nas';
import { checked, fakeServices, panel } from '../storage/test-helpers';
import { UNRAID_ARRAY, UNRAID_FORBIDDEN, UNRAID_GUESTS, UNRAID_MORE } from './fixtures/unraid';
import {
  ARRAY_QUERY,
  diskProblem,
  parseArray,
  parseGuests,
  parseMore,
  UNRAID_CHECKS,
  UNRAID_KIND,
  type UnraidSnapshot,
  unraidHostnameOf,
  unraidNotices,
  unraidView,
} from './unraid';

const http = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock('../../../connections/http', async (orig) => ({
  ...(await orig<typeof import('../../../connections/http')>()),
  signedConnectionFetch: async (_s: unknown, _r: unknown, req: { body: string }) => {
    http.queries.push(JSON.parse(req.body).query);
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(UNRAID_ARRAY)) };
  },
}));
const watched = vi.hoisted(() => ({ server: null as string | null }));
vi.mock('./watched', async (orig) => ({
  ...(await orig<typeof import('./watched')>()),
  watchedServerId: async () => watched.server,
}));

const now = new Date('2026-11-23T12:00:00Z');
const TZ = 'Europe/Amsterdam';
const url = 'http://tower.home.example';
const snap = (more: Partial<UnraidSnapshot> = {}): UnraidSnapshot => ({
  readAt: now,
  array: parseArray(UNRAID_ARRAY.data, now),
  guests: parseGuests(UNRAID_GUESTS.data),
  more: parseMore(UNRAID_MORE.data),
  ...more,
});

afterEach(() => {
  http.queries = [];
  watched.server = null;
});

describe('Unraid’s own name (SB-09)', () => {
  it('reads the hostname from the answer, else nothing', () => {
    expect(unraidHostnameOf({ data: { info: { os: { hostname: 'BlackBox' } } } })).toBe('BlackBox');
    expect(unraidHostnameOf({ data: { info: { os: { hostname: '  ' } } } })).toBeNull();
    expect(unraidHostnameOf({ errors: [{ message: 'Forbidden resource' }] })).toBeNull();
    expect(unraidHostnameOf(null)).toBeNull();
  });
});

describe('reading Unraid', () => {
  it('reads the array in kilobytes, its disks, pools and when it started', () => {
    const a = parseArray(UNRAID_ARRAY.data, now);
    expect(a).toMatchObject({ state: 'STARTED', hostname: 'Tower', usedBytes: 4882812500 * 1024 });
    expect(a.disks.map((d) => [d.name, d.status])).toEqual([
      ['disk1', 'DISK_OK'],
      ['disk2', 'DISK_OK'],
      ['disk3', 'DISK_NP'],
    ]);
    expect(a.pools.map((p) => p.name)).toEqual(['cache']);
    expect(a.upSince?.toISOString()).toBe('2026-11-11T08:00:00.000Z');
  });

  it('reads containers and VMs, an unhealthy container and Docker’s words', () => {
    expect(parseGuests(UNRAID_GUESTS.data).map((g) => [g.name, g.kind, g.state, g.detail ?? null])).toEqual([
      ['plex', 'container', 'running', 'Up 12 days'],
      ['nextcloud', 'container', 'unhealthy', 'Up 3 hours'],
      ['old-sonarr', 'container', 'stopped', null],
      ['Windows 11', 'vm', 'stopped', null],
      ['Home Assistant', 'vm', 'running', null],
    ]);
    // Docker switched off: its part is null beside the rest.
    expect(parseGuests({ docker: null, vms: null })).toEqual([]);
  });

  it('reads the rest, each part on its own', () => {
    expect(parseMore(UNRAID_MORE.data)).toMatchObject({
      shares: 4,
      unread: { alert: 0, warning: 1 },
      parity: { status: 'COMPLETED', errors: 0, running: false },
      version: '7.2.2',
    });
    expect(parseMore({})).toEqual({ shares: null, unread: null, parity: null, machine: null, version: null });
  });

  it('says which disks have a problem; an empty slot has none', () => {
    const disk = { name: 'disk1', tempC: 30, errors: 0, sizeBytes: 1, freeBytes: 1 };
    expect(diskProblem({ ...disk, status: 'DISK_OK' })).toBeNull();
    expect(diskProblem({ ...disk, status: 'DISK_NP' })).toBeNull();
    expect(diskProblem({ ...disk, status: 'DISK_DSBL' })).toEqual({ words: 'is disabled', tone: 'bad' });
    expect(diskProblem({ ...disk, status: 'DISK_OK', errors: 12 })).toEqual({
      words: 'has 12 read errors',
      tone: 'warn',
    });
  });
});

describe('Unraid’s page in slots', () => {
  it('shows its containers and VMs, what is in it, its space and its own processor and memory', () => {
    const DAY = 86_400_000;
    const space = [0, 1, 2, 3].map((i) => ({
      at: new Date(now.getTime() - (3 - i) * DAY),
      value: 4990 + 5 * i,
    }));
    const v = checked(unraidView({ snapshot: snap(), url, now, timeZone: TZ, space }));
    expect(slotProblems(v)).toEqual([]);
    expect(v.panels.map((p) => p.id)).toEqual(['guests', 'inventory', 'week']);
    const live = panel(v, 'guests', 'gallery');
    expect(live?.meta).toBe('3 of 5 running');
    expect(live?.items.map((i) => [i.title, i.badge?.text ?? null, i.muted ?? false])).toEqual([
      ['nextcloud', 'Unhealthy', false],
      ['Home Assistant', null, false],
      ['plex', null, false],
      ['old-sonarr', null, true],
      ['Windows 11', null, true],
    ]);
    expect(panel(v, 'inventory', 'list')?.items.map((i) => [i.id, i.figure?.value, i.figure?.note])).toEqual([
      ['array', '63 %', undefined],
      ['pool-cache', '40 %', undefined],
      ['disks', '4', 'All fine · warmest 41 °C'],
      ['containers', '3', '1 unhealthy'],
      ['vms', '2', '1 running'],
      ['shares', '4', undefined],
    ]);
    expect(panel(v, 'week', 'chart')?.title).toBe('Space used');
    expect(v.slots?.own?.name).toBe('Tower');
    expect(v.slots?.own?.figures.cpuPct).toBe(12.5);
    expect(v.slots?.machine.map((b) => [b.label, b.value])).toEqual([
      ['Unraid', '7.2.2'],
      ['Up', '12 days'],
    ]);
    // Unraid's own warnings are a heads-up, and start off.
    expect(v.notices.map((n) => [n.check, n.nature])).toEqual([['unraid.notifications', 'fyi']]);
    expect(v.status).toEqual({ status: 'ok', badge: 'Array started' });
  });

  it('puts a parity check that runs before the guests', () => {
    const more = parseMore({
      ...UNRAID_MORE.data,
      array: {
        parityCheckStatus: { status: 'RUNNING', progress: 42, errors: 0, running: true, paused: false },
      },
    });
    const live = panel(
      checked(unraidView({ snapshot: snap({ more }), url, now, timeZone: TZ })),
      'guests',
      'gallery',
    );
    expect(live?.items[0]).toMatchObject({
      id: 'parity',
      title: 'Parity check',
      progress: 0.42,
      note: '42 %',
    });
  });

  it('raises the array stopped, a disabled disk, parity errors and a full array, each starting on', () => {
    const array = parseArray(
      {
        ...UNRAID_ARRAY.data,
        array: {
          ...UNRAID_ARRAY.data.array,
          state: 'STOPPED',
          disks: [{ name: 'disk2', status: 'DISK_DSBL', temp: null, numErrors: 3 }],
        },
      },
      now,
    );
    const more = parseMore({
      ...UNRAID_MORE.data,
      array: {
        parityCheckStatus: { date: '2026-11-20T04:00:00Z', status: 'COMPLETED', errors: 7, running: false },
      },
    });
    const lines = unraidNotices({ snapshot: snap({ array, more }), url, now, timeZone: TZ });
    expect(lines.map((n) => [n.check, n.tone])).toEqual([
      ['unraid.array_stopped', 'bad'],
      ['unraid.disk', 'bad'],
      ['unraid.parity_errors', 'warn'],
      ['unraid.notifications', 'info'],
    ]);
    expect(lines[1]?.title).toBe('disk2 is disabled');
    const full = parseArray(
      {
        ...UNRAID_ARRAY.data,
        array: {
          ...UNRAID_ARRAY.data.array,
          capacity: { kilobytes: { free: '1', used: '97', total: '98' } },
        },
      },
      now,
    );
    expect(
      unraidNotices({ snapshot: snap({ array: full, more: null }), url, now, timeZone: TZ })[0],
    ).toMatchObject({
      check: 'unraid.array_full',
      tone: 'bad',
    });
    const on = new Map(UNRAID_CHECKS.map((c) => [c.check, c.startsOn]));
    expect([...on].filter(([, v]) => v).map(([k]) => k)).toEqual([
      'unraid.array_stopped',
      'unraid.disk',
      'unraid.parity_errors',
      'unraid.array_full',
    ]);
    for (const n of lines) expect(on.has(n.check)).toBe(true);
  });
});

describe('Unraid’s health pass', () => {
  const row = {
    id: 'con_unraid',
    burrowId: 'b1',
    catalogId: 'unraid',
    baseUrl: url,
    fields: { url },
    glance: null,
    credentialVersion: 1,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  } as unknown as CatalogConnectionRow;

  it('reads the array only: its name, its used space as a point, and its lines', async () => {
    const seen = await UNRAID_KIND.seen?.(fakeServices(now), row, now, 'UTC');
    expect(http.queries).toEqual([ARRAY_QUERY]);
    expect(seen?.glance.hostname).toBe('Tower');
    expect(seen?.points[NAS_USED_KEY]).toBe(5000);
    expect(seen?.glance.facts?.map((f) => [f.label, f.value])).toEqual([['Array', '63 %']]);
    expect(seen?.notices).toEqual([]);
    expect(seen?.skipped).toEqual(['unraid.parity_errors', 'unraid.notifications']);
  });

  it('keeps its name and space but raises nothing when Whombat watches the server', async () => {
    watched.server = 'tower';
    const seen = await UNRAID_KIND.seen?.(
      fakeServices(now),
      { ...row, id: 'con_unraid_watched' },
      now,
      'UTC',
    );
    expect(seen?.glance).toMatchObject({ hostname: 'Tower', line: 'Part of tower' });
    expect(seen?.points[NAS_USED_KEY]).toBe(5000);
    expect(seen?.notices).toEqual([]);
    expect(seen?.skipped).toEqual(UNRAID_CHECKS.map((c) => c.check));
  });

  it('says a refused key in plain words', async () => {
    const { unraidQuery } = await import('./unraid');
    const mod = await import('../../../connections/http');
    const spy = vi.spyOn(mod, 'signedConnectionFetch').mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(UNRAID_FORBIDDEN)),
    } as never);
    await expect(unraidQuery(fakeServices(now), row, ARRAY_QUERY)).rejects.toThrow(
      'Unraid’s key may not read this.',
    );
    spy.mockRestore();
  });
});
