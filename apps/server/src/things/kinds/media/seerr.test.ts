/**
 * Seerr's page and card from recorded answers (SD-21, SD-04, SD-10): requests waiting, in progress with Seerr's
 * download status, failed, issues, versions, and what each button sends. Pure, with a fake connection fetch.
 */
import type { ThingGalleryItem, ThingPagePanel } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { forgetKindReads } from '../read';
import { seenFromView } from '../registry';
import { slotProblems } from '../slots';
import {
  downloadOf,
  parseIssue,
  parseRequests,
  parseTitle,
  REQUESTS_READ,
  requestState,
  SEERR_ACTIONS,
  SEERR_CHECKS,
  SEERR_KIND,
  type SeerrInput,
  type SeerrRequest,
  type SeerrSnapshot,
  type SeerrTitle,
  seasonsWords,
  seerrKpis,
  seerrMachineLines,
  seerrNotices,
  seerrSkipped,
  seerrView,
  seerrWeek,
  titleKey,
  versionOf,
} from './seerr';
import { fixture, rowOf } from './testing';

const http = vi.hoisted(() => ({
  answer: (_call: { method: string; url: URL }): { status?: number; json?: unknown } => ({ json: {} }),
  calls: [] as { method: string; url: URL }[],
}));
vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (_s: unknown, _r: unknown, req: { method: string; url: string }) => {
      const call = { method: req.method, url: new URL(req.url) };
      http.calls.push(call);
      const a = http.answer(call);
      return { status: a.status ?? 200, headers: {}, body: Buffer.from(JSON.stringify(a.json ?? null)) };
    },
  };
});

// A minute after the recorded answers: Inside Out 2's download was still running then.
const now = new Date('2026-10-21T19:46:00Z');
const TZ = 'Europe/Amsterdam';
const row = rowOf('overseerr');
const services = {
  clock: () => now,
  custody: { mac: () => Buffer.alloc(32, 7).toString('base64url') },
} as unknown as Services;
const ctx = { services, row, now };

function snapshot(more: Partial<SeerrSnapshot> = {}): SeerrSnapshot {
  const titles = new Map<string, SeerrTitle>();
  for (const [key, file] of [
    [titleKey('movie', 969681), 'seerr-movie.json'],
    [titleKey('tv', 4614), 'seerr-tv.json'],
  ] as const) {
    const t = parseTitle(fixture(file));
    if (t) titles.set(key, t);
  }
  const status = fixture<Record<string, unknown>>('seerr-status.json');
  const count = fixture<Record<string, number>>('seerr-count.json');
  const failed = parseRequests(fixture('seerr-failed.json'), now);
  return {
    readAt: now,
    version: status.version as string,
    updateAvailable: false,
    commitsBehind: 0,
    restartRequired: false,
    counts: {
      total: count.total ?? null,
      pending: count.pending ?? null,
      processing: count.processing ?? null,
      available: 0,
      declined: count.declined ?? null,
    },
    pending: parseRequests(fixture('seerr-pending.json'), now).items,
    processing: parseRequests(fixture('seerr-processing.json'), now).items,
    failed: failed.items,
    failedTotal: failed.total,
    available: parseRequests(fixture('seerr-available.json'), now).items,
    issues: (fixture<{ results: unknown[] }>('seerr-issues.json').results.map(parseIssue) as never[]).filter(
      Boolean,
    ),
    openIssues: fixture<{ open: number }>('seerr-issue-count.json').open,
    unreachable: parseRequests(fixture('seerr-available.json'), now).unreachable,
    titles,
    ...more,
  };
}

function input(s: SeerrSnapshot, more: Partial<SeerrInput> = {}): SeerrInput {
  return {
    snapshot: s,
    now,
    timeZone: TZ,
    who: { row },
    url: 'http://192.0.2.10:5055',
    sabnzbd: { href: '/things/connection%3Acon_sab', name: 'SABnzbd' },
    recent: parseRequests(fixture('seerr-all.json'), now, REQUESTS_READ).items,
    ...more,
  };
}

const panel = (panels: ThingPagePanel[], id: string) => panels.find((p) => p.id === id);
const gallery = (panels: ThingPagePanel[], id: string): ThingGalleryItem[] => {
  const p = panel(panels, id);
  return p?.kind === 'gallery' ? p.items : [];
};

