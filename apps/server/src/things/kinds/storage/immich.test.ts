/**
 * Immich's page from its documented answers (service-dashboards.md SD-55; fixtures in the shapes of Immich 2.x's API,
 * immich.app/docs/api; `search/statistics` and a quota recorded 2026-11-04 in a throwaway 3.3.6): its slots, the
 * card's figures, the queues (2.4's and the older jobs), integrity, recently added as square thumbnails, who uses most
 * space, what came in per day (the server's points, or the key's own searches), and Resume with its target checked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { RawPoint } from '../../series';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import {
  figures,
  IMMICH_CHECKS,
  IMMICH_KIND,
  IMMICH_PHOTOS_KEY,
  IMMICH_VIDEOS_KEY,
  type ImmichAdded,
  type ImmichQueue,
  type ImmichSnapshot,
  immichSkipped,
  immichView,
  parseFavourites,
  parseIntegrity,
  parseJobs,
  parseMemories,
  parseQueues,
  parseRecent,
  parseStatistics,
  queueName,
  readAdded,
  readFavourites,
  readImmich,
  readMemories,
  resumeQueue,
} from './immich';
import type { KindNotice } from './lines';
import { StatusProblem } from './net';
import { checked, fakePicture, fakeServices, fixture, panel, picturePath } from './test-helpers';

const net = vi.hoisted(() => ({ readJson: vi.fn(), actAs: vi.fn() }));
vi.mock('./net', async (orig) => ({ ...(await orig<typeof import('./net')>()), readJson: net.readJson }));
vi.mock('../act', () => ({ actAs: net.actAs }));

const now = new Date('2026-10-21T20:00:00Z');
const TZ = 'Europe/Amsterdam';
const url = 'http://immich.lan:2283';
const row = {
  id: 'con_immich',
  catalogId: 'immich',
  label: 'Immich',
  access: 'write',
  baseUrl: url,
  fields: { url },
  credentialVersion: 1,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
} as unknown as CatalogConnectionRow;
const services = fakeServices(now);

const FILES: Record<string, string> = {
  '/api/server/storage': 'immich-server-storage.json',
  '/api/server/statistics': 'immich-server-statistics.json',
  '/api/server/version': 'immich-server-version.json',
  '/api/server/version-check': 'immich-version-check.json',
  '/api/queues': 'immich-queues.json',
  '/api/jobs': 'immich-jobs.json',
  '/api/admin/integrity/summary': 'immich-integrity-summary.json',
  '/api/search/metadata': 'immich-search-metadata.json',
  '/api/assets/statistics': 'immich-assets-statistics.json',
  '/api/memories': 'immich-memories.json',
  '/api/search/random': 'immich-search-random.json',
  '/api/albums/statistics': 'immich-albums-statistics.json',
  '/api/people': 'immich-people.json',
};

function answering({ missing = [], refused = [] }: { missing?: string[]; refused?: string[] } = {}) {
  net.readJson.mockImplementation(async (_s, _r, _n, req: { path: string }) => {
    if (missing.includes(req.path)) throw new StatusProblem('missing', 404);
    if (refused.includes(req.path)) throw new StatusProblem('refused', 403);
    return fixture(FILES[req.path] as string);
  });
}

async function snapshot(opts: Parameters<typeof answering>[0] = {}): Promise<ImmichSnapshot> {
  forgetKindReads(services);
  answering(opts);
  return readImmich(services, row, now);
}

const view = (
  s: ImmichSnapshot,
  more: { points?: { photos: RawPoint[]; videos: RawPoint[] } | null; added?: ImmichAdded | null } = {},
) =>
  checked(
    immichView({
      snapshot: s,
      now,
      timeZone: TZ,
      url,
      buttons: { row },
      picture: fakePicture,
      ...more,
    }),
  );
const DAY = 86_400_000;
/** A reading at noon `daysAgo` days back (Amsterdam). */
const at = (daysAgo: number, value: number): RawPoint => ({
  at: new Date(Date.UTC(2026, 9, 21, 10) - daysAgo * DAY),
  value,
});

afterEach(() => {
  net.readJson.mockReset();
  net.actAs.mockReset();
});

