/**
 * TrueNAS's page from its documented answers (service-dashboards.md SD-51; fixtures in the shapes of TrueNAS 25.10's
 * JSON-RPC API, api.truenas.com/v25.10): pools, scrubs, disks and temperatures, apps, tasks, alerts in its words with
 * Dismiss, one socket for every read, 25.04's update check, and the buttons' calls with their targets checked.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SocketReply } from '../../../connections/socket/dialect';
import type { CatalogConnectionRow } from '../../../connections/types';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import type { KindNotice } from './lines';
import { checked, fakeServices, fixture, panel } from './test-helpers';
import {
  classWords,
  dismissAlert,
  parseAlerts,
  parsePools,
  parseTasks,
  parseTemps,
  parseUpdate,
  plainText,
  READ_CALLS,
  readTrueNas,
  scrubPool,
  startApp,
  stopApp,
  type TnPool,
  TRUENAS_CHECKS,
  TRUENAS_KIND,
  type TrueNasSnapshot,
  tnDate,
  truenasFigures,
  truenasSkipped,
  truenasVerdict,
  truenasView,
} from './truenas';

const sock = vi.hoisted(() => ({ truenasCalls: vi.fn(), truenasAct: vi.fn() }));
vi.mock('./truenas-socket', async (orig) => ({
  ...(await orig<typeof import('./truenas-socket')>()),
  truenasCalls: sock.truenasCalls,
  truenasAct: sock.truenasAct,
}));

const now = new Date('2026-10-21T20:00:00Z');
const TZ = 'Europe/Amsterdam';
const url = 'https://nas.lan';
const row = {
  id: 'con_tn',
  catalogId: 'truenas',
  label: 'NAS',
  access: 'write',
  baseUrl: url,
  fields: { url },
  credentialVersion: 1,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
} as unknown as CatalogConnectionRow;

const ok = (result: unknown): SocketReply => ({ ok: true, result, output: [], stopped: false });
const missing: SocketReply = {
  ok: false,
  error: { code: -32601, message: 'Method not found' },
  code: '-32601',
  output: [],
};
const ANSWERS: Record<string, string | null> = {
  'system.info': 'truenas-system-info.json',
  'alert.list': 'truenas-alert-list.json',
  'pool.query': 'truenas-pool-query.json',
  'disk.query': 'truenas-disk-query.json',
  'disk.temperatures': 'truenas-disk-temperatures.json',
  'app.query': 'truenas-app-query.json',
  'update.status': 'truenas-update-status.json',
  'replication.query': 'truenas-replication-query.json',
  'pool.snapshottask.query': 'truenas-snapshottask-query.json',
  'cloudsync.query': 'truenas-cloudsync-query.json',
  'cloud_backup.query': null,
  'update.check_available': 'truenas-update-check-available.json',
};

const refused: SocketReply = {
  ok: false,
  error: { code: -32001, message: 'Not authorized' },
  code: 'EACCES',
  output: [],
};

function answering(skip: string[] = [], fail: string[] = []) {
  sock.truenasCalls.mockImplementation(async (_s, _r, calls: { method: string }[]) =>
    calls.map((c) => {
      const file = ANSWERS[c.method];
      if (fail.includes(c.method)) return refused;
      return file && !skip.includes(c.method) ? ok(fixture(file)) : missing;
    }),
  );
}

const services = fakeServices(now);

async function snapshot(skip: string[] = [], fail: string[] = []): Promise<TrueNasSnapshot> {
  forgetKindReads(services);
  answering(skip, fail);
  return readTrueNas(services, row, now);
}

const view = (s: TrueNasSnapshot) =>
  checked(truenasView({ snapshot: s, now, timeZone: TZ, url, buttons: { row } }));

afterEach(() => {
  sock.truenasCalls.mockReset();
  sock.truenasAct.mockReset();
});

describe('reading TrueNAS (SD-51)', () => {
  it('reads everything over one socket, and selects only the fields shown from tasks', async () => {
    const s = await snapshot();
    expect(sock.truenasCalls).toHaveBeenCalledTimes(1);
    expect(sock.truenasCalls.mock.calls[0]?.[2]).toBe(READ_CALLS);
    for (const m of ['cloudsync.query', 'cloud_backup.query', 'replication.query'])
      expect(READ_CALLS.find((c) => c.method === m)?.params).toEqual([[], { select: expect.any(Array) }]);
    expect(s.version).toBe('25.10.1');
    expect(s.update).toEqual({ available: true, version: '25.10.2' });
    expect(s.tasks.map((t) => [t.id, t.result])).toEqual([
      ['snapshot-1', 'ok'],
      ['snapshot-2', null],
      ['replication-1', 'ok'],
      ['replication-2', 'failed'],
      ['cloudsync-1', 'ok'],
    ]);
  });

  it('asks 25.04 for its update check instead, kept an hour', async () => {
    const s = await snapshot(['update.status']);
    expect(sock.truenasCalls).toHaveBeenCalledTimes(2);
    expect(sock.truenasCalls.mock.calls[1]?.[2]).toEqual([{ method: 'update.check_available' }]);
    expect(s.update).toEqual({ available: true, version: '25.04.3' });
    // Read again: the page's methods, but the update check is kept.
    await readTrueNas(services, row, now);
    expect(sock.truenasCalls).toHaveBeenCalledTimes(3);
  });

  it('reads pools with their disks, scrubs, temperatures and alerts', () => {
    const pools = parsePools(fixture('truenas-pool-query.json'));
    expect(pools.map((p) => [p.name, p.healthy, p.disks])).toEqual([
      ['tank', true, ['sda', 'sdb', 'sdc', 'nvme0n1']],
      ['fast', false, ['nvme1n1', 'nvme2n1']],
    ]);
    expect(parseTemps(fixture('truenas-disk-temperatures.json')).get('sdd')).toBeUndefined();
    expect(parseTemps({ sda: { temp: 40, crit: 60 } }).get('sda')).toBe(40);
    const alerts = parseAlerts(fixture('truenas-alert-list.json'));
    expect(alerts.map((a) => [a.uuid, a.level, a.klass])).toEqual([
      ['d4e5f6', 'CRITICAL', 'VolumeStatus'],
      ['p7q8r9', 'CRITICAL', 'SMART'],
      ['a1b2c3', 'WARNING', 'ZpoolCapacityWarning'],
      ['m4n5o6', 'WARNING', 'NTPHealthCheck'],
      ['g7h8i9', 'NOTICE', 'SMART'],
    ]);
    expect(alerts[0]?.text).not.toMatch(/<|>/);
    expect(plainText('a<br>b &amp; <a href="x">c</a>')).toBe('a b & c');
    expect(tnDate({ $date: 1000 })?.getTime()).toBe(1000);
    expect(parseUpdate({}, {})).toBeNull();
    expect(parseTasks('cloudbackup', [{ id: 1, enabled: true, job: null }])).toEqual([
      {
        id: 'cloudbackup-1',
        kind: 'cloudbackup',
        name: 'Task 1',
        result: null,
        at: null,
        error: null,
        percent: null,
      },
    ]);
    expect(parseTasks('replication', [{ id: 4, name: 'x', state: { state: 'ABORTED' } }])[0]?.result).toBe(
      'aborted',
    );
  });
});

describe('TrueNAS’s page (SD-51)', () => {
  it('is in slots: Apps, Storage, TrueNAS’s lines, the tasks and disks below, no row of figures', async () => {
    const v = view(await snapshot());
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    expect(v.panels.map((p) => p.id)).toEqual(['apps', 'pools', 'tasks', 'disks']);
    expect(v.slots?.own).toBeUndefined();
    expect(v.slots?.machine.map((b) => [b.label, b.value, b.sub ?? null])).toEqual([
      ['TrueNAS', '25.10.1', '25.10.2 is out'],
      ['Processor', 'AMD Ryzen 7 5700G', '16 threads'],
      ['Memory', '64 GB', 'Not ECC'],
      ['Up', '12 days', null],
    ]);
    // Up moved to the card: the head keeps two facts.
    expect(v.facts).toHaveLength(2);
  });

  it('shows the apps in Live, crashed first, with Start or Stop', async () => {
    const live = panel(view(await snapshot()), 'apps', 'gallery');
    expect(live).toMatchObject({
      title: 'Apps',
      look: 'rows',
      meta: '2 of 4 apps running · 1 crashed · 1 stopped',
    });
    expect(live?.items.map((i) => [i.title, i.sub, i.badge?.text ?? null, i.actions?.[0]?.action])).toEqual([
      ['immich', '2.1.0 · Update waiting', 'Crashed', 'start'],
      ['minio', 'Stopped · 2025.4.22', null, 'start'],
      ['plex', '1.42.2.10156 · Update waiting', null, 'stop'],
      ['nextcloud', '31.0.9', null, 'stop'],
    ]);
    expect(live?.items.find((i) => i.title === 'plex')?.actions?.[0]?.confirm).toBeTruthy();
  });

  it('puts a scrub or a copy that runs on top of Live, with its bar', async () => {
    const s = await snapshot();
    const busy: TrueNasSnapshot = {
      ...s,
      pools: s.pools.map((p) =>
        p.name === 'tank' && p.scan
          ? { ...p, scan: { ...p.scan, state: 'SCANNING', percent: 45.2, leftS: 7200 } }
          : p,
      ),
      tasks: s.tasks.map((t) =>
        t.kind === 'cloudsync' ? { ...t, result: 'running' as const, percent: 30 } : t,
      ),
    };
    const v = view(busy);
    const live = panel(v, 'apps', 'gallery');
    expect(live?.meta).toBe('2 jobs running · 2 of 4 apps running · 1 crashed · 1 stopped');
    expect(live?.items.slice(0, 2).map((i) => [i.title, i.progress, i.note, i.noteEnd])).toEqual([
      ['Checking tank for damage', 0.452, '45 %', 'about 2 h left'],
      ['Cloud sync Photos to B2', 0.3, '30 %', 'Running now'],
    ]);
    // No Check now while it checks.
    expect(panel(v, 'pools', 'list')?.items[0]?.actions).toBeUndefined();
    expect(v.refreshS).toBe(30);
  });

  it('counts each pool in Storage with Check now, then the disks and the tasks', async () => {
    const v = view(await snapshot());
    const pools = panel(v, 'pools', 'list');
    expect(pools).toMatchObject({ title: 'Storage', look: 'counts', meta: '16 of 26 TB' });
    expect(
      pools?.items.map((i) => [i.title, i.detail, i.figure?.value, i.figure?.note, i.tone ?? null]),
    ).toEqual([
      ['tank', 'RAIDZ1 · 4 disks', '60 %', '9.4 TB free', null],
      ['fast', 'Degraded · Mirror · checked 7 weeks ago', '90 %', '199 GB free', 'bad'],
      ['Disks', undefined, '7', '1 runs warm', 'warn'],
      ['Snapshots and copies', undefined, '5', '1 failed', 'bad'],
    ]);
    expect(pools?.items[0]?.actions?.[0]).toMatchObject({ action: 'scrub', target: 'tank' });
    expect(pools?.items[0]?.actions?.[0]?.confirm).toBeTruthy();
    const disks = panel(v, 'disks', 'table');
    expect(disks?.rows.map((r) => [r.id, r.cells.pool?.text])).toEqual([
      ['nvme1n1', 'fast'],
      ['nvme2n1', 'fast'],
      ['nvme0n1', 'tank'],
      ['sda', 'tank'],
      ['sdb', 'tank'],
      ['sdc', 'tank'],
      ['sdd', 'Not in a pool'],
    ]);
    expect(disks?.rows.find((r) => r.id === 'sdc')?.cells.temp).toMatchObject({
      text: '58 °C',
      tone: 'warn',
    });
    expect(panel(v, 'tasks', 'list')?.items[0]).toMatchObject({ id: 'replication-2', tone: 'bad' });
  });

  it('says what is wrong; Dismiss only on alerts that aren’t critical', async () => {
    const v = view(await snapshot());
    expect(v.notices.map((n) => [n.id, n.tone])).toEqual([
      ['pool-fast', 'bad'],
      ['scrub-errors-fast', 'bad'],
      ['alert-p7q8r9', 'bad'],
      ['scrub-fast', 'warn'],
      ['full-fast', 'warn'],
      ['alert-m4n5o6', 'warn'],
      ['task-replication-2', 'warn'],
      ['crashed-immich', 'warn'],
      ['hot-sdc', 'warn'],
      ['alert-g7h8i9', 'info'],
      ['update', 'info'],
      ['app-update-plex', 'info'],
    ]);
    expect(v.notices.find((n) => n.id === 'alert-p7q8r9')).toMatchObject({ tone: 'bad' });
    expect(v.notices.find((n) => n.id === 'alert-p7q8r9')?.action).toBeUndefined();
    expect(v.notices.find((n) => n.id === 'alert-m4n5o6')?.action).toMatchObject({
      action: 'dismiss',
      target: 'm4n5o6',
    });
    expect(v.notices.find((n) => n.id === 'alert-g7h8i9')).toMatchObject({ tone: 'info' });
    expect(v.notices.find((n) => n.id === 'scrub-fast')?.action?.action).toBe('scrub');
    expect(v.notices.find((n) => n.id === 'crashed-immich')?.action?.action).toBe('start');
    expect(v.status?.status).toBe('bad');
  });

  it('gives the card Pools and Alerts', async () => {
    await snapshot();
    const seen = await TRUENAS_KIND.seen?.(fakeServices(now), row, now, TZ);
    expect(seen?.glance.facts?.map((f) => f.label)).toEqual(['Pools', 'Alerts']);
    expect(seen?.glance.line).toBe('NAS · TrueNAS 25.10.1');
    expect(seen?.glance.facts?.[0]).toMatchObject({ value: '1 of 2' });
    expect(seen?.points.nas_used_gb).toBeGreaterThan(15_000);
  });
});

describe('TrueNAS’s lines as Whombat watches them (quiet-notices.md QN-01…QN-04)', () => {
  const lines = (s: TrueNasSnapshot) => view(s).notices as KindNotice[];
  const line = (s: TrueNasSnapshot, id: string) => lines(s).find((n) => n.id === id);
  const pool = (over: Partial<TnPool>): TnPool => ({
    name: 'tank',
    status: 'ONLINE',
    healthy: true,
    detail: null,
    size: null,
    allocated: null,
    scan: null,
    disks: [],
    ...over,
  });

  it('gives every line its check, kind of line and how an Ignore ends; the checks list them all', async () => {
    const all = lines(await snapshot());
    const checks = new Set(TRUENAS_CHECKS.map((c) => c.check));
    expect(TRUENAS_KIND.checks).toBe(TRUENAS_CHECKS);
    for (const n of all) {
      expect(checks.has(n.check)).toBe(true);
      expect(['problem', 'you', 'fyi']).toContain(n.nature);
      expect(n.ignore?.words.length).toBeLessThanOrEqual(60);
      // Episodes are identities (a state, a time, a version), never a count that drifts.
      if (n.episode !== undefined) expect(n.episode).not.toMatch(/^\d+$/);
      if (n.badge !== undefined) expect(n.badge.length).toBeLessThanOrEqual(40);
      if (n.nature !== 'problem') expect(n.link?.kind).not.toBe('ask');
    }
    expect(line(await snapshot(), 'pool-fast')).toMatchObject({
      check: 'truenas.pool',
      subject: { id: 'pool:fast' },
      nature: 'problem',
      episode: 'degraded',
      ignore: { lifts: 'fixed' },
    });
    expect(line(await snapshot(), 'task-replication-2')).toMatchObject({
      check: 'truenas.task',
      subject: { id: 'task:replication-2' },
      ignore: { lifts: 'newer' },
      episode: expect.stringMatching(/^2026-/),
    });
  });

  it('leaves out TrueNAS’s alerts of what Whombat says itself, and keys an alert on its class and key', async () => {
    const s = await snapshot();
    const all = lines(s);
    expect(all.some((n) => n.id === 'alert-d4e5f6' || n.id === 'alert-a1b2c3')).toBe(false);
    expect(truenasFigures(s).find((k) => k.key === 'alerts')?.value).toBe('5');
    expect(line(s, 'alert-p7q8r9')).toMatchObject({
      nature: 'you',
      subject: { id: 'alert:SMART//dev/sdb' },
      link: { kind: 'url' },
    });
    expect(line(s, 'alert-m4n5o6')).toMatchObject({
      nature: 'problem',
      subject: { id: 'alert:NTPHealthCheck', name: 'NTP health check' },
      link: { kind: 'ask' },
    });
    expect(line(s, 'alert-g7h8i9')).toMatchObject({ nature: 'fyi', tone: 'info' });
    expect(classWords('ZpoolCapacityWarning')).toBe('Zpool capacity warning');
    // A temperature alert gives way to Whombat's own line once the temperatures were read.
    const hot = {
      ...s,
      alerts: [
        {
          uuid: 'z',
          level: 'WARNING' as const,
          text: 'Disk sdc is hot.',
          at: null,
          klass: 'DiskTemperatureTooHot',
          key: null,
        },
      ],
    };
    expect(lines(hot).some((n) => n.check === 'truenas.alert')).toBe(false);
    expect(lines({ ...hot, temps: new Map() }).some((n) => n.check === 'truenas.alert')).toBe(true);
  });

  it('counts a resilver as a check of every block, and says nothing of a pool without any yet', async () => {
    const s = await snapshot();
    const end = new Date(now.getTime() - 3 * 86_400_000);
    const resilvered = pool({ scan: { kind: 'RESILVER', state: 'FINISHED', end, percent: 100, errors: 3 } });
    expect(
      lines({ ...s, alerts: [], pools: [resilvered] }).filter((n) => n.subject?.id === 'pool:tank'),
    ).toEqual([]);
    expect(line({ ...s, alerts: [], pools: [pool({})] }, 'scrub-tank')).toBeUndefined();
    const old = new Date(now.getTime() - 40 * 86_400_000);
    const overdue = line(
      {
        ...s,
        alerts: [],
        pools: [pool({ scan: { kind: 'RESILVER', state: 'FINISHED', end: old, percent: 100, errors: 0 } })],
      },
      'scrub-tank',
    );
    expect(overdue).toMatchObject({ tone: 'warn', nature: 'you', episode: old.toISOString() });
  });

  it('makes a pool with a terabyte free a heads-up, and one nearly full a problem to look into', async () => {
    const s = await snapshot();
    const roomy = pool({ size: 20e12, allocated: 17.4e12, scan: null });
    const tight = pool({ name: 'fast', size: 2e12, allocated: 1.8e12 });
    expect(line({ ...s, pools: [roomy] }, 'full-tank')).toMatchObject({ nature: 'fyi', band: 85 });
    expect(line({ ...s, pools: [roomy] }, 'full-tank')?.link).toBeUndefined();
    expect(line({ ...s, pools: [tight] }, 'full-fast')).toMatchObject({
      nature: 'problem',
      band: 85,
      link: { kind: 'ask' },
    });
    expect(line({ ...s, pools: [{ ...tight, allocated: 1.95e12 }] }, 'full-fast')).toMatchObject({
      tone: 'bad',
      band: 95,
    });
  });

  it('makes a stopped task a heads-up, not a failure', async () => {
    const s = await snapshot();
    const stopped = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === 'replication-2' ? { ...t, result: 'aborted' as const } : t)),
    };
    expect(line(stopped, 'task-replication-2')).toMatchObject({ tone: 'info', nature: 'fyi' });
  });

  it('keys a hot disk on its serial; warm is a heads-up, hot only you, both after two passes', async () => {
    const s = await snapshot();
    expect(line(s, 'hot-sdc')).toMatchObject({
      nature: 'fyi',
      subject: { id: 'disk:WD-CA0A1B2E', name: 'Disk sdc' },
      confirm: 2,
    });
    const hotter = { ...s, temps: new Map([...s.temps, ['sdc', 61]]) };
    expect(line(hotter, 'hot-sdc')).toMatchObject({ tone: 'bad', nature: 'you', link: { kind: 'url' } });
    const noSerial = { ...s, disks: s.disks.map((d) => ({ ...d, serial: null })) };
    expect(line(noSerial, 'hot-sdc')?.subject?.id).toBe('disk:sdc');
  });

  it('waits two passes for a crashed app, and makes a line only for a new app version', async () => {
    const s = await snapshot();
    expect(line(s, 'crashed-immich')).toMatchObject({ confirm: 2, nature: 'problem', link: { kind: 'ask' } });
    // immich has only newer images: no line; plex has a new version.
    expect(
      lines(s)
        .filter((n) => n.check === 'truenas.app_update')
        .map((n) => n.subject?.id),
    ).toEqual(['app:plex']);
  });

  it('gives two crashed apps a line each and the rest one line that lasts while they are the same', async () => {
    const s = await snapshot();
    const apps = Array.from({ length: 11 }, (_, i) => ({
      name: `app${i}`,
      state: 'CRASHED',
      update: false,
      upgrade: false,
      version: null,
    }));
    const crashed = lines({ ...s, apps }).filter((n) => n.check === 'truenas.app_crashed');
    expect(crashed).toHaveLength(3);
    const more = crashed.find((n) => n.subject?.id === '+more');
    expect(more).toMatchObject({ subject: { name: '9 more' }, ignore: { lifts: 'newer' } });
    const other = lines({
      ...s,
      apps: [...apps.slice(0, 10), { ...(apps[10] as (typeof apps)[0]), name: 'x' }],
    });
    expect(other.find((n) => n.subject?.id === '+more')?.episode).not.toBe(more?.episode);
  });

  it('skips the checks of what didn’t answer, not of what this TrueNAS hasn’t got', async () => {
    expect(truenasSkipped(await snapshot())).toEqual([]);
    expect(truenasSkipped(await snapshot(['update.status']))).toEqual([]);
    const s = await snapshot([], ['alert.list', 'pool.query', 'app.query']);
    expect(truenasSkipped(s)).toEqual(
      expect.arrayContaining(['truenas.alert', 'truenas.pool', 'truenas.pool_full', 'truenas.app_crashed']),
    );
    expect(truenasSkipped(s)).not.toContain('truenas.task');
    forgetKindReads(services);
    answering([], ['alert.list']);
    const seen = await TRUENAS_KIND.seen?.(fakeServices(now), row, now, TZ);
    expect(seen?.skipped).toEqual(['truenas.alert']);
    expect(seen?.notices?.length).toBeGreaterThan(0);
  });
});

describe('TrueNAS’s buttons (SD-07)', () => {
  const ctx = { services, row, now, timeZone: TZ };

  it('scrubs a pool now (threshold 0), only one of its pools', async () => {
    await snapshot();
    sock.truenasAct.mockResolvedValue(42);
    const out = await scrubPool(ctx, { target: 'tank' });
    expect(sock.truenasAct.mock.calls[0]?.[2]).toEqual({ method: 'pool.scrub.run', params: ['tank', 0] });
    expect(out.everyday).toBeUndefined();
    await expect(scrubPool(ctx, { target: 'nope' })).rejects.toThrow();
    expect(sock.truenasAct).toHaveBeenCalledTimes(1);
  });

  it('starts and stops apps by name', async () => {
    await snapshot();
    sock.truenasAct.mockResolvedValue(43);
    await startApp(ctx, { target: 'minio' });
    await stopApp(ctx, { target: 'plex' });
    expect(sock.truenasAct.mock.calls.map((c) => c[2])).toEqual([
      { method: 'app.start', params: ['minio'] },
      { method: 'app.stop', params: ['plex'] },
    ]);
    await expect(stopApp(ctx, { target: 'other' })).rejects.toThrow();
  });

  it('dismisses an alert that isn’t critical, everyday', async () => {
    await snapshot();
    sock.truenasAct.mockResolvedValue(null);
    const out = await dismissAlert(ctx, { target: 'a1b2c3' });
    expect(sock.truenasAct.mock.calls[0]?.[2]).toEqual({ method: 'alert.dismiss', params: ['a1b2c3'] });
    expect(out.everyday).toBe(true);
    await expect(dismissAlert(ctx, { target: 'd4e5f6' })).rejects.toThrow(/critical/);
    expect(sock.truenasAct).toHaveBeenCalledTimes(1);
  });
});

describe('TrueNAS verdict and Ask chips', () => {
  it('summarises pool health and adds Ask chips on Storage, Apps and Disks', async () => {
    const s = await snapshot();
    const v = view(s);
    expect(v.verdict).toBeTruthy();
    expect(panel(v, 'pools', 'list')?.ask?.questions.length).toBeGreaterThanOrEqual(2);
    expect(panel(v, 'apps', 'gallery')?.ask?.questions.length).toBeGreaterThanOrEqual(2);
    expect(panel(v, 'disks', 'table')?.ask?.questions.length).toBeGreaterThanOrEqual(2);

    const healthy = {
      ...s,
      pools: s.pools.map((p) => ({ ...p, healthy: true, status: 'ONLINE' })),
      apps: (s.apps ?? []).map((a) => ({ ...a, state: 'RUNNING' })),
    };
    expect(truenasVerdict(healthy)).toMatch(/pools are healthy.*free/);
    expect(truenasVerdict(s)).toMatch(/degraded/i);
  });
});