describe('reading Seerr 3.5 (recorded)', () => {
  it('reads requests: who asked, the seasons, and Seerr’s download status', () => {
    const pending = parseRequests(fixture('seerr-pending.json'), now).items;
    expect(pending.map((r) => [r.id, r.type, r.by])).toEqual([
      [2, 'movie', 'Ben'],
      [1, 'movie', 'Anna'],
    ]);
    const [inside] = parseRequests(fixture('seerr-processing.json'), now).items;
    expect(inside?.downloads[0]?.title).toBe('Inside.Out.2.2024.1080p.WEB.h264-GRP');
    expect(inside?.downloads[0]?.sizeBytes).toBe(2306867);
    const [ncis] = parseRequests(fixture('seerr-failed.json'), now).items;
    expect(ncis?.seasons).toEqual([24]);
  });

  it('notices which Sonarr or Radarr Seerr can’t reach', () => {
    expect(parseRequests(fixture('seerr-available.json'), now).unreachable).toEqual(['Sonarr']);
  });

  it('takes only the title, the year and a poster path that names a TMDB file', () => {
    expect(parseTitle(fixture('seerr-movie.json'))).toEqual({
      title: 'Spider-Man: Brand New Day',
      year: '2026',
      poster: '/bjiS5ipwxb9JFy3XRRN4OAilSeX.jpg',
    });
    expect(parseTitle({ title: 'X', posterPath: 'https://evil/x.jpg' })?.poster).toBeNull();
  });

  it('reads issues with their kind and first comment', () => {
    const issues = fixture<{ results: unknown[] }>('seerr-issues.json').results.map(parseIssue);
    expect(issues.map((i) => [i?.kind, i?.type, i?.season])).toEqual([
      [3, 'movie', null],
      [1, 'tv', 24],
    ]);
  });
});

describe('the page (SD-21)', () => {
  it('shows Waiting for you, In progress, Available this week and Open issues', () => {
    const kpis = seerrKpis(input(snapshot()));
    expect(kpis.map((k) => [k.key, k.value])).toEqual([
      ['waiting', '2'],
      ['progress', '1'],
      ['available', '0'],
      ['issues', '2'],
    ]);
  });

  it('offers Approve and a confirmed Decline on each request waiting', () => {
    const view = seerrView(input(snapshot()), ctx);
    const waiting = gallery(view.panels, 'pending');
    expect(waiting.map((i) => i.id)).toEqual(['2', '1']);
    expect(waiting[0]?.title).toBe('Spider-Man: Brand New Day');
    expect(waiting[0]?.actions?.map((b) => [b.action, b.target, !!b.confirm])).toEqual([
      ['approve', '2', false],
      ['decline', '2', true],
    ]);
    // A title Seerr hasn't told yet: plain words, no picture.
    expect(waiting[1]?.title).toBe('A movie');
    expect(waiting[1]?.image).toBeUndefined();
  });

  it('names who asked, and when', () => {
    const pending = gallery(seerrView(input(snapshot()), ctx).panels, 'pending');
    expect(pending[0]?.person?.name).toBe('Ben');
    expect(pending[0]?.person?.note).toMatch(/^asked .+ ago$/);
    expect(pending[0]?.sub).toBe('Film · 2026');
  });

  it('shows a download’s progress and who asked, and links it to SABnzbd’s page (SD-10)', () => {
    const [inside] = gallery(seerrView(input(snapshot()), ctx).panels, 'progress');
    expect(inside?.progress).toBe(0);
    expect(inside?.note).toMatch(/^Downloading 0 %/);
    expect(inside?.href).toBe('/things/connection%3Acon_sab');
    expect(inside?.person?.name).toBe('Ben');
    const without = gallery(seerrView(input(snapshot(), { sabnzbd: null }), ctx).panels, 'progress');
    expect(without[0]?.href).toBeUndefined();
  });

  it('adds up a series’ downloads and says how long is left', () => {
    const r = {
      ...(parseRequests(fixture('seerr-processing.json'), now).items[0] as SeerrRequest),
      downloads: [
        {
          title: 'a',
          sizeBytes: 100,
          leftBytes: 20,
          eta: new Date(now.getTime() + 12 * 60_000),
          status: 'downloading',
        },
        { title: 'b', sizeBytes: 100, leftBytes: 54, eta: null, status: 'downloading' },
      ],
    };
    expect(downloadOf(r, now)).toEqual({
      progress: 0.63,
      note: '63 % · 12 min left',
      done: '63 %',
      left: '12 min left',
    });
  });

  it('lists failed requests with Retry and issues with Mark resolved', () => {
    const view = seerrView(input(snapshot()), ctx);
    expect(gallery(view.panels, 'failed')[0]?.actions?.[0]).toMatchObject({ action: 'retry', target: '3' });
    const issues = panel(view.panels, 'issues');
    expect(issues?.kind === 'list' && issues.items.map((i) => i.actions?.[0]?.action)).toEqual([
      'resolve',
      'resolve',
    ]);
  });

  it('says what is worth a look: Sonarr out of reach, a failed request with Retry', () => {
    const n = seerrNotices(input(snapshot()));
    expect(n.map((x) => [x.check, x.subject?.id, x.tone])).toEqual([
      ['overseerr.unreachable', 'server:Sonarr', 'warn'],
      ['overseerr.failed', 'request:3', 'warn'],
    ]);
    expect(n[1]?.action).toMatchObject({ action: 'retry', target: '3' });
  });

  it('knows Overseerr and Jellyseerr, warns before Seerr 3.4, and says when an update waits', () => {
    const ids = (version: string, more: Partial<SeerrSnapshot> = {}) =>
      seerrNotices(input(snapshot({ version, unreachable: [], failed: [], failedTotal: 0, ...more }))).map(
        (n) => [n.id, n.tone, n.nature],
      );
    expect(ids('1.33.2')).toEqual([['moved', 'info', 'fyi']]);
    expect(ids('2.7.3')).toEqual([['moved', 'info', 'fyi']]);
    expect(ids('3.2.0')).toEqual([['security', 'warn', 'you']]);
    expect(ids('3.5.1')).toEqual([]);
    expect(ids('3.5.1', { updateAvailable: true, commitsBehind: 4 })).toEqual([['update', 'info', 'fyi']]);
    expect(versionOf('v3.4.0')).toEqual([3, 4, 0]);
  });

  it('warns about issues open for over a week', () => {
    const old = snapshot().issues.map((i) => ({ ...i, at: new Date(now.getTime() - 9 * 86_400_000) }));
    const lines = seerrNotices(input(snapshot({ issues: old }))).filter(
      (n) => n.check === 'overseerr.issues',
    );
    expect(lines.length).toBe(old.length);
    expect(lines[0]).toMatchObject({ tone: 'warn', nature: 'you', link: { kind: 'url' } });
    expect(lines[0]?.subject?.id).toBe(`issue:${old[0]?.id}`);
  });

  it('words seasons', () => {
    expect([seasonsWords([24]), seasonsWords([1, 2, 3]), seasonsWords([1, 3]), seasonsWords([])]).toEqual([
      'Season 24',
      'Seasons 1–3',
      'Seasons 1, 3',
      null,
    ]);
  });

  it('gives the card Waiting for you and In progress, yellow while something is wrong (SD-05)', () => {
    const glance = seenFromView({
      kpis: seerrKpis(input(snapshot())),
      notices: seerrNotices(input(snapshot())),
    });
    expect(glance.status).toBe('warn');
    expect(glance.reason).toContain('Sonarr');
  });
});