describe('reading Immich (SD-55)', () => {
  it('reads the server’s figures, 2.4’s queues, integrity and the newest assets (a POST read)', async () => {
    const s = await snapshot();
    expect(s.version).toBe('2.1.0');
    expect(s.latest).toBe('2.2.1');
    expect(s.counts).toMatchObject({ photos: 48211, videos: 1934, mine: false });
    expect(s.queueApi).toBe('queues');
    expect(s.integrity).toEqual({ missing: 2, untracked: 5, mismatched: 0 });
    expect(s.recent?.map((a) => a.id)).toEqual([
      '6f1d7e4a-1b2c-4d3e-8f90-a1b2c3d4e5f6',
      '7a2e8f5b-2c3d-4e4f-9a01-b2c3d4e5f6a7',
    ]);
    const search = net.readJson.mock.calls.find((c) => c[3].path === '/api/search/metadata')?.[3];
    expect(search).toMatchObject({ method: 'POST', body: { order: 'desc', size: 12 } });
  });

  it('falls back to the older jobs and the key’s own library when it isn’t an admin’s', async () => {
    const s = await snapshot({
      missing: ['/api/queues', '/api/admin/integrity/summary'],
      refused: ['/api/server/statistics'],
    });
    expect(s.queueApi).toBe('jobs');
    expect(s.counts).toMatchObject({ photos: 30111, videos: 1200, mine: true });
    expect(s.people).toEqual([]);
    expect(s.integrity).toBeNull();
    expect(parseJobs(fixture('immich-jobs.json'))).toEqual(parseQueues(fixture('immich-queues.json')));
  });

  it('reads integrity in either spelling, and names queues', () => {
    expect(parseIntegrity({ missing_file: 1, untracked_file: 0, checksum_mismatch: 3 })).toEqual({
      missing: 1,
      untracked: 0,
      mismatched: 3,
    });
    expect(parseIntegrity([{ type: 'missing_file', count: 4 }])).toMatchObject({ missing: 4 });
    expect(parseIntegrity({})).toBeNull();
    expect(queueName('thumbnailGeneration')).toBe('Thumbnails');
    expect(queueName('someNewThing')).toBe('Some new thing');
    expect(parseRecent({ assets: { items: [{ id: 'x/../y' }] } })).toEqual([]);
  });
});

describe('On this day', () => {
  it('reads this day’s memories where the person is: earlier years, latest first, photos only', async () => {
    forgetKindReads(services);
    answering();
    const memories = await readMemories(services, row, now, TZ);
    expect(net.readJson.mock.calls[0]?.[3]).toMatchObject({
      path: '/api/memories',
      query: { for: '2026-10-21', type: 'on_this_day' },
    });
    expect(memories?.map((m) => [m.year, m.photos.map((p) => p.city)])).toEqual([
      [2023, ['Texel', 'De Koog']],
      [2020, [null]],
    ]);
    expect(parseMemories([{ type: 'on_this_day', data: {}, assets: [] }, 'x'])).toEqual([]);
  });

  it('leaves them out when the key may not read them', async () => {
    forgetKindReads(services);
    answering({ refused: ['/api/memories'] });
    expect(await readMemories(services, row, now, TZ)).toBeNull();
  });

  it('shows them as square pictures, “3 years ago” and where; quiet when there are none', async () => {
    const memories = parseMemories(fixture('immich-memories.json'));
    const s = await snapshot();
    const make = (m: typeof memories | null) =>
      checked(
        immichView({
          snapshot: s,
          now,
          timeZone: TZ,
          url,
          buttons: { row },
          picture: fakePicture,
          memories: m,
        }),
      );
    const day = panel(make(memories), 'memories', 'gallery');
    expect(day?.shape).toBe('square');
    expect(day?.items.map((i) => [i.title, i.sub])).toEqual([
      ['3 years ago · Texel', '2023'],
      ['3 years ago · De Koog', '2023'],
      ['6 years ago', '2020'],
    ]);
    expect(picturePath(day?.items[0]?.image)).toBe(
      '/api/assets/a2000000-0000-4000-8000-000000000001/thumbnail?size=preview',
    );
    expect(panel(make([]), 'memories', 'gallery')?.items).toEqual([]);
    expect(panel(make(null), 'memories', 'gallery')).toBeUndefined();
  });
});

