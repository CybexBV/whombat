/**
 * Nextcloud's page from real answers (service-dashboards.md SD-57; fixtures from Nextcloud 35.0.2's Monitoring app,
 * recorded 2026-10-21, and its users/details, recorded 2026-11-04 in a throwaway 35.0.2): its slots, the card's figures,
 * users and shares, app updates, the free space, and an account that isn't an admin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { slotProblems } from '../slots';
import type { KindNotice } from './lines';
import { StatusProblem } from './net';
import {
  figures,
  freePoint,
  NEXTCLOUD_CHECKS,
  NEXTCLOUD_FREE_KEY,
  NEXTCLOUD_KIND,
  type NextcloudInfo,
  type NextcloudSnapshot,
  type NextcloudUser,
  nextcloudSkipped,
  nextcloudView,
  parseInfo,
  parseQuota,
  parseUsers,
  readNextcloud,
  shortVersion,
  spaceUsed,
} from './nextcloud';
import { checked, fakeServices, fixture, panel } from './test-helpers';

const net = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock('./net', async (orig) => ({ ...(await orig<typeof import('./net')>()), readJson: net.readJson }));

const now = new Date('2026-10-21T20:00:00Z');
const url = 'https://cloud.example.com';
const row = {
  id: 'con_nc',
  catalogId: 'nextcloud',
  baseUrl: url,
  fields: { url },
} as unknown as CatalogConnectionRow;

const snap = (info = parseInfo(fixture('nextcloud-serverinfo.json'))): NextcloudSnapshot => ({
  readAt: now,
  info,
  quota: null,
});
const view = (s: NextcloudSnapshot, users?: NextcloudUser[] | null, at = now) =>
  checked(nextcloudView({ snapshot: s, url, users, now: at }));
const card = (s: NextcloudSnapshot, key: string) => figures(s).find((k) => k.key === key);
const line = (v: ReturnType<typeof view>, id: string) =>
  panel(v, 'cloud', 'list')?.items.find((x) => x.id === id);

afterEach(() => net.readJson.mockReset());

describe('reading Nextcloud (SD-57)', () => {
  it('reads the Monitoring app’s answer with apps and updates', () => {
    const i = parseInfo(fixture('nextcloud-serverinfo.json'));
    expect(i.version).toBe('35.0.2');
    expect(i.freeBytes).toBe(1751782653952);
    expect([i.files, i.users, i.active.day]).toEqual([0, 1, 1]);
    expect(i.update).toEqual({ available: false, version: null });
    expect(i.apps).toEqual({ installed: 51, updates: [] });
    expect(i.shares?.links).toBe(1);
    expect(i.database).toEqual({ type: 'SQLite', version: '3.46.1', bytes: 2293760 });
  });

  it('knows nothing of updates when the skips weren’t turned off', () => {
    const i = parseInfo(fixture('nextcloud-serverinfo-skipped.json'));
    expect(i.update).toBeNull();
    expect(i.apps).toBeNull();
    expect(card(snap(i), 'updates')).toBeUndefined();
    expect(line(view(snap(i)), 'apps')).toBeUndefined();
  });

  it('reads app updates from an object of versions', () => {
    const body = fixture('nextcloud-serverinfo.json') as {
      ocs: { data: { nextcloud: { system: Record<string, unknown> } } };
    };
    const system = body.ocs.data.nextcloud.system;
    system.apps = {
      num_installed: 51,
      num_updates_available: 2,
      app_updates: { calendar: '6.1.0', deck: '2.0.1' },
    };
    system.update = { lastupdatedat: 1, available: true, available_version: '35.0.3.1' };
    const i = parseInfo(body);
    expect(i.apps?.updates).toEqual([
      { id: 'calendar', version: '6.1.0' },
      { id: 'deck', version: '2.0.1' },
    ]);
    expect(i.update).toEqual({ available: true, version: '35.0.3' });
    const v = view(snap(i));
    expect(card(snap(i), 'updates')?.value).toBe('3');
    expect(line(v, 'apps')?.figure).toEqual({ value: '51', note: '2 updates waiting' });
    expect(panel(v, 'apps', 'list')?.items.map((x) => x.id)).toEqual(['app-calendar', 'app-deck']);
    expect(v.slots?.machine.find((b) => b.id === 'nextcloud-version')?.sub).toBe('Version 35.0.3 is out');
    expect(v.notices.map((n) => [n.id, n.tone])).toEqual([
      ['update', 'info'],
      ['app-updates', 'info'],
    ]);
    expect(v.status?.status).toBe('ok');
  });

  it('falls back to the account’s own storage when it isn’t an admin (Nextcloud answers 401)', async () => {
    net.readJson.mockImplementation(async (_s, _r, _n, req: { path: string }) => {
      if (req.path.includes('serverinfo')) throw new StatusProblem('refused', 401, true);
      return {
        ocs: {
          data: { id: 'mara', quota: { free: 8e9, used: 2e9, total: 10e9, relative: 20, quota: 10e9 } },
        },
      };
    });
    const s = await readNextcloud(fakeServices(now), row, now);
    expect(s.info).toBeNull();
    expect(s.quota).toEqual({ used: 2e9, total: 10e9 });
    const v = view(s);
    expect(card(s, 'yours')?.meter).toBeCloseTo(0.2);
    expect(slotProblems(v)).toEqual([]);
    expect(panel(v, 'cloud', 'list')?.items.map((x) => [x.title, x.figure?.value])).toEqual([
      ['Your files', '2.0 of 10 GB'],
    ]);
    expect(v.slots?.machine).toEqual([]);
    expect(v.notices.map((n) => n.id)).toEqual(['not-admin']);
    expect(v.status?.status).toBe('ok');
    // A sign-in Nextcloud refuses altogether stays refused.
    net.readJson.mockRejectedValue(new StatusProblem('refused', 401, true));
    await expect(readNextcloud(fakeServices(now), row, now)).rejects.toMatchObject({ refused: true });
  });

  it('reads a quota without a limit as no bar', () => {
    expect(parseQuota({ ocs: { data: { quota: { free: 5, used: 3, total: 8, quota: -3 } } } })).toEqual({
      used: 3,
      total: null,
    });
    expect(shortVersion('35.0.2.2')).toBe('35.0.2');
  });
});

describe('Nextcloud’s page in slots (SD-57, service-slots.md)', () => {
  const users = parseUsers(fixture('nextcloud-users-details.json'));

  it('reads every user with their space, quota and last sign-in', () => {
    expect(users.map((u) => [u.id, u.name, u.enabled, u.quota])).toEqual([
      ['admin', 'admin', true, null],
      ['anna', 'Anna de Vries', true, 1073741824],
      ['sam', 'Sam', false, null],
    ]);
    expect(users[0]?.used).toBe(65646129);
    expect(users[0]?.lastLogin?.getTime()).toBe(1793820444000);
    expect(users[1]?.lastLogin).toBeNull();
    expect(parseUsers({ ocs: { data: { users: [] } } })).toEqual([]);
  });

  it('fills In Nextcloud, Who uses most space and the machine lines; no row of figures, the card keeps its own', () => {
    // Two days after the users were recorded.
    const v = view(snap(), users, new Date('2026-11-06T20:00:00Z'));
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    expect(figures(snap()).map((k) => k.key)).toEqual(['active', 'files', 'free', 'updates']);
    expect(card(snap(), 'free')?.meter).toBeUndefined();
    expect(panel(v, 'cloud', 'list')?.items.map((x) => [x.id, x.figure?.value, x.figure?.note])).toEqual([
      ['files', '0', undefined],
      ['users', '1', '1 on today'],
      ['shares', '1', '1 open link'],
      ['apps', '51', 'All up to date'],
    ]);
    expect(line(v, 'shares')?.detail).toBe('1 link');
    // Only who uses space, the busiest first, with when they were last seen.
    const who = panel(v, 'people', 'bars');
    expect(who?.items.map((b) => [b.label, b.person, b.value, b.note])).toEqual([
      ['admin', true, '66 MB', 'Last seen 2 days ago'],
    ]);
    expect(v.slots?.machine.map((b) => [b.id, b.value, b.sub])).toEqual([
      ['nextcloud-version', '35.0.2', 'Up to date'],
      ['free', '1.8 TB', undefined],
      ['database', 'SQLite 3.46.1', '2 MB'],
    ]);
    expect(v.panels.some((p) => p.id === 'apps')).toBe(false);
    expect(v.notices).toEqual([]);
  });

  it('draws Space used from its own readings of the free space, and keeps the free space as a point', () => {
    const s = snap();
    expect(freePoint(s)[NEXTCLOUD_FREE_KEY]).toBeGreaterThan(0);
    const DAY = 86_400_000;
    // Free space in GB at the end of each of the last 15 days: 5 GB less a day, then 20 GB freed yesterday.
    const free = Array.from({ length: 15 }, (_, i) => ({
      at: new Date(now.getTime() - (14 - i) * DAY),
      value: i === 13 ? 1000 - 5 * 12 + 20 : 1000 - 5 * i,
    }));
    const v = checked(nextcloudView({ snapshot: s, url, now, timeZone: 'UTC', free }));
    expect(slotProblems(v)).toEqual([]);
    const week = panel(v, 'week', 'chart');
    expect(week?.title).toBe('Space used');
    // The day space was freed draws no bar; the week's net is the figure.
    expect(week?.series[0]?.values).toEqual([5, 5, 5, 5, 5, 0, 30]);
    expect(week?.figure?.value).toBe('+35 GB');
    // Without its users read, no People: Inventory and the Trend share the row with the machine card.
    expect(v.panels.map((p) => p.id)).toEqual(['cloud', 'week']);
    // Fewer than two days: no Trend.
    expect(spaceUsed({ snapshot: s, url, now, timeZone: 'UTC', free: free.slice(-1) })).toBeNull();
    expect(spaceUsed({ snapshot: s, url })).toBeNull();
  });

  it('marks a user near their quota amber with the quota under them, and one turned off', () => {
    const near: NextcloudUser[] = [
      { id: 'a', name: 'Anna', enabled: true, used: 9.2e9, quota: 10e9, lastLogin: now },
      { id: 's', name: 'Sam', enabled: false, used: 1e9, quota: null, lastLogin: null },
    ];
    const bars = panel(view(snap(), near), 'people', 'bars')?.items ?? [];
    expect(bars[0]).toMatchObject({
      label: 'Anna',
      value: '9.2 GB',
      note: 'On today',
      tone: 'warn',
      sub: 'Quota 10 GB',
    });
    expect(bars[1]).toMatchObject({ label: 'Sam', note: 'Turned off' });
    expect(bars[1]?.tone).toBeUndefined();
    // Users not read: no People, the row closes up.
    expect(panel(view(snap()), 'people', 'bars')).toBeUndefined();
  });

  it('says when the free space runs low', () => {
    const i = parseInfo(fixture('nextcloud-serverinfo.json'));
    expect(view(snap({ ...i, freeBytes: 8e9 })).notices[0]).toMatchObject({ id: 'free', tone: 'warn' });
    const bad = view(snap({ ...i, freeBytes: 1e9 }));
    expect(bad.notices[0]).toMatchObject({ id: 'free', tone: 'bad' });
    expect(bad.status?.status).toBe('bad');
    expect(bad.slots?.machine.find((b) => b.id === 'free')).toMatchObject({ value: '1.0 GB', tone: 'bad' });
  });
});

describe('Nextcloud’s lines as Whombat watches them (quiet-notices.md QN-01…QN-04)', () => {
  const info = (over: Partial<NextcloudInfo> = {}): NextcloudInfo => ({
    ...parseInfo(fixture('nextcloud-serverinfo.json')),
    ...over,
  });
  const lines = (s: NextcloudSnapshot) => view(s).notices as KindNotice[];
  const updates = (n: number) =>
    info({
      update: { available: true, version: '35.0.3' },
      apps: {
        installed: 51,
        updates: Array.from({ length: n }, (_, k) => ({ id: `app${k}`, version: `1.${k}` })),
      },
    });

  it('gives every line its check, kind of line and how an Ignore ends; the checks list them all', () => {
    const checks = new Set(NEXTCLOUD_CHECKS.map((c) => c.check));
    expect(NEXTCLOUD_KIND.checks).toBe(NEXTCLOUD_CHECKS);
    const all = [
      ...lines(snap(updates(3))),
      ...lines(snap(info({ freeBytes: 1e9 }))),
      ...lines({ readAt: now, info: null, quota: null }),
    ];
    expect(new Set(all.map((n) => n.check))).toEqual(checks);
    for (const n of all) {
      expect(n.ignore?.words.length).toBeLessThanOrEqual(60);
      if (n.nature !== 'problem') expect(n.link?.kind).not.toBe('ask');
    }
  });

  it('makes low free space a problem to look into, and the rest heads-ups', () => {
    expect(lines(snap(info({ freeBytes: 8e9 })))[0]).toMatchObject({
      check: 'nextcloud.free',
      nature: 'problem',
      link: { kind: 'ask' },
      ignore: { lifts: 'fixed' },
    });
    expect(lines({ readAt: now, info: null, quota: null })[0]).toMatchObject({
      check: 'nextcloud.not_admin',
      nature: 'fyi',
    });
    expect(lines(snap(updates(1))).find((n) => n.id === 'update')).toMatchObject({
      nature: 'fyi',
      episode: '35.0.3',
      ignore: { lifts: 'newer' },
    });
  });

  it('gives the app updates one line until the next versions, however many there are', () => {
    const one = lines(snap(updates(1))).find((n) => n.check === 'nextcloud.app_update');
    expect(one).toMatchObject({
      title: '1 Nextcloud app has an update',
      nature: 'fyi',
      ignore: { lifts: 'newer' },
    });
    expect(one?.subject).toBeUndefined();
    const many = lines(snap(updates(11))).filter((n) => n.check === 'nextcloud.app_update');
    expect(many.map((n) => n.title)).toEqual(['11 Nextcloud apps have updates']);
    expect(many[0]?.episode).not.toBe(one?.episode);
  });

  it('skips what an account that isn’t an admin, or a Nextcloud that didn’t say, can’t show', () => {
    expect(nextcloudSkipped(snap())).toEqual([]);
    expect(nextcloudSkipped({ readAt: now, info: null, quota: null })).toEqual([
      'nextcloud.free',
      'nextcloud.update',
      'nextcloud.app_update',
    ]);
    expect(nextcloudSkipped(snap(parseInfo(fixture('nextcloud-serverinfo-skipped.json'))))).toEqual([
      'nextcloud.update',
      'nextcloud.app_update',
    ]);
  });

  it('gives the health pass the lines it read and what it skipped', async () => {
    net.readJson.mockImplementation(async (_s, _r, _n, req: { path: string }) => {
      if (req.path.includes('serverinfo')) throw new StatusProblem('refused', 401, true);
      return { ocs: { data: { id: 'mara', quota: { used: 2e9, total: 10e9, quota: 10e9 } } } };
    });
    const full = {
      ...row,
      id: 'con_nc_seen',
      credentialVersion: 1,
      updatedAt: new Date('2026-10-01T00:00:00Z'),
    } as CatalogConnectionRow;
    const seen = await NEXTCLOUD_KIND.seen?.(fakeServices(now), full, now, 'UTC');
    expect(seen?.notices?.map((n) => n.check)).toEqual(['nextcloud.not_admin']);
    expect(seen?.skipped).toContain('nextcloud.free');
    expect(seen?.glance.status).toBe('ok');
    // The card keeps its figure though the page has no row of them.
    expect(seen?.glance.facts?.map((f) => f.label)).toEqual(['Your storage']);
  });
});