describe('in slots (service-slots.md)', () => {
  const view = () => seerrView(input(snapshot()), ctx);
  const counts = () => {
    const p = panel(view().panels, 'requests');
    return p?.kind === 'list' ? p : null;
  };

  it('keeps the slots: waiting, requests, just available, this week, who asks, then its own panels', () => {
    expect(panel(view().panels, 'progress')).toMatchObject({ kind: 'gallery', look: 'rows', place: 'main' });
    const v = view();
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    expect(v.panels.map((p) => p.id)).toEqual([
      'pending',
      'requests',
      'available',
      'week',
      'people',
      'progress',
      'failed',
      'issues',
    ]);
  });

  it('shows what waits as rows with Approve and Decline, how many and how old', () => {
    const p = panel(view().panels, 'pending');
    expect(p).toMatchObject({ kind: 'gallery', look: 'rows', title: 'Waiting for you' });
    expect(p?.kind === 'gallery' && p.meta).toMatch(/^2 requests · oldest /);
    expect(gallery(view().panels, 'pending')[0]?.actions?.map((b) => b.action)).toEqual([
      'approve',
      'decline',
    ]);
  });

  it('counts the requests by state with what changed this week', () => {
    const lines = counts()?.items ?? [];
    expect(lines.map((i) => [i.id, i.figure?.value, i.figure?.note])).toEqual([
      ['all', '4', '+4 this week'],
      ['progress', '1', '+1 this week'],
      ['available', '0', 'Nothing new'],
      ['declined', '0', 'Nothing new'],
      ['failed', '1', undefined],
      ['issues', '2', '+2 this week'],
    ]);
    expect(lines[0]?.detail).toBe('2 waiting for you');
    expect(lines[1]?.detail).toBe('1 downloading');
  });

  it('leaves the week’s change out while the newest requests don’t reach back a week', () => {
    const full = Array.from({ length: REQUESTS_READ }, (_, k) => ({
      ...(snapshot().pending[0] as SeerrRequest),
      id: 1000 + k,
    }));
    const lines = (() => {
      const p = panel(seerrView(input(snapshot(), { recent: full }), ctx).panels, 'requests');
      return p?.kind === 'list' ? p.items : [];
    })();
    expect(lines[0]?.figure?.note).toBeUndefined();
  });

  it('puts what just became available on the shelf with who asked', () => {
    const available = parseRequests(fixture('seerr-processing.json'), now).items.map((r) => ({
      ...r,
      mediaStatus: 5,
      updatedAt: new Date(now.getTime() - 3_600_000),
    }));
    const v = seerrView(input(snapshot({ available })), ctx);
    const p = panel(v.panels, 'available');
    expect(p).toMatchObject({ kind: 'gallery', look: 'shelf', meta: '1 this week' });
    expect(gallery(v.panels, 'available')[0]?.person).toEqual({ name: 'Ben', note: 'Ben asked' });
  });

  it('draws this week’s requests per day and who asks, films and series apart', () => {
    const p = panel(view().panels, 'week');
    expect(p?.kind === 'chart' && p.series[0]?.values).toEqual([0, 0, 0, 0, 0, 0, 4]);
    expect(p?.kind === 'chart' && p.labels?.at(-1)).toBe('Today');
    expect(p?.kind === 'chart' && p.figure).toEqual({ value: '4', rest: 'requests this week' });
    const who = panel(view().panels, 'people');
    expect(who?.kind === 'bars' && who.items.map((i) => [i.label, i.value, i.note])).toEqual([
      ['Anna', '2 requests', '1 film · 1 series'],
      ['Ben', '2 requests', '2 films'],
    ]);
  });

  it('says the change on the week before, once the read reaches back past it', () => {
    const one = snapshot().pending[0] as SeerrRequest;
    const ago = (days: number) => ({ ...one, at: new Date(now.getTime() - days * 86_400_000) });
    const week = seerrWeek([ago(0), ago(1), ago(2), ago(9), ago(20)], now, TZ);
    expect(week.trend.stats?.[0]?.[0]?.text).toBe('+200 %');
    expect(seerrWeek([ago(0)], now, TZ).trend.stats).toBeUndefined();
  });

  it('leaves Trend and People out when the week wasn’t read', () => {
    const ids = seerrView(input(snapshot(), { recent: null }), ctx).panels.map((p) => p.id);
    expect(ids).not.toContain('week');
    expect(ids).not.toContain('people');
  });

  it('tells where a request stands', () => {
    const r = snapshot().pending[0] as SeerrRequest;
    expect(
      [
        r,
        { ...r, status: 2, mediaStatus: 3 },
        { ...r, status: 2, mediaStatus: 5 },
        { ...r, status: 3 },
        { ...r, status: 4 },
      ].map(requestState),
    ).toEqual(['pending', 'progress', 'available', 'declined', 'failed']);
  });

  it('gives the machine card its version, and whether an update waits', () => {
    expect(seerrMachineLines(snapshot())).toEqual([
      { id: 'seerr-version', label: 'Seerr', value: '3.5.1', pct: null, sub: 'Up to date', subTone: 'ok' },
    ]);
    expect(seerrMachineLines(snapshot({ updateAvailable: true, commitsBehind: 3 }))[0]?.sub).toBe(
      '3 changes behind',
    );
    expect(seerrMachineLines(snapshot({ version: '2.7.3' }))[0]?.label).toBe('Overseerr');
  });
});