describe('Favourites', () => {
  it('reads a dozen favourite photos at random, photos only, kept an hour; none for a key that may not', async () => {
    forgetKindReads(services);
    answering();
    const favs = await readFavourites(services, row);
    const search = net.readJson.mock.calls.find((c) => c[3].path === '/api/search/random')?.[3];
    expect(search).toMatchObject({ method: 'POST', body: { isFavorite: true, type: 'IMAGE', size: 12 } });
    expect(favs?.map((f) => [f.id.slice(-1), f.city])).toEqual([
      ['1', 'Texel'],
      ['2', null],
    ]);
    await readFavourites(services, row);
    expect(net.readJson.mock.calls.filter((c) => c[3].path === '/api/search/random')).toHaveLength(1);
    forgetKindReads(services);
    answering({ refused: ['/api/search/random'] });
    expect(await readFavourites(services, row)).toBeNull();
    expect(parseFavourites({ error: 'x' })).toEqual([]);
  });

  it('shows them as square previews, where and when; left out when not read', async () => {
    const s = await snapshot();
    const make = (favourites: ReturnType<typeof parseFavourites> | null) =>
      checked(
        immichView({
          snapshot: s,
          now,
          timeZone: TZ,
          url,
          buttons: { row },
          picture: fakePicture,
          favourites,
        }),
      );
    const favs = panel(make(parseFavourites(fixture('immich-search-random.json'))), 'favourites', 'gallery');
    expect(favs?.items.map((i) => [i.title, i.sub])).toEqual([
      ['Texel', 'June 2019'],
      ['December 2024', undefined],
    ]);
    expect(picturePath(favs?.items[0]?.image)).toBe(
      '/api/assets/f1000000-0000-4000-8000-000000000001/thumbnail?size=preview',
    );
    expect(panel(make([]), 'favourites', 'gallery')?.items).toEqual([]);
    expect(panel(make(null), 'favourites', 'gallery')).toBeUndefined();
  });
});

