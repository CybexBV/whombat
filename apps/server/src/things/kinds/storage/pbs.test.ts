/**
 * Proxmox Backup Server's page from its documented answers (service-dashboards.md SD-50; fixtures in the shapes of PBS
 * 4's API viewer, 2026-10): datastores and when they are full, guests late after 2 days and removed ones, jobs, failed
 * tasks, the figures and the card, and the buttons' calls with their targets checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import type { KindNotice } from './lines';
import { StatusProblem } from './net';
import {
  type GuestName,
  groupLabel,
  guestsInOrder,
  lateAfterMs,
  PBS_CHECKS,
  PBS_KIND,
  type PbsGroup,
  type PbsSnapshot,
  type PbsStore,
  parseGroups,
  parseJobs,
  parseNamespaces,
  parseSnapshots,
  parseTasks,
  parseUsage,
  pbsSkipped,
  pbsView,
  readPbs,
  rhythmOf,
  runCleanup,
  runVerify,
  storeFull,
  taskWords,
} from './pbs';
import { checked, fakeServices, fixture, panel } from './test-helpers';

const net = vi.hoisted(() => ({ readJson: vi.fn(), actAs: vi.fn() }));
vi.mock('./net', async (orig) => ({ ...(await orig<typeof import('./net')>()), readJson: net.readJson }));
vi.mock('../act', () => ({ actAs: net.actAs }));

const now = new Date('2026-10-21T20:00:00Z');
const TZ = 'Europe/Amsterdam';
const url = 'https://pbs.lan:8007';
const row = {
  id: 'con_pbs',
  catalogId: 'proxmox_backup',
  label: 'Backups',
  access: 'write',
  baseUrl: url,
  fields: { url },
  credentialVersion: 1,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
} as unknown as CatalogConnectionRow;
const names = new Map<string, GuestName>([
  ['vm/105', { name: 'web', href: '/servers/pve-01?guest=qemu%2F105' }],
]);

function answer(path: string, query?: Record<string, string>): unknown {
  const p = path.replace('/api2/json', '');
  const files: Record<string, string> = {
    '/version': 'pbs-version.json',
    '/status/datastore-usage': 'pbs-datastore-usage.json',
    '/admin/verify': 'pbs-verify.json',
    '/admin/prune': 'pbs-prune.json',
    '/admin/sync': 'pbs-sync.json',
    '/admin/gc': 'pbs-gc.json',
    '/nodes/localhost/tasks': 'pbs-tasks.json',
    '/admin/datastore/tank/namespace': 'pbs-namespaces.json',
    '/admin/datastore/tank/snapshots': query?.ns ? '' : 'pbs-snapshots-tank.json',
    '/admin/datastore/tank/groups': query?.ns === 'lab' ? 'pbs-groups-tank-lab.json' : 'pbs-groups-tank.json',
  };
  if (p === '/admin/datastore/offsite/namespace') throw new StatusProblem('missing', 404);
  const file = files[p];
  return file ? fixture(file) : { data: [] };
}

const snapshotOf = async (): Promise<PbsSnapshot> => {
  forgetKindReads(fakeServices(now));
  net.readJson.mockImplementation(async (_s, _r, _n, req: { path: string; query?: Record<string, string> }) =>
    answer(req.path, req.query),
  );
  return readPbs(fakeServices(now), row, now);
};

const view = (s: PbsSnapshot) =>
  checked(pbsView({ snapshot: s, now, timeZone: TZ, url, names, buttons: { row } }));

afterEach(() => {
  net.readJson.mockReset();
  net.actAs.mockReset();
});

describe('reading Proxmox Backup Server (SD-50)', () => {
  it('reads datastores with PBS’s own estimate, and one that isn’t mounted', () => {
    const stores = parseUsage(fixture('pbs-datastore-usage.json'), now);
    expect(stores.map((s) => [s.name, s.error !== null])).toEqual([
      ['tank', false],
      ['offsite', false],
      ['usb', true],
    ]);
    expect(stores[0]?.fullAt?.toISOString()).toBe('2027-03-30T20:00:00.000Z');
    // An estimate in the past means it isn't filling up.
    expect(stores[1]?.fullAt).toBeNull();
    expect(stores[0]?.history.length).toBe(91);
    // Without PBS's estimate, the line through its history.
    expect(storeFull({ ...(stores[0] as PbsStore), fullAt: null }, now)).not.toBeNull();
  });

  it('reads namespaces, groups, snapshots, jobs and failed tasks', () => {
    expect(parseNamespaces(fixture('pbs-namespaces.json'))).toEqual(['', 'lab']);
    const groups = parseGroups(fixture('pbs-groups-tank.json'), 'tank', '');
    expect(groups.map(groupLabel)).toEqual(['VM 105', 'CT 131', 'VM 102', 'Host nas']);
    const snaps = parseSnapshots(fixture('pbs-snapshots-tank.json'));
    expect(snaps.get('vm/105')).toMatchObject({ size: 34359738368, verified: 'ok', damaged: 1 });
    expect(parseJobs(fixture('pbs-prune.json'), 'prune').map((j) => j.id)).toEqual(['p-tank']);
    expect(parseJobs(fixture('pbs-gc.json'), 'gc').map((j) => [j.id, j.lastState === 'OK'])).toEqual([
      ['tank', true],
      ['offsite', false],
    ]);
    const tasks = parseTasks(fixture('pbs-tasks.json'));
    expect(tasks.map(taskWords)).toEqual([
      'Backup of CT 131',
      'Backup of CT 131',
      'Garbage collection on offsite',
      'Verify on tank',
    ]);
  });

  it('reads every namespace and merges sizes and verification into the groups', async () => {
    const s = await snapshotOf();
    expect(s.version).toBe('4.0.18');
    expect(s.groups.map((g) => `${g.store}/${g.ns}/${g.type}/${g.id}`)).toEqual([
      'tank//vm/105',
      'tank//ct/131',
      'tank//vm/102',
      'tank//host/nas',
      'tank/lab/vm/900',
    ]);
    expect(s.groups[0]).toMatchObject({ size: 34359738368, verified: 'ok', damaged: 1 });
    expect(s.jobs?.map((j) => `${j.kind}:${j.id}`)).toEqual([
      'gc:tank',
      'gc:offsite',
      'verify:v-weekly',
      'verify:v-offsite',
      'prune:p-tank',
      'sync:s-offsite',
    ]);
    // The datastore that isn't mounted isn't asked for its groups.
    expect(net.readJson.mock.calls.some((c) => String(c[3].path).includes('/usb/'))).toBe(false);
  });

  it('leaves the jobs out when the token may not read them, and gc when PBS is older', async () => {
    forgetKindReads(fakeServices(now));
    net.readJson.mockImplementation(
      async (_s, _r, _n, req: { path: string; query?: Record<string, string> }) => {
        if (req.path.startsWith('/api2/json/admin/') && !req.path.includes('/datastore/'))
          throw new StatusProblem(
            req.path.endsWith('/gc') ? 'missing' : 'refused',
            req.path.endsWith('/gc') ? 404 : 403,
          );
        return answer(req.path, req.query);
      },
    );
    const s = await readPbs(fakeServices(now), row, now);
    expect(s.jobs).toBeNull();
    expect(panel(view(s), 'jobs', 'list')).toBeUndefined();
  });
});

describe('Proxmox Backup Server’s page (SD-50)', () => {
  it('is in slots: Jobs, What it keeps and the backups per day, no row of figures', async () => {
    const v = view(await snapshotOf());
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    expect(v.panels.map((p) => p.id)).toEqual(['jobs', 'datastores', 'week', 'guests', 'failed']);
    // Its machine is the one Whombat watches it on; else only its version.
    expect(v.slots?.machine.map((b) => [b.label, b.value])).toEqual([['Proxmox Backup Server', '4.0.18']]);
    expect(v.slots?.own).toBeUndefined();
  });

  it('keeps datastores, guests and backups in What it keeps, with this week’s change', async () => {
    const kept = panel(view(await snapshotOf()), 'datastores', 'list');
    expect(kept).toMatchObject({ title: 'What it keeps', look: 'counts' });
    expect(kept?.items.map((i) => [i.id, i.figure?.value, i.figure?.note ?? null, i.tone ?? null])).toEqual([
      // PBS's own usage history says what tank gained this week.
      ['store-tank', '68 %', '+134 GB this week', null],
      ['store-offsite', '88 %', null, 'warn'],
      // Unplugged on purpose (a removable datastore): not red.
      ['store-usb', 'Away', null, null],
      ['guests', '4', '1 late', 'bad'],
      ['backups', '55', '+4 this week', null],
    ]);
    expect(kept?.items[0]?.detail).toMatch(/^Full in about \d+ months$/);
    expect(kept?.items[3]?.detail).toBe('Oldest backup 3 days ago · CT 131');
  });

  it('counts the backups made each day from the snapshots kept', async () => {
    const s = await snapshotOf();
    const week = panel(view(s), 'week', 'chart');
    expect(week).toMatchObject({
      title: 'Backups this week',
      figure: { value: '4', rest: 'backups this week' },
    });
    expect(week?.labels).toHaveLength(7);
    expect(week?.series[0]?.values.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(4);
    // A guest keeps less than two weeks: no change on the week before.
    expect(week?.stats).toBeUndefined();
    expect(panel(view({ ...s, snapshotsRead: false }), 'week', 'chart')).toBeUndefined();
  });

  it('lists the guests oldest first with names, and the jobs with their last run and next', async () => {
    const v = view(await snapshotOf());
    const guests = panel(v, 'guests', 'table');
    expect(guests?.rows.map((r) => r.cells.guest?.text)).toEqual([
      'CT 131',
      'web',
      'VM 900',
      'Host nas',
      'VM 102',
    ]);
    expect(guests?.rows[1]?.cells.guest?.href).toBe('/servers/pve-01?guest=qemu%2F105');
    expect(guests?.rows[0]?.cells.last?.dot).toBe('bad');
    expect(guests?.rows[4]?.cells.guest?.tone).toBe('muted');
    expect(guests?.rows[1]?.cells.verified?.text).toBe('Damaged');
    const jobs = panel(v, 'jobs', 'list');
    expect(jobs).toMatchObject({ title: 'Jobs', meta: '2 failed last time' });
    expect(jobs?.items.map((i) => [i.id, i.title, i.tone ?? null])).toEqual([
      ['verify:v-offsite', 'Verify · offsite', 'bad'],
      ['verify:v-weekly', 'Verify · tank', null],
      ['gc:offsite', 'Garbage collection · offsite', 'bad'],
      ['gc:tank', 'Garbage collection · tank', null],
      ['prune:p-tank', 'Prune · tank', null],
      ['sync:s-offsite', 'Sync from pbs-home', null],
    ]);
    expect(jobs?.items[1]?.detail).toMatch(/^OK · 2 days ago · next /);
    expect(panel(v, 'failed', 'list')?.items).toHaveLength(3);
  });

  it('puts Run verify on verify jobs and Run cleanup on datastores, asked first', async () => {
    const s = await snapshotOf();
    const run = (v: ReturnType<typeof view>) =>
      panel(v, 'jobs', 'list')?.items.map((r) => {
        const a = r.actions?.[0];
        return a ? [r.id, a.action, a.target, a.allowed, !!a.confirm] : [r.id, null];
      });
    expect(run(view(s))).toEqual([
      ['verify:v-offsite', 'verify', 'v-offsite', true, true],
      ['verify:v-weekly', 'verify', 'v-weekly', true, true],
      ['gc:offsite', 'cleanup', 'offsite', true, true],
      ['gc:tank', 'cleanup', 'tank', true, true],
      ['prune:p-tank', null],
      ['sync:s-offsite', null],
    ]);
    // An older PBS lists no cleanup jobs: each datastore it can use still gets one.
    const older = view({ ...s, jobs: (s.jobs ?? []).filter((j) => j.kind !== 'gc') });
    expect(
      run(older)
        ?.filter((r) => r[1] === 'cleanup')
        .map((r) => r[2]),
    ).toEqual(['offsite', 'tank']);
  });

  it('says what is wrong, worst first, heads-ups after', async () => {
    const v = view(await snapshotOf());
    expect(v.notices.map((n) => [n.id, n.tone])).toEqual([
      ['late-tank--ct-131', 'bad'],
      ['damaged-tank--vm-105', 'bad'],
      ['job-verify-v-offsite', 'bad'],
      ['full-offsite', 'warn'],
      ['job-gc-offsite', 'warn'],
      ['store-usb', 'info'],
      ['retired-tank--vm-102', 'info'],
    ]);
    // The failed backups of CT 131 are told by its late line, the failed cleanup by its job's line.
    expect(v.notices.find((n) => n.id === 'late-tank--ct-131')?.detail).toContain('connection reset');
    expect(v.status?.status).toBe('bad');
  });

  it('is calm when every guest has a recent backup', async () => {
    const s = await snapshotOf();
    const calm: PbsSnapshot = {
      ...s,
      stores: s.stores.filter((x) => x.name === 'tank'),
      groups: s.groups.filter((g) => g.type !== 'ct' && g.id !== '102').map((g) => ({ ...g, damaged: 0 })),
      jobs: (s.jobs ?? []).filter((j) => j.store === 'tank'),
      tasks: [],
    };
    const v = view(calm);
    expect(v.notices).toEqual([]);
    expect(v.status).toEqual({ status: 'ok', badge: 'All 3 guests backed up' });
    expect(guestsInOrder(calm.groups, now).map(groupLabel)).toEqual(['VM 105', 'VM 900', 'Host nas']);
  });

  it('gives the card Oldest backup and Failed, the dot from Worth a look', async () => {
    const s = await snapshotOf();
    net.readJson.mockClear();
    const seen = await PBS_KIND.seen?.(fakeServices(now), row, now, TZ);
    expect(seen?.glance.facts?.map((f) => f.label)).toEqual(['Oldest backup', 'Failed']);
    expect(seen?.glance.status).toBe('bad');
    expect(seen?.glance.line).toBe(`Backups · Proxmox Backup Server ${s.version}`);
    expect(seen?.glance.facts?.[0]).toMatchObject({ value: '3 days' });
  });
});

describe('what Whombat watches on Proxmox Backup Server (QN-01…QN-04)', () => {
  const lines = (s: PbsSnapshot) => view(s).notices as KindNotice[];
  const line = (s: PbsSnapshot, id: string) => lines(s).find((n) => n.id === id);
  const group = (over: Partial<PbsGroup>): PbsGroup => ({
    store: 'tank',
    ns: '',
    type: 'vm',
    id: '300',
    last: null,
    count: 5,
    size: null,
    verified: null,
    damaged: 0,
    first: null,
    rhythmS: null,
    ...over,
  });
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const only = (s: PbsSnapshot, groups: PbsGroup[], tasks: PbsSnapshot['tasks'] = []): PbsSnapshot => ({
    ...s,
    stores: s.stores.filter((x) => x.name === 'tank'),
    groups,
    jobs: [],
    tasks,
  });

  it('gives every line its check, subject, nature and Ignore, from the list of checks', async () => {
    const all = lines(await snapshotOf());
    const checks = new Set(PBS_CHECKS.map((c) => c.check));
    for (const n of all) {
      expect(checks.has(n.check)).toBe(true);
      expect(n.ignore?.words).toMatch(/^Until .*\.$/);
      expect(n.nature).toBeDefined();
    }
    expect(line(await snapshotOf(), 'late-tank--ct-131')).toMatchObject({
      check: 'pbs.backup_late',
      subject: { id: 'guest:tank//ct/131', name: 'CT 131' },
      nature: 'problem',
      ignore: { lifts: 'newer' },
      episode: '2026-10-18T16:00:00.000Z',
    });
    expect(line(await snapshotOf(), 'damaged-tank--vm-105')).toMatchObject({
      check: 'pbs.verify_failed',
      subject: { name: 'web' },
      band: 1,
    });
    expect(line(await snapshotOf(), 'job-gc-offsite')).toMatchObject({
      subject: { id: 'job:gc/offsite' },
      link: { kind: 'ask' },
    });
  });

  it('keeps counts and ages out of episodes: run times and ids only', async () => {
    for (const n of lines(await snapshotOf()))
      if (n.episode) expect(n.episode).toMatch(/^(\d{4}-\d\d-\d\dT[\d:.]+Z|UPID:.*|[0-9a-f]{8})$/);
  });

  it('follows a guest’s own rhythm: a weekly guest isn’t late on day 3, but is on day 11', async () => {
    const s = await snapshotOf();
    const weekly = (last: number) => group({ last: daysAgo(last), rhythmS: 7 * 86_400 });
    expect(line(only(s, [weekly(3)]), 'late-tank--vm-300')).toBeUndefined();
    expect(line(only(s, [weekly(11)]), 'late-tank--vm-300')).toMatchObject({ tone: 'bad' });
    // Without a rhythm: two days, as before.
    expect(line(only(s, [group({ last: daysAgo(3) })]), 'late-tank--vm-300')).toBeDefined();
    expect(rhythmOf([1000, 1000 + 86_400, 1000 + 2 * 86_400, 1000 + 9 * 86_400])).toBe(86_400);
    expect(lateAfterMs({ rhythmS: 7 * 86_400 })).toBe(10.5 * 86_400_000);
  });

  it('keeps a guest that is still being tried late, and only a quiet one becomes a removed heads-up', async () => {
    const s = await snapshotOf();
    const old = group({ last: daysAgo(40) });
    const tried = {
      upid: 'UPID:pbs:9',
      type: 'backup',
      workerId: 'tank:vm/300',
      start: daysAgo(1),
      status: 'connection refused',
    };
    expect(line(only(s, [old], [tried]), 'late-tank--vm-300')).toMatchObject({ nature: 'problem' });
    expect(line(only(s, [old]), 'retired-tank--vm-300')).toMatchObject({
      tone: 'info',
      nature: 'fyi',
      check: 'pbs.retired',
      ignore: { lifts: 'fixed' },
    });
    // A monthly guest isn't taken for removed after 31 days.
    expect(
      line(only(s, [group({ last: daysAgo(31), rhythmS: 30 * 86_400 })]), 'retired-tank--vm-300'),
    ).toBeUndefined();
  });

  it('caps late guests after sorting: the two that waited longest, then one line for the rest', async () => {
    const s = await snapshotOf();
    const many = Array.from({ length: 11 }, (_, i) => group({ id: String(200 + i), last: daysAgo(3 + i) }));
    const late = lines(only(s, many)).filter((n) => n.check === 'pbs.backup_late');
    expect(late).toHaveLength(3);
    expect(late[0]?.subject?.id).toBe('guest:tank//vm/210');
    const more = late.find((n) => n.subject?.id === '+more');
    expect(more).toMatchObject({ id: 'late-more', ignore: { lifts: 'newer' }, subject: { name: '9 more' } });
    expect(more?.episode).toMatch(/^[0-9a-f]{8}$/);
  });

  it('leaves the group a guest moved away from alone, but not a second guest with the same id', async () => {
    const s = await snapshotOf();
    const left = group({ store: 'tank', last: daysAgo(20) });
    const moved = group({ store: 'offsite', last: daysAgo(1), first: daysAgo(15) });
    expect(lines(only(s, [left, moved])).filter((n) => n.check === 'pbs.backup_late')).toEqual([]);
    // Both kept being backed up: two clusters with a VM 300 each.
    const other = group({ store: 'offsite', ns: 'b', last: daysAgo(1), first: daysAgo(60) });
    expect(line(only(s, [group({ last: daysAgo(5) }), other]), 'late-tank--vm-300')).toBeDefined();
  });

  it('makes an unplugged or maintenance datastore a heads-up, a broken one a problem', async () => {
    const s = await snapshotOf();
    expect(line(s, 'store-usb')).toMatchObject({
      nature: 'fyi',
      tone: 'info',
      check: 'pbs.store_unavailable',
    });
    expect(line(s, 'store-usb')?.link).toBeUndefined();
    const store = s.stores[2] as PbsStore;
    const withStore = (x: PbsStore) => ({ ...s, stores: [x] });
    expect(
      line(withStore({ ...store, away: 'maintenance', error: 'in maintenance mode' }), 'store-usb'),
    ).toMatchObject({
      nature: 'fyi',
    });
    expect(
      line(withStore({ ...store, away: null, error: 'chunk store corrupt' }), 'store-usb'),
    ).toMatchObject({
      nature: 'problem',
      tone: 'bad',
      link: { kind: 'ask' },
    });
  });

  it('makes a forecast alone a heads-up, and fullness a problem with its band', async () => {
    const s = await snapshotOf();
    const tank = s.stores[0] as PbsStore;
    const soon = { ...s, stores: [{ ...tank, fullAt: new Date(now.getTime() + 20 * 86_400_000) }] };
    const n = line(soon, 'full-soon-tank');
    expect(n).toMatchObject({ check: 'pbs.store_full_soon', nature: 'fyi', tone: 'info' });
    expect(n?.band).toBeUndefined();
    expect(n?.episode).toBeUndefined();
    expect(line(s, 'full-offsite')).toMatchObject({ check: 'pbs.store_full', nature: 'problem', band: 85 });
  });

  it('shows a failed task only when nothing else tells it, a restore as a heads-up', async () => {
    const s = await snapshotOf();
    const task = (over: Partial<NonNullable<PbsSnapshot['tasks']>[number]>) => ({
      upid: 'UPID:pbs:1',
      type: 'backup',
      workerId: 'tank:vm/105',
      start: daysAgo(2),
      status: 'TASK ERROR: broken pipe',
      ...over,
    });
    const tasks = [
      // VM 105 was backed up since: made good.
      task({}),
      task({ upid: 'UPID:pbs:2', type: 'reader', workerId: 'tank' }),
      task({ upid: 'UPID:pbs:3', type: 'verify', workerId: 'tank' }),
    ];
    const all = lines({ ...s, tasks }).filter((n) => n.check === 'pbs.task_failed');
    expect(all.map((n) => [n.subject?.id, n.nature])).toEqual([
      ['task:verify/tank', 'problem'],
      ['task:reader/tank', 'fyi'],
    ]);
    expect(all[0]).toMatchObject({ episode: 'UPID:pbs:3', ignore: { lifts: 'newer' } });
  });

  it('says which checks it couldn’t see whole', async () => {
    const s = await snapshotOf();
    // The unplugged datastore's guests weren't read.
    expect(pbsSkipped(s)).toEqual(['pbs.backup_late', 'pbs.retired', 'pbs.verify_failed']);
    const whole = { ...s, groupsComplete: true };
    expect(pbsSkipped(whole)).toEqual([]);
    expect(pbsSkipped({ ...whole, jobs: null, tasksCapped: true })).toEqual([
      'pbs.job_failed',
      'pbs.task_failed',
    ]);
    const seen = await PBS_KIND.seen?.(fakeServices(now), row, now, TZ);
    expect(seen?.skipped).toContain('pbs.backup_late');
    expect(seen?.notices?.map((n) => n.id)).toContain('late-tank--ct-131');
    expect(PBS_KIND.checks).toBe(PBS_CHECKS);
  });
});

describe('Proxmox Backup Server’s buttons (SD-07)', () => {
  const ctx = { services: fakeServices(now), row, now, timeZone: TZ };
  beforeEach(async () => {
    await snapshotOf();
    net.actAs.mockResolvedValue({ status: 200, json: { data: 'UPID:pbs:1' } });
  });

  it('runs a verify job that exists, by its id', async () => {
    const out = await runVerify(ctx, { target: 'v-weekly' });
    expect(net.actAs.mock.calls[0]?.[3]).toEqual({
      method: 'POST',
      path: '/api2/json/admin/verify/v-weekly/run',
    });
    expect(out.everyday).toBeUndefined();
    await expect(runVerify(ctx, { target: 'p-tank' })).rejects.toThrow();
    expect(net.actAs).toHaveBeenCalledTimes(1);
  });

  it('starts garbage collection on a datastore it can use', async () => {
    await runCleanup(ctx, { target: 'tank' });
    expect(net.actAs.mock.calls[0]?.[3]).toEqual({
      method: 'POST',
      path: '/api2/json/admin/datastore/tank/gc',
    });
    await expect(runCleanup(ctx, { target: 'usb' })).rejects.toThrow();
    await expect(runCleanup(ctx, {})).rejects.toThrow();
    expect(net.actAs).toHaveBeenCalledTimes(1);
  });
});