describe('the buttons (SD-07)', () => {
  const actx = { services, row, now, timeZone: TZ };
  const requests: Record<string, unknown> = {
    '2': fixture<{ results: unknown[] }>('seerr-pending.json').results[0],
    '3': fixture<{ results: unknown[] }>('seerr-failed.json').results[0],
    '4': fixture<{ results: unknown[] }>('seerr-processing.json').results[0],
  };
  beforeEach(() => {
    http.calls = [];
    forgetKindReads(services);
    http.answer = (call) => {
      const p = call.url.pathname;
      const req = /^\/api\/v1\/request\/(\d+)$/.exec(p);
      if (req && call.method === 'GET')
        return requests[req[1] as string] ? { json: requests[req[1] as string] } : { status: 404 };
      if (p === '/api/v1/movie/969681') return { json: fixture('seerr-movie.json') };
      if (p === '/api/v1/tv/4614') return { json: fixture('seerr-tv.json') };
      if (p === '/api/v1/issue/2')
        return { json: fixture<{ results: unknown[] }>('seerr-issues.json').results[1] };
      if (call.method === 'POST') return { json: {} };
      return { status: 404 };
    };
  });
  const posts = () => http.calls.filter((c) => c.method === 'POST').map((c) => c.url.pathname);

  it('approves a request waiting, and names it for the thing’s Activity', async () => {
    const done = await SEERR_ACTIONS.approve?.(actx, { target: '2' });
    expect(posts()).toEqual(['/api/v1/request/2/approve']);
    expect(done?.title).toContain('Spider-Man: Brand New Day');
    expect(done?.everyday).toBeFalsy();
  });

  it('refuses to approve or decline what isn’t waiting, before asking Seerr', async () => {
    await expect(SEERR_ACTIONS.decline?.(actx, { target: '4' })).rejects.toThrow(/isn’t waiting/);
    await expect(SEERR_ACTIONS.approve?.(actx, { target: 'x' })).rejects.toThrow();
    expect(posts()).toEqual([]);
  });

  it('retries only a failed request', async () => {
    await SEERR_ACTIONS.retry?.(actx, { target: '3' });
    expect(posts()).toEqual(['/api/v1/request/3/retry']);
    await expect(SEERR_ACTIONS.retry?.(actx, { target: '2' })).rejects.toThrow(/hasn’t failed/);
  });

  it('marks an open issue resolved', async () => {
    const done = await SEERR_ACTIONS.resolve?.(actx, { target: '2' });
    expect(posts()).toEqual(['/api/v1/issue/2/resolved']);
    expect(done?.title).toContain('NCIS');
  });

  it('says CSRF protection when Seerr refuses a change', async () => {
    const before = http.answer;
    http.answer = (call) =>
      call.method === 'POST' ? { status: 403, json: { message: 'invalid csrf token' } } : before(call);
    await expect(SEERR_ACTIONS.approve?.(actx, { target: '2' })).rejects.toThrow(/CSRF/);
  });
});