describe('Immich’s page in slots (SD-55, service-slots.md)', () => {
  it('fills Working on, In Immich, Recently added, Who uses most space and the machine lines; no row of figures', async () => {
    const s = await snapshot();
    const v = view(s);
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    // No points yet: no Trend, no change this week.
    expect(v.panels.map((p) => p.id)).toEqual(['jobs', 'library', 'recent', 'people']);
    const library = panel(v, 'library', 'list');
    expect(library?.items.map((x) => [x.id, x.figure?.value, x.detail, x.figure?.note])).toEqual([
      ['photos', '48,211', '402 GB', undefined],
      ['videos', '1,934', '410 GB', undefined],
      ['albums', '1', 'Yours · 1 shared', undefined],
    ]);
    // Immich found no faces in the recorded library: no People line.
    expect(s.faces).toBe(0);
    expect(panel(view({ ...s, faces: 86 }), 'library', 'list')?.items.at(-1)).toMatchObject({
      title: 'People',
      figure: { value: '86' },
    });
    expect(v.slots?.machine.map((b) => [b.id, b.value, b.sub, b.tone])).toEqual([
      ['immich-version', '2.1.0', 'Version 2.2.1 is out', undefined],
      ['photo-disk', '3.5 of 4.0 TB', '551 GB free', 'warn'],
    ]);
  });

  it('lists the queues with something to do in Working on, a paused one with work first and with Resume', async () => {
    const v = view(await snapshot());
    const jobs = panel(v, 'jobs', 'list');
    expect(jobs?.meta).toBe('530 waiting');
    expect(jobs?.items.map((i) => [i.title, i.detail, i.tone, i.actions?.[0]?.action])).toEqual([
      ['Smart search', '412 waiting · paused', 'warn', 'resume'],
      ['Metadata', '3 failed', 'warn', undefined],
      ['Thumbnails', '118 waiting · 2 running', undefined, undefined],
    ]);
    expect(jobs?.items[0]?.actions?.[0]).toMatchObject({ target: 'smartSearch', allowed: true });
    // Every queue idle: Working on is left out.
    const idle = await snapshot();
    const quiet = view({
      ...idle,
      queues: (idle.queues ?? []).map((q) => ({ ...q, active: 0, waiting: 0, failed: 0 })),
    });
    expect(panel(quiet, 'jobs', 'list')).toBeUndefined();
    expect(slotProblems(quiet)).toEqual([]);
  });

  it('draws recently added as square thumbnails and who uses most space, amber near a quota', async () => {
    const v = view(await snapshot());
    const recent = panel(v, 'recent', 'gallery');
    expect(recent?.look).toBe('shelf');
    expect(recent?.shape).toBe('square');
    expect(picturePath(recent?.items[0]?.image)).toBe(
      '/api/assets/6f1d7e4a-1b2c-4d3e-8f90-a1b2c3d4e5f6/thumbnail?size=thumbnail',
    );
    expect(recent?.items[1]?.badge?.text).toBe('Video');
    const people = panel(v, 'people', 'bars');
    expect(people?.items.map((b) => [b.label, b.person, b.sub])).toEqual([
      ['Mara', true, undefined],
      ['Ben', true, 'Quota 322 GB'],
    ]);
    expect(people?.items[1]?.tone).toBe('warn');
    // A quota as a throwaway 3.3.6 recorded it.
    const quota = parseStatistics(fixture('immich-server-statistics-quota.json')).people;
    expect(quota.map((p) => [p.name, p.quota])).toEqual([
      ['Mara', null],
      ['Anna', 20000],
    ]);
  });

  it('counts what came in per day from the server’s totals, once two days have a change', async () => {
    const s = await snapshot();
    // 48,211 photos and 1,934 videos now: ten a day more each day, five videos two days ago.
    const photos = Array.from({ length: 15 }, (_, k) => at(14 - k, 48211 - (14 - k) * 10));
    const videos = Array.from({ length: 15 }, (_, k) => at(14 - k, 1934 - (14 - k >= 2 ? 5 : 0)));
    const v = view(s, { points: { photos, videos } });
    expect(slotProblems(v)).toEqual([]);
    const week = panel(v, 'week', 'chart');
    expect(week?.series[0]?.values).toEqual([10, 10, 10, 10, 10, 15, 10]);
    expect(week?.labels?.at(-1)).toBe('Today');
    expect(week?.figure).toEqual({ value: '75', rest: 'added this week' });
    expect(week?.stats?.[0]?.[0]?.text).toBe('+7 %');
    expect(panel(v, 'library', 'list')?.items.map((x) => x.figure?.note)).toEqual([
      '+70 this week',
      '+5 this week',
      undefined,
    ]);
    // One day of readings: no Trend yet.
    expect(
      panel(view(s, { points: { photos: [at(1, 48201)], videos: [at(1, 1934)] } }), 'week', 'chart'),
    ).toBeUndefined();
    // Deleting photos doesn't make a day negative.
    const fewer = view(s, {
      points: { photos: [at(2, 48300), at(1, 48200)], videos: [at(2, 1934), at(1, 1934)] },
    });
    expect(panel(fewer, 'week', 'chart')?.series[0]?.values.slice(-2)).toEqual([0, 11]);
  });

  it('counts a key’s own uploads per day from its searches, called Added by you', async () => {
    const s = await snapshot({ refused: ['/api/server/statistics'] });
    const v = view(s, { added: { days: [0, 4, 0, 12, 1, 0, 3], before: 10, photos: 18 } });
    expect(slotProblems(v)).toEqual([]);
    const week = panel(v, 'week', 'chart');
    expect(week?.title).toBe('Added by you');
    expect(week?.figure).toEqual({ value: '20', rest: 'added this week' });
    expect(week?.stats?.[0]?.[0]?.text).toBe('+100 %');
    const library = panel(v, 'library', 'list');
    expect(library?.title).toBe('In your library');
    expect(library?.items.map((x) => x.figure?.note)).toEqual(['+18 this week', '+2 this week', undefined]);
    expect(library?.items[2]?.detail).toBe('1 shared');
    expect(panel(v, 'people', 'bars')).toBeUndefined();
  });

  it('asks Immich for each day’s uploads by upload time, the week before and this week’s photos', async () => {
    forgetKindReads(services);
    const bodies: Record<string, unknown>[] = [];
    net.readJson.mockImplementation(
      async (_s, _r, _n, req: { path: string; body: Record<string, unknown> }) => {
        bodies.push(req.body);
        return fixture('immich-search-statistics.json');
      },
    );
    const added = await readAdded(services, row, now, TZ);
    expect(bodies).toHaveLength(9);
    // Today in Amsterdam starts at 22:00 UTC the day before; today's count has no end.
    expect(bodies[6]).toEqual({ createdAfter: '2026-10-20T22:00:00.000Z' });
    expect(bodies[0]).toEqual({
      createdAfter: '2026-10-14T22:00:00.000Z',
      createdBefore: '2026-10-15T22:00:00.000Z',
    });
    expect(bodies[8]).toMatchObject({ type: 'IMAGE', createdAfter: '2026-10-14T22:00:00.000Z' });
    expect(added).toEqual({ days: [6, 6, 6, 6, 6, 6, 6], before: 6, photos: 6 });
  });

  it('keeps the card’s Photos and Disk, and gives the health pass the server’s totals as points', async () => {
    expect(figures(await snapshot()).map((k) => k.key)).toEqual(['photos', 'videos', 'disk', 'jobs']);
    answering();
    forgetKindReads(services);
    const seen = await IMMICH_KIND.seen?.(services, row, now, TZ);
    expect(seen?.glance.facts?.map((f) => f.label)).toEqual(['Photos', 'Disk']);
    expect(seen?.glance.line).toBe('Photos · Immich 2.1.0');
    expect(seen?.points).toEqual({ [IMMICH_PHOTOS_KEY]: 48211, [IMMICH_VIDEOS_KEY]: 1934 });
    // A key's own library isn't the server's: no points.
    answering({ refused: ['/api/server/statistics'] });
    forgetKindReads(services);
    expect((await IMMICH_KIND.seen?.(services, row, now, TZ))?.points).toEqual({});
  });

  it('says what is wrong: the disk, a paused queue (with Resume), failed jobs, missing files, an update', async () => {
    const v = view(await snapshot());
    expect(v.notices.map((n) => [n.id, n.tone])).toEqual([
      ['disk', 'warn'],
      ['paused-smartSearch', 'warn'],
      ['failed-metadataExtraction', 'warn'],
      ['integrity', 'warn'],
      ['update', 'info'],
    ]);
    expect(v.notices[1]?.action).toMatchObject({ action: 'resume', target: 'smartSearch' });
    expect(v.status?.status).toBe('warn');
  });
});

