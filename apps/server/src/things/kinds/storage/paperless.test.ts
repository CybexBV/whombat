/**
 * Paperless-ngx's page from real answers (service-dashboards.md SD-56; fixtures from Paperless-ngx 3.3.3, API 10, and
 * its API 9 shape, recorded 2026-10-21, and from a throwaway 3.4.2, recorded 2026-11-04: filed documents, what was
 * added, the busiest correspondents): its slots, the card's figures, the inbox, failed imports, its checks, Worth a
 * look, and the buttons' calls (Mark seen, Run sanity check) with their targets checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import type { KindNotice } from './lines';
import {
  checkItem,
  figures,
  markSeen,
  PAPERLESS_CHECKS,
  type PaperlessMore,
  type PaperlessSnapshot,
  pageOf,
  paperlessSkipped,
  paperlessView,
  parseAdded,
  parseFailed,
  parseInbox,
  parseNames,
  parseRemote,
  parseSenders,
  parseStatistics,
  parseStatus,
  readPaperless,
  readPaperlessMore,
  runSanityCheck,
  whyWords,
} from './paperless';
import { checked, fakePicture, fakeServices, fixture, panel, picturePath } from './test-helpers';

const net = vi.hoisted(() => ({
  readJson: vi.fn(),
  actAs: vi.fn(),
}));
vi.mock('./net', async (orig) => ({
  ...(await orig<typeof import('./net')>()),
  readJson: net.readJson,
}));
vi.mock('../act', () => ({ actAs: net.actAs }));

const now = new Date('2026-10-21T20:00:00Z');
const TZ = 'Europe/Amsterdam';
const url = 'http://paperless.lan:8000';
const row = {
  id: 'con_paperless',
  catalogId: 'paperless',
  label: 'Paperless-ngx',
  access: 'write',
  baseUrl: url,
  fields: { url },
  credentialVersion: 1,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
} as unknown as CatalogConnectionRow;
const manageRow = row;

function snapshot(over: Partial<PaperlessSnapshot> = {}): PaperlessSnapshot {
  const status = parseStatus(fixture('paperless-status.json'));
  const inbox = parseInbox(fixture('paperless-inbox.json'));
  const names = parseNames(fixture('paperless-correspondents.json'));
  const failed = parseFailed(fixture('paperless-tasks-failed.json'));
  const stats = parseStatistics(fixture('paperless-statistics.json'));
  return {
    readAt: now,
    version: status.version,
    total: stats.total,
    inboxCount: stats.inbox,
    counts: stats.counts,
    database: status.database,
    pending: status.pending,
    inbox: inbox.docs.map(({ correspondentId, ...d }) => ({
      ...d,
      correspondent: correspondentId !== null ? (names.get(correspondentId) ?? null) : null,
    })),
    failed: failed.failed,
    failedCount: failed.count,
    storage: status.storage,
    checks: status.checks,
    update: parseRemote(fixture('paperless-remote-version.json')),
    ...over,
  };
}

const view = (s: PaperlessSnapshot, more?: PaperlessMore | null) =>
  checked(
    paperlessView({
      snapshot: s,
      now,
      timeZone: TZ,
      url,
      buttons: { row: manageRow },
      picture: fakePicture,
      more,
    }),
  );
const card = (s: PaperlessSnapshot, key: string) => figures(s, now).find((k) => k.key === key);
const H = 3600_000;

describe('reading Paperless-ngx (SD-56)', () => {
  it('reads statistics, the inbox and its correspondents', () => {
    expect(parseStatistics(fixture('paperless-statistics.json'))).toEqual({
      total: 3,
      inbox: 3,
      counts: { correspondents: 1, tags: 1, types: 0, paths: 0 },
    });
    const inbox = parseInbox(fixture('paperless-inbox.json'));
    expect(inbox.count).toBe(3);
    expect(inbox.docs.map((d) => [d.id, d.correspondentId])).toEqual([
      [3, null],
      [2, null],
      [1, 1],
    ]);
    expect(parseNames(fixture('paperless-correspondents.json')).get(1)).toBe('Energy company');
  });

  it('reads failed imports in API 10’s shape and API 9’s', () => {
    const v10 = parseFailed(fixture('paperless-tasks-failed.json'));
    const v9 = parseFailed(fixture('paperless-tasks-failed-v9.json'));
    for (const f of [v10, v9]) {
      expect(f.count).toBe(1);
      expect(f.failed[0]).toMatchObject({ id: 3, file: 'scan-broken.pdf' });
      expect(f.failed[0]?.error).toContain('InputFileError');
      expect(f.failed[0]?.at?.toISOString()).toBe('2026-10-21T19:44:00.546Z');
    }
    expect(pageOf([1, 2]).count).toBe(2);
    // A failed sanity check isn't an import.
    expect(
      parseFailed({ count: 1, results: [{ id: 9, task_type: 'sanity_check', status: 'failure' }] }).failed,
    ).toEqual([]);
  });

  it('reads its status: version, disk and the checks it runs (DISABLED left out)', () => {
    const s = parseStatus(fixture('paperless-status.json'));
    expect(s.version).toBe('3.3.3');
    expect(s.storage?.total).toBeGreaterThan(s.storage?.available ?? Infinity);
    expect(s.checks?.map((c) => [c.key, c.status])).toEqual([
      ['database', 'OK'],
      ['redis', 'OK'],
      ['celery', 'OK'],
      ['index', 'OK'],
      ['classifier', 'WARNING'],
      ['sanity', 'OK'],
    ]);
    expect([s.database, s.pending]).toEqual(['SQLite', 0]);
    // 3.4.2's statistics count the same way.
    expect(parseStatistics(fixture('paperless-statistics-3.4.json')).counts).toEqual({
      correspondents: 3,
      tags: 1,
      types: 0,
      paths: 0,
    });
    expect(parseRemote(fixture('paperless-remote-version.json'))).toEqual({
      available: false,
      version: '3.3.3',
    });
    expect(parseRemote({ version: '0.0.0', update_available: false })).toBeNull();
  });

  it('asks for failed tasks in capitals when an older Paperless refuses lower case', async () => {
    forgetKindReads(fakeServices(now));
    const { StatusProblem } = await import('./net');
    net.readJson.mockImplementation(
      async (_s, _r, _n, req: { path: string; query?: Record<string, string> }) => {
        if (req.path === '/api/tasks/') {
          if (req.query?.status === 'failure') throw new StatusProblem('error', 400);
          return fixture('paperless-tasks-failed-v9.json');
        }
        if (req.path === '/api/statistics/') return fixture('paperless-statistics.json');
        if (req.path === '/api/documents/') return fixture('paperless-inbox.json');
        if (req.path === '/api/correspondents/') return fixture('paperless-correspondents.json');
        if (req.path === '/api/status/') return fixture('paperless-status.json');
        if (req.path === '/api/remote_version/') return fixture('paperless-remote-version.json');
        throw new StatusProblem('missing', 404);
      },
    );
    const s = await readPaperless(fakeServices(now), row, now);
    expect(s.failedCount).toBe(1);
    expect(s.inbox.find((d) => d.id === 1)?.correspondent).toBe('Energy company');
    expect(s.version).toBe('3.3.3');
    net.readJson.mockReset();
  });
});

describe('Paperless-ngx’s slower part (3.4.2, recorded 2026-11-04)', () => {
  it('reads when documents were added, and the busiest correspondents', () => {
    const added = parseAdded(fixture('paperless-documents-added.json'));
    expect(added.at).toHaveLength(5);
    expect(added.complete).toBe(true);
    expect(parseAdded({ count: 900, results: [{ id: 1, added: '2026-11-04T10:00:00Z' }] }).complete).toBe(
      false,
    );
    expect(parseSenders(fixture('paperless-correspondents-top.json'))).toEqual([
      { name: 'City council', documents: 2, last: new Date('2026-11-04') },
      { name: 'Bank', documents: 2, last: new Date('2026-11-04') },
      { name: 'Energy company', documents: 1, last: new Date('2026-11-04') },
    ]);
  });

  it('asks for filed documents, the last 15 days and the busiest correspondents, with the filed ones’ names', async () => {
    const asked: { path: string; query?: Record<string, string> }[] = [];
    net.readJson.mockImplementation(
      async (_s, _r, _n, req: { path: string; query?: Record<string, string> }) => {
        asked.push(req);
        if (req.query?.is_in_inbox === 'false') return fixture('paperless-filed.json');
        if (req.query?.added__date__gt) return fixture('paperless-documents-added.json');
        if (req.query?.ordering === '-document_count') return fixture('paperless-correspondents-top.json');
        if (req.query?.id__in) return fixture('paperless-correspondents-top.json');
        throw new Error(`unexpected ${req.path}`);
      },
    );
    const more = await readPaperlessMore(fakeServices(now), row, now, TZ);
    expect(asked.find((q) => q.query?.added__date__gt)?.query?.added__date__gt).toBe('2026-10-06');
    expect(asked.find((q) => q.query?.id__in)?.query?.id__in).toBe('3,2');
    expect(more.filed?.map((d) => [d.id, d.correspondent])).toEqual([
      [2, 'Bank'],
      [1, 'City council'],
    ]);
    expect(more.senders?.map((x) => x.name)).toEqual(['City council', 'Bank', 'Energy company']);
    net.readJson.mockReset();
  });
});

describe('Paperless-ngx’s page in slots (SD-56, service-slots.md)', () => {
  const more = (): PaperlessMore => ({
    filed: [
      { id: 7, title: 'Water bill', correspondent: 'Water company', added: new Date(now.getTime() - 26 * H) },
      { id: 6, title: 'Car insurance', correspondent: null, added: new Date(now.getTime() - 50 * H) },
    ],
    // Two this week (today and three days ago), one the week before.
    added: {
      at: [
        new Date(now.getTime() - 2 * H),
        new Date(now.getTime() - 72 * H),
        new Date(now.getTime() - 200 * H),
      ],
      complete: true,
    },
    senders: [
      { name: 'Energy company', documents: 84, last: new Date('2026-10-20') },
      { name: 'City council', documents: 12, last: null },
    ],
  });

  it('fills the slots: the inbox live, the counts, filed lately, the week, who sends, the machine lines', () => {
    const v = view(snapshot(), more());
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    expect(v.panels.map((p) => p.id)).toEqual([
      'inbox',
      'library',
      'filed',
      'week',
      'people',
      'failed',
      'checks',
    ]);
    expect(panel(v, 'inbox', 'gallery')?.meta).toBe('3 waiting · oldest 16 min ago');
    expect(panel(v, 'library', 'list')?.items.map((x) => [x.id, x.figure?.value, x.figure?.note])).toEqual([
      ['documents', '3', '+2 this week'],
      ['correspondents', '1', undefined],
      ['tags', '1', undefined],
    ]);
    const filed = panel(v, 'filed', 'gallery');
    expect(filed?.items.map((i) => [i.id, i.sub])).toEqual([
      ['doc-7', 'Water company · added yesterday 20:00'],
      ['doc-6', 'added 19 Oct'],
    ]);
    expect(picturePath(filed?.items[0]?.image)).toBe('/api/documents/7/thumb/');
    const week = panel(v, 'week', 'chart');
    expect(week?.series[0]?.values).toEqual([0, 0, 0, 1, 0, 0, 1]);
    expect(week?.figure).toEqual({ value: '2', rest: 'added this week' });
    expect(week?.stats?.[0]?.[0]?.text).toBe('+100 %');
    const who = panel(v, 'people', 'bars');
    expect(who?.items.map((b) => [b.label, b.value, b.note])).toEqual([
      ['Energy company', '84 documents', 'Newest 20 Oct'],
      ['City council', '12 documents', undefined],
    ]);
    expect(v.slots?.machine.map((b) => [b.id, b.sub])).toEqual([
      ['paperless-version', 'Up to date'],
      ['documents-disk', expect.stringMatching(/free$/)],
      ['database', undefined],
    ]);
    expect(panel(v, 'checks', 'list')?.place).toBe('main');
  });

  it('keeps the card’s figures though the page has none', () => {
    expect(figures(snapshot(), now).map((k) => k.key)).toEqual(['documents', 'inbox', 'failed', 'free']);
    expect(card(snapshot(), 'documents')?.value).toBe('3');
    expect(card(snapshot(), 'failed')).toMatchObject({ value: '1', tone: 'warn' });
    expect(card(snapshot(), 'free')?.meter).toBeLessThan(0.1);
  });

  it('leaves out what the slower read couldn’t say, and says when more came than it read', () => {
    const v = view(snapshot({ failed: [], failedCount: 0 }));
    expect(slotProblems(v)).toEqual([]);
    expect(v.panels.map((p) => p.id)).toEqual(['inbox', 'library', 'checks']);
    const busy = view(snapshot(), { ...more(), added: { at: more().added?.at ?? [], complete: false } });
    expect(panel(busy, 'week', 'chart')?.figure?.value).toBe('2+');
    expect(panel(busy, 'week', 'chart')?.stats).toBeUndefined();
    expect(panel(busy, 'library', 'list')?.items[0]?.figure?.note).toBeUndefined();
  });

  it('lists the inbox newest first with correspondents, and failed imports with why', () => {
    const v = view(snapshot());
    const inbox = panel(v, 'inbox', 'gallery');
    expect(inbox?.look).toBe('rows');
    expect(inbox?.shape).toBe('square');
    expect(inbox?.items.map((i) => i.id)).toEqual(['doc-3', 'doc-2', 'doc-1']);
    expect(inbox?.items[2]?.sub).toContain('Energy company');
    expect(picturePath(inbox?.items[0]?.image)).toBe('/api/documents/3/thumb/');
    expect(inbox?.items[0]?.url).toBe(`${url}/documents/3/details`);
    const failed = panel(v, 'failed', 'table');
    expect(failed?.rows.map((r) => r.id)).toEqual(['3']);
    expect(failed?.rows[0]?.cells.seen?.action).toMatchObject({ action: 'seen', target: '3', allowed: true });
    expect(failed?.rows[0]?.cells.why?.text).toBe(
      whyWords('scan-broken.pdf: InputFileError: ', 'scan-broken.pdf'),
    );
    const checks = panel(v, 'checks', 'list');
    expect(checks?.items.map((i) => [i.id, i.tone])).toContainEqual(['classifier', 'info']);
  });

  it('says what is wrong: failed imports, a check’s error, the disk, an update', () => {
    const quiet = view(snapshot({ failed: [], failedCount: 0 }));
    expect(quiet.notices).toEqual([]);
    expect(quiet.status?.status).toBe('ok');

    const s = snapshot({
      checks: [
        { key: 'celery', status: 'ERROR', error: 'No celery workers', at: null },
        { key: 'sanity', status: 'ERROR', error: 'Checksum mismatch of document 4', at: now },
        { key: 'classifier', status: 'WARNING', error: 'No classifier training tasks found', at: null },
      ],
      storage: { total: 100e9, available: 3e9 },
      update: { available: true, version: '3.4.0' },
    });
    const v = view(s);
    expect(v.notices.map((n) => [n.id, n.tone])).toEqual([
      ['check-worker', 'bad'],
      ['storage', 'bad'],
      ['failed-3', 'warn'],
      ['check-sanity', 'warn'],
      ['update', 'info'],
    ]);
    expect(v.status?.status).toBe('bad');
  });

  it('offers Run sanity check on its line and on Paperless’s checks', () => {
    const s = snapshot({ checks: [{ key: 'sanity', status: 'ERROR', error: 'Checksum mismatch', at: now }] });
    const manager = view(s);
    expect(manager.notices.find((n) => n.id === 'check-sanity')?.action).toMatchObject({
      action: 'sanity',
      allowed: true,
    });
    expect(panel(manager, 'checks', 'list')?.buttons?.map((b) => b.action)).toEqual(['sanity']);
  });

  it('gives a fresh install’s “never ran” checks no warning', () => {
    const fresh = parseStatus(fixture('paperless-status-fresh.json'));
    const v = view(snapshot({ checks: fresh.checks, failed: [], failedCount: 0 }));
    expect(v.notices).toEqual([]);
    expect(checkItem(fresh.checks?.find((c) => c.key === 'sanity') as never, now)).toMatchObject({
      right: 'Not yet',
      detail: 'Never ran',
    });
  });

  it('words why an import failed', () => {
    expect(whyWords('a.pdf: Not consuming a.pdf: It is a duplicate of b (#12)', 'a.pdf')).toBe(
      'It’s already in Paperless',
    );
    expect(whyWords(null, 'a.pdf')).toContain('didn’t say');
    expect(whyWords('a.pdf: Something odd', 'a.pdf')).toBe('Something odd');
  });
});

describe('what Whombat watches on Paperless-ngx (QN-01…QN-04)', () => {
  const lines = (s: PaperlessSnapshot) => view(s).notices as KindNotice[];
  const failure = (id: number, error: string) => ({ id, file: `scan-${id}.pdf`, error, at: now });

  it('gives every line its check, nature and Ignore, from the list of checks', () => {
    const s = snapshot({
      checks: [
        { key: 'database', status: 'ERROR', error: 'gone', at: null },
        { key: 'index', status: 'ERROR', error: 'locked', at: null },
        { key: 'classifier', status: 'ERROR', error: 'too few documents', at: now },
        { key: 'sanity', status: 'ERROR', error: 'Checksum mismatch', at: now },
      ],
      storage: { total: 100e9, available: 10e9 },
      update: { available: true, version: '3.4.0' },
    });
    const all = lines(s);
    const checks = new Set(PAPERLESS_CHECKS.map((c) => c.check));
    for (const n of all) {
      expect(checks.has(n.check)).toBe(true);
      expect(n.ignore?.words).toMatch(/^Until .*\.$/);
      if (n.badge) expect(n.badge.length).toBeLessThanOrEqual(40);
    }
    const byId = (id: string) => all.find((n) => n.id === id);
    expect(byId('check-database')).toMatchObject({ subject: { id: 'database' }, nature: 'problem' });
    expect(byId('check-database')?.link?.kind).toBe('ask');
    expect(byId('check-classifier')).toMatchObject({ nature: 'fyi', tone: 'info' });
    expect(byId('check-sanity')).toMatchObject({ episode: now.toISOString(), ignore: { lifts: 'newer' } });
    expect(byId('update')).toMatchObject({ nature: 'fyi', episode: '3.4.0' });
    expect(byId('storage')).toMatchObject({ check: 'paperless.disk_full', band: 85, nature: 'problem' });
  });

  it('says the worker isn’t running once, when Redis and the worker both fail', () => {
    const s = snapshot({
      checks: [
        { key: 'redis', status: 'ERROR', error: 'Connection refused', at: null },
        { key: 'celery', status: 'ERROR', error: 'No celery workers', at: null },
      ],
    });
    const worker = lines(s).filter((n) => n.check === 'paperless.health');
    expect(worker.map((n) => [n.id, n.subject?.id])).toEqual([['check-worker', 'worker']]);
  });

  it('makes one line per failed import for a person, a duplicate a heads-up, Mark seen on each', () => {
    const s = snapshot({
      failed: [
        failure(7, 'scan-7.pdf: Not consuming scan-7.pdf: It is a duplicate of x (#2)'),
        failure(8, 'scan-8.pdf: InputFileError'),
      ],
      failedCount: 2,
    });
    const imports = lines(s).filter((n) => n.check === 'paperless.import_failed');
    expect(imports.map((n) => [n.subject?.id, n.nature, n.tone])).toEqual([
      ['import:8', 'you', 'warn'],
      ['import:7', 'fyi', 'info'],
    ]);
    expect(imports[0]?.action).toMatchObject({ action: 'seen', target: '8' });
    expect(imports[0]?.link?.kind).toBe('url');
  });

  it('puts imports past three on one line counting those not read, and skips the check when capped', () => {
    const failed = Array.from({ length: 25 }, (_, i) => failure(100 + i, 'x: InputFileError'));
    const s = snapshot({ failed, failedCount: 40 });
    const imports = lines(s).filter((n) => n.check === 'paperless.import_failed');
    expect(imports).toHaveLength(3);
    expect(imports[2]).toMatchObject({
      subject: { id: '+more', name: '38 more' },
      ignore: { lifts: 'newer' },
    });
    expect(paperlessSkipped(s)).toContain('paperless.import_failed');
    expect(paperlessSkipped(snapshot())).toEqual([]);
    expect(paperlessSkipped(snapshot({ checks: null, storage: null }))).toEqual([
      'paperless.health',
      'paperless.classifier',
      'paperless.disk_full',
    ]);
  });
});

describe('Paperless-ngx’s buttons (SD-07, SD-08)', () => {
  const ctx = { services: fakeServices(now), row, now, timeZone: TZ };

  beforeEach(() => {
    forgetKindReads(ctx.services);
    net.readJson.mockImplementation(async (_s, _r, _n, req: { path: string }) => {
      const answers: Record<string, string> = {
        '/api/statistics/': 'paperless-statistics.json',
        '/api/documents/': 'paperless-inbox.json',
        '/api/tasks/': 'paperless-tasks-failed.json',
        '/api/status/': 'paperless-status.json',
        '/api/remote_version/': 'paperless-remote-version.json',
        '/api/correspondents/': 'paperless-correspondents.json',
      };
      return fixture(answers[req.path] as string);
    });
  });
  afterEach(() => {
    net.readJson.mockReset();
    net.actAs.mockReset();
  });

  it('marks a failed import seen, everyday, and only one that is failed', async () => {
    net.actAs.mockResolvedValue({ status: 200, json: fixture('paperless-ack.json') });
    const out = await markSeen(ctx, { target: '3' });
    expect(net.actAs.mock.calls[0]?.[3]).toEqual({
      method: 'POST',
      path: '/api/tasks/acknowledge/',
      body: { tasks: [3] },
    });
    expect(out.everyday).toBe(true);
    expect(out.title).toContain('scan-broken.pdf');
    await expect(markSeen(ctx, { target: '99' })).rejects.toThrow();
    await expect(markSeen(ctx, { target: 'x' })).rejects.toThrow();
    expect(net.actAs).toHaveBeenCalledTimes(1);
  });

  it('runs the sanity check, with 2.x’s task name when API 10’s is refused', async () => {
    const { ApiError } = await import('../../../lib/errors');
    net.actAs
      .mockRejectedValueOnce(new ApiError('unavailable', 'answered with an error'))
      .mockResolvedValueOnce({ status: 200, json: fixture('paperless-run.json') });
    const out = await runSanityCheck(ctx, {});
    expect(net.actAs.mock.calls.map((c) => c[3].body)).toEqual([
      { task_type: 'sanity_check' },
      { task_name: 'check_sanity' },
    ]);
    expect(out.everyday).toBe(true);
    // A refusal isn't tried again.
    net.actAs.mockRejectedValueOnce(new ApiError('forbidden', 'refused'));
    await expect(runSanityCheck(ctx, {})).rejects.toThrow(/refused/);
    expect(net.actAs).toHaveBeenCalledTimes(3);
  });
});