describe('quiet notices (quiet-notices.md QN-01…QN-04, QN-11)', () => {
  it('gives each failed request its own line with Retry and a question, three lines at most', () => {
    const one = snapshot().failed[0] as SeerrRequest;
    const failed = Array.from({ length: 10 }, (_, k) => ({ ...one, id: 100 + k }));
    const n = seerrNotices(input(snapshot({ failed, failedTotal: 10, unreachable: [] })));
    expect(n).toHaveLength(3);
    expect(n[0]).toMatchObject({
      nature: 'problem',
      subject: { id: 'request:100' },
      link: { kind: 'ask' },
      action: { action: 'retry', target: '100' },
      ignore: { lifts: 'fixed' },
    });
    expect(n[2]).toMatchObject({ subject: { id: '+more', name: '8 more' }, ignore: { lifts: 'newer' } });
  });

  it('leaves a restart to you, with where it’s done', () => {
    const [restart] = seerrNotices(
      input(snapshot({ restartRequired: true, unreachable: [], failed: [], failedTotal: 0 })),
    );
    expect(restart).toMatchObject({ check: 'overseerr.restart', nature: 'you', link: { kind: 'url' } });
  });

  it('never decides warn or bad in the head', () => {
    const view = seerrView(input(snapshot()), { services, row, now });
    expect(view.status?.status ?? 'ok').toBe('ok');
  });

  it('says which checks it couldn’t read: its status, a list not read or longer than read', () => {
    expect(seerrSkipped(snapshot())).toEqual([]);
    expect(seerrSkipped(snapshot({ unread: ['status', 'failed', 'issues'] }))).toEqual([
      'overseerr.restart',
      'overseerr.security',
      'overseerr.moved',
      'overseerr.updates',
      'overseerr.failed',
      'overseerr.issues',
    ]);
    expect(seerrSkipped(snapshot({ failedTotal: 30, openIssues: 40 }))).toEqual([
      'overseerr.failed',
      'overseerr.issues',
    ]);
  });

  it('lists every check it can raise', () => {
    expect(SEERR_KIND.checks).toBe(SEERR_CHECKS);
    expect(SEERR_CHECKS.every((c) => c.check.startsWith('overseerr.'))).toBe(true);
  });
});