describe('what Whombat watches on Immich (QN-01…QN-04)', () => {
  const lines = (s: ImmichSnapshot) => view(s).notices as KindNotice[];
  const queue = (name: string, over: Partial<ImmichQueue> = {}): ImmichQueue => ({
    name,
    paused: false,
    active: 0,
    waiting: 0,
    failed: 0,
    ...over,
  });

  it('gives every line its check, nature and Ignore, from the list of checks', async () => {
    const all = lines(await snapshot());
    const checks = new Set(IMMICH_CHECKS.map((c) => c.check));
    for (const n of all) {
      expect(checks.has(n.check)).toBe(true);
      expect(n.ignore?.words).toMatch(/^Until .*\.$/);
    }
    expect(all.find((n) => n.id === 'update')).toMatchObject({ nature: 'fyi', episode: '2.2.1' });
    expect(all.find((n) => n.id === 'paused-smartSearch')).toMatchObject({
      nature: 'you',
      subject: { id: 'queue:smartSearch', name: 'Smart search' },
    });
  });

  it('makes a paused queue with nothing waiting a heads-up', async () => {
    const s = { ...(await snapshot()), queues: [queue('library', { paused: true })] };
    expect(lines(s).find((n) => n.id === 'paused-library')).toMatchObject({ nature: 'fyi', tone: 'info' });
  });

  it('makes one line per queue with failed jobs, the count its band (an Ignore lasts until more fail)', async () => {
    const s = {
      ...(await snapshot()),
      queues: [queue('thumbnailGeneration', { failed: 2 }), queue('videoConversion', { failed: 14 })],
    };
    const failed = lines(s).filter((n) => n.check === 'immich.jobs_failed');
    expect(failed.map((n) => [n.subject?.id, n.band, n.nature])).toEqual([
      ['queue:videoConversion', 14, 'problem'],
      ['queue:thumbnailGeneration', 2, 'problem'],
    ]);
    expect(failed.every((n) => n.episode === undefined)).toBe(true);
  });

  it('says which checks it couldn’t read', async () => {
    const s = await snapshot();
    expect(immichSkipped(s)).toEqual([]);
    expect(immichSkipped({ ...s, queues: null, integrity: null })).toEqual([
      'immich.queue_paused',
      'immich.jobs_failed',
      'immich.integrity',
    ]);
    answering();
    forgetKindReads(services);
    const seen = await IMMICH_KIND.seen?.(services, row, now, TZ);
    expect(seen?.notices?.map((n) => n.id)).toContain('integrity');
    expect(IMMICH_KIND.checks).toBe(IMMICH_CHECKS);
  });
});

describe('Immich’s button (SD-07, SD-08)', () => {
  const ctx = { services, row, now, timeZone: TZ };

  it('resumes a queue by 2.4’s API, everyday', async () => {
    await snapshot();
    net.actAs.mockResolvedValue({ status: 200, json: {} });
    const out = await resumeQueue(ctx, { target: 'smartSearch' });
    expect(net.actAs.mock.calls[0]?.[3]).toEqual({
      method: 'PUT',
      path: '/api/queues/smartSearch',
      body: { isPaused: false },
    });
    expect(out.everyday).toBe(true);
    await expect(resumeQueue(ctx, { target: 'nope' })).rejects.toThrow();
  });

  it('resumes by the older jobs command when the queues came from there', async () => {
    await snapshot({ missing: ['/api/queues'] });
    net.actAs.mockResolvedValue({ status: 200, json: {} });
    await resumeQueue(ctx, { target: 'smartSearch' });
    expect(net.actAs.mock.calls[0]?.[3]).toEqual({
      method: 'PUT',
      path: '/api/jobs/smartSearch',
      body: { command: 'resume', force: false },
    });
  });
});
