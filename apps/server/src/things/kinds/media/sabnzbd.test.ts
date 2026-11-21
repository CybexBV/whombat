/**
 * SABnzbd's page and card from recorded answers (SD-22): the queue, the pause and the speed, failed downloads, warnings
 * and news servers, the disk, and what each button sends. Pure, with a fake connection fetch for the buttons.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { forgetKindReads } from '../read';
import { seenFromView } from '../registry';
import { slotProblems } from '../slots';
import {
  failingServer,
  nextSpeed,
  parseHistory,
  parseQueue,
  parseStats,
  parseWarnings,
  queueMeta,
  SAB_ACTIONS,
  SAB_CHECKS,
  SABNZBD_KIND,
  type SabInput,
  type SabSnapshot,
  type SabStats,
  sabCardView,
  sabKpis,
  sabMachineLines,
  sabNotices,
  sabSkipped,
  sabView,
  sabWeek,
} from './sabnzbd';
import { type FakeAnswer, type FakeCall, fixture, rowOf } from './testing';
import type { Button } from './ui';

const http = vi.hoisted(() => ({
  answer: (_call: { url: URL }): { status?: number; json?: unknown } => ({ json: { status: true } }),
  calls: [] as { method: string; url: URL; body: string | null }[],
}));
vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (
      _s: unknown,
      _r: unknown,
      req: { method: string; url: string; body?: unknown },
    ) => {
      const call = {
        method: req.method,
        url: new URL(req.url),
        body: typeof req.body === 'string' ? req.body : null,
      };
      http.calls.push(call);
      const a = http.answer(call);
      return { status: a.status ?? 200, headers: {}, body: Buffer.from(JSON.stringify(a.json ?? null)) };
    },
  };
});

const now = new Date('2026-10-21T19:50:00Z');
const TZ = 'Europe/Amsterdam';
const row = rowOf('sabnzbd');
const manager = { row };

function snapshot(
  more: Partial<SabSnapshot['queue']> = {},
  rest: Partial<NonNullable<SabSnapshot['rest']>> = {},
): SabSnapshot {
  const failed = parseHistory(fixture('sab-history-failed.json'), 20);
  return {
    readAt: now,
    queue: { ...parseQueue(fixture('sab-queue.json')), ...more },
    rest: {
      failed: failed.slots,
      failedTotal: failed.total,
      recent: parseHistory(fixture('sab-history.json'), 30).slots,
      stats: parseStats(fixture('sab-server-stats.json')),
      warnings: parseWarnings(fixture('sab-warnings.json')),
      ...rest,
    },
  };
}

function input(s: SabSnapshot, more: Partial<SabInput> = {}): SabInput {
  return {
    snapshot: s,
    now,
    timeZone: TZ,
    range: '24h',
    speed: { timestamps: [], values: [] },
    pausedSince: null,
    who: manager,
    url: 'http://192.0.2.10:8080',
    ...more,
  };
}

const buttonsOf = (view: ReturnType<typeof sabView>, id: string) =>
  ((view.panels.find((p) => p.id === id) as unknown as { buttons?: Button[] })?.buttons ?? []) as Button[];

describe('reading SABnzbd 5.1 (recorded)', () => {
  it('reads the queue: slots, the line speed and the binary sizes', () => {
    const q = parseQueue(fixture('sab-queue.json'));
    expect(q.version).toBe('5.1.3');
    expect(q.paused).toBe(false);
    expect(q.slots.map((s) => s.name)).toContain('NCIS.S24E03.1080p.WEB.h264-GRP');
    expect(q.slots[0]?.category).toBe('tv');
    expect(q.slots[0]?.sizeBytes).toBeCloseTo(2.2 * 1024 ** 2, -4);
    // A line speed of 100 MiB/s is set: the Speed button has something to halve.
    expect(q.lineBps).toBe(104857600);
    expect(q.diskTotalBytes).toBeGreaterThan(q.diskFreeBytes ?? 0);
  });

  it('reads a timed pause', () => {
    const q = parseQueue(fixture('sab-queue-paused.json'));
    expect(q.paused).toBe(true);
    expect(q.pauseLeftMs).toBe((29 * 60 + 59) * 1000);
  });

  it('reads a failed download with SABnzbd’s reason, without the address it came from', () => {
    const { slots, total } = parseHistory(fixture('sab-history-failed.json'), 20);
    expect(total).toBe(1);
    expect(slots[0]?.name).toBe('The.Movie.2024.2160p.WEB-DL');
    expect(slots[0]?.why).toMatch(/URL Fetching failed/);
    expect(slots[0]?.retry).toBe(true);
  });

  it('finds the failing news server in its warnings', () => {
    const warnings = parseWarnings(fixture('sab-warnings.json'));
    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(warnings.map((w) => failingServer(w.text)).filter(Boolean)).toContain('127.0.0.1');
    expect(failingServer('Invalid NZB file Broken.Movie.2024.nzb, skipping')).toBeNull();
    // Older SABnzbd: one line per warning.
    expect(
      parseWarnings({ warnings: ['2024-01-01 10:00\nWARNING\nServer news.x.com will be ignored'] })[0]?.text,
    ).toMatch(/news\.x\.com/);
  });
});

describe('the page (SD-22)', () => {
  it('shows Speed, Left, Disk free and This month', () => {
    const kpis = sabKpis(input(snapshot({ speedBps: 42e6 })));
    expect(kpis.map((k) => k.key)).toEqual(['speed', 'left', 'disk', 'month']);
    expect(kpis[0]?.value).toBe('42 MB/s');
    expect(kpis[2]?.meter).toBeGreaterThan(0);
  });

  it('says Paused, and how long a timed pause has left', () => {
    const kpis = sabKpis(input(snapshot({ paused: true, pauseLeftMs: 18 * 60_000 })));
    expect(kpis[0]?.value).toBe('Paused');
    expect(kpis[0]?.tone).toBe('warn');
    expect(kpis[0]?.sub).toMatch(/18 min/);
  });

  it('offers Pause, Pause 30 min and the next speed while it runs; Resume while paused', () => {
    const running = sabView(input(snapshot()));
    expect(buttonsOf(running, 'queue').map((b) => [b.action, b.value])).toEqual([
      ['pause', undefined],
      ['pause30', undefined],
      ['speed', 50],
    ]);
    const paused = sabView(input(snapshot({ paused: true })));
    expect(buttonsOf(paused, 'queue').map((b) => b.action)).toEqual(['resume', 'speed']);
    // Without a line speed SABnzbd ignores a percentage: no Speed button.
    expect(
      buttonsOf(sabView(input(snapshot({ lineBps: null }))), 'queue').map((b) => b.action),
    ).not.toContain('speed');
  });

  it('walks the speed Full → Half → Quarter → Full', () => {
    expect([nextSpeed(100), nextSpeed(50), nextSpeed(25), nextSpeed(0), nextSpeed(null)]).toEqual([
      50, 25, 100, 50, 50,
    ]);
  });

  it('draws the buttons disabled for Look only', () => {
    const look = sabView(input(snapshot(), { who: { row: rowOf('sabnzbd', { access: 'read' }) } }));
    expect(buttonsOf(look, 'queue').every((b) => !b.allowed && b.reason?.includes('Look only'))).toBe(true);
  });

  it('lists failed downloads with Retry, and Retry all asks first', () => {
    const view = sabView(input(snapshot()));
    const failed = view.panels.find((p) => p.id === 'failed') as unknown as {
      rows: { id: string; cells: Record<string, { action?: Button }> }[];
    };
    const retry = failed.rows[0]?.cells.retry?.action;
    expect(retry).toMatchObject({
      action: 'retry',
      target: '2ac817ee-8653-4ecb-8dc1-3271fa38f03c',
      allowed: true,
    });
    expect(buttonsOf(view, 'failed')[0]).toMatchObject({ action: 'retry_all' });
    expect(buttonsOf(view, 'failed')[0]?.confirm).toBeDefined();
  });

  it('says what is worth a look: failed downloads, a failing news server, its warnings', () => {
    const n = sabNotices(input(snapshot()));
    expect(n.map((x) => [x.check, x.nature, x.tone])).toEqual([
      ['sabnzbd.server', 'problem', 'warn'],
      ['sabnzbd.failed', 'fyi', 'info'],
      ['sabnzbd.warnings', 'fyi', 'info'],
    ]);
    expect(n[1]?.action?.action).toBe('retry_all');
    expect(n[2]?.action?.action).toBe('clear_warnings');
  });

  it('warns under 10 % free and is serious under 5 %', () => {
    const disk = (free: number) =>
      sabNotices(input(snapshot({ diskFreeBytes: free * 1e12, diskTotalBytes: 1e12 }))).find(
        (n) => n.id === 'disk',
      )?.tone;
    expect([disk(0.2), disk(0.08), disk(0.04)]).toEqual([undefined, 'warn', 'bad']);
  });

  it('notices a queue paused for over an hour, with Resume', () => {
    const since = new Date(now.getTime() - 2 * 3600_000);
    const n = sabNotices(input(snapshot({ paused: true, pauseLeftMs: null }), { pausedSince: since }));
    expect(n.find((x) => x.id === 'paused')?.action?.action).toBe('resume');
    const brief = sabNotices(
      input(snapshot({ paused: true }), { pausedSince: new Date(now.getTime() - 60_000) }),
    );
    expect(brief.find((x) => x.id === 'paused')).toBeUndefined();
  });

  it('asks again every 5 seconds while it downloads, not while paused (SD-09)', () => {
    expect(sabView(input(snapshot())).refreshS).toBe(5);
    expect(sabView(input(snapshot({ paused: true }))).refreshS).toBeUndefined();
  });

  it('gives the card Speed, Left and Disk free, yellow for a failing news server (SD-05)', () => {
    const glance = seenFromView(sabCardView(input(snapshot())));
    expect(glance.facts.map((f) => f.label)).toEqual(['Speed', 'Left', 'Disk free']);
    expect(glance.status).toBe('warn');
    const calm = seenFromView(sabCardView(input(snapshot({}, { failed: [], failedTotal: 0, warnings: [] }))));
    expect(calm.status).toBe('ok');
  });

  it('draws the speed over the range from its points (SD-S06)', () => {
    const view = sabView(
      input(snapshot(), {
        speed: { timestamps: ['2026-10-21T19:40:00.000Z', '2026-10-21T19:45:00.000Z'], values: [12, 40] },
      }),
    );
    // Below the slots, in the main column, over the page's range.
    expect(view.panels.find((p) => p.id === 'speed')).toMatchObject({ kind: 'chart', place: 'main' });
    expect(view.charts).toEqual([]);
    expect(view.machine).toBe('after');
  });
});

describe('in slots (service-slots.md)', () => {
  const GB = 1e9;
  /** Each news server's days, newest last, as SABnzbd keeps them. */
  function stats(days: Record<string, Record<string, number>>, total = 0): SabStats {
    return {
      day: 0,
      week: 0,
      month: 5 * GB,
      total,
      servers: Object.entries(days).map(([name, daily]) => ({
        name,
        total: 800 * GB,
        week: 0,
        daily: new Map(Object.entries(daily)),
        tried: new Map([['2026-10-21', 1000]]),
        found: new Map([['2026-10-21', 990]]),
      })),
    };
  }
  const week = {
    '2026-10-10': 4 * GB,
    '2026-10-15': 2 * GB,
    '2026-10-20': 3 * GB,
    '2026-10-21': 1 * GB,
  };

  it('keeps the slots: downloading now, downloaded, this week, then its own panels', () => {
    const view = sabView(
      input(snapshot({}, { stats: stats({ 'news.example.com': week }) }), {
        speed: { timestamps: ['2026-10-21T19:40:00.000Z', '2026-10-21T19:45:00.000Z'], values: [12, 40] },
      }),
    );
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['queue', 'downloaded', 'week', 'failed', 'speed']);
  });

  it('reads each news server’s days from server_stats (recorded)', () => {
    const s = parseStats(fixture('sab-server-stats.json'));
    expect(s?.servers.map((x) => [x.name, [...x.daily.keys()]])).toEqual([
      ['news.example.com', ['2026-10-21']],
    ]);
    expect(
      parseStats({ month: 0, servers: { x: { daily: { nope: 3, '2026-10-21': 'a' } } } })?.servers[0]?.daily
        .size,
    ).toBe(0);
  });

  it('shows each download as a row: category and size, how far, time left, with the queue’s buttons', () => {
    const q = parseQueue(fixture('sab-queue.json'));
    const slots = q.slots.map((x, i) =>
      i === 0 ? { ...x, leftBytes: (x.sizeBytes ?? 0) / 2, done: 0.5, leftMs: 4 * 60_000 } : x,
    );
    const view = sabView(input(snapshot({ slots, speedBps: 42e6, leftMs: 20 * 60_000 })));
    const live = view.panels.find((p) => p.id === 'queue');
    expect(live).toMatchObject({ kind: 'gallery', look: 'rows', shape: 'square', title: 'Downloading now' });
    expect(live?.kind === 'gallery' && live.buttons?.map((b) => b.action)).toEqual([
      'pause',
      'pause30',
      'speed',
    ]);
    const [first, second] = live?.kind === 'gallery' ? live.items : [];
    expect(first).toMatchObject({
      sub: 'tv · 2 MB',
      progress: 0.5,
      note: '1 MB of 2 MB',
      noteEnd: '4 min left',
    });
    expect(second?.note).toBe('0 %');
    expect(live?.kind === 'gallery' && live.meta).toMatch(
      /^42 MB\/s · 3 downloads · .+ left · about 20 min$/,
    );
  });

  it('greys every row while paused and says when a timed pause ends', () => {
    const q = snapshot({ paused: true, pauseLeftMs: 18 * 60_000 }).queue;
    expect(queueMeta(q)).toMatch(/^Paused · resumes in 18 min · .+ left$/);
    const live = sabView(input(snapshot({ paused: true }))).panels.find((p) => p.id === 'queue');
    expect(live?.kind === 'gallery' && live.items.every((i) => i.paused && i.noteEnd === 'Paused')).toBe(
      true,
    );
    expect(live?.kind === 'gallery' && live.buttons?.map((b) => b.action)).toEqual(['resume', 'speed']);
  });

  it('counts what each news server brought in, with the last 7 days and whether it works', () => {
    const view = sabView(input(snapshot({}, { stats: stats({ '127.0.0.1': week, 'news.b.net': week }) })));
    const p = view.panels.find((x) => x.id === 'downloaded');
    const lines = p?.kind === 'list' ? p.items : [];
    expect(p).toMatchObject({ look: 'counts', title: 'Downloaded', meta: '5.0 GB this month' });
    expect(lines.map((i) => [i.title, i.figure?.value, i.figure?.note, i.tone])).toEqual([
      ['127.0.0.1', '800 GB', '+6.0 GB this week', 'warn'],
      ['news.b.net', '800 GB', '+6.0 GB this week', undefined],
    ]);
    // The failing one (SABnzbd's warnings) says so; the other how much of what was asked of it it found.
    expect(lines[0]?.detail).toBe('Not working now');
    expect(lines[1]?.detail).toBe('Found 99 % this week');
  });

  it('draws what came in per day this week, and the change once the days reach back', () => {
    const trend = sabWeek(stats({ a: week }), now, TZ);
    expect(trend?.series[0]?.values).toEqual([2, 0, 0, 0, 0, 3, 1]);
    expect(trend?.figure).toEqual({ value: '6.0 GB', rest: 'this week' });
    expect(trend?.stats?.[0]?.[0]?.text).toBe('+50 %');
    const short = sabWeek(stats({ a: { '2026-10-21': GB } }), now, TZ);
    expect(short?.stats).toBeUndefined();
    expect(sabWeek(stats({}), now, TZ)).toBeNull();
  });

  it('gives the machine card its version and the download disk', () => {
    const lines = sabMachineLines(snapshot().queue);
    expect(lines.map((l) => [l.id, l.label])).toEqual([
      ['sab-version', 'SABnzbd'],
      ['download-disk', 'Download disk'],
    ]);
    expect(lines[0]?.value).toBe('5.1.3');
    expect(lines[1]?.sub).toMatch(/ free$/);
    const full = sabMachineLines(snapshot({ diskFreeBytes: 0.04 * 1e12, diskTotalBytes: 1e12 }).queue);
    expect(full[1]?.tone).toBe('bad');
  });
});

describe('the buttons (SD-07, SD-08)', () => {
  const services = { clock: () => now } as unknown as Services;
  const ctx = { services, row, now, timeZone: TZ };
  let calls: FakeCall[] = [];
  const answer = (fn: (call: FakeCall) => FakeAnswer) => {
    http.answer = fn as typeof http.answer;
  };
  beforeEach(() => {
    http.calls = [];
    calls = http.calls as FakeCall[];
    forgetKindReads(services);
    answer((call) =>
      call.url.searchParams.get('mode') === 'history'
        ? { json: fixture('sab-history-failed.json') }
        : call.url.searchParams.get('mode') === 'queue'
          ? { json: fixture('sab-queue.json') }
          : { json: { status: true } },
    );
  });
  const modes = () => calls.map((c) => Object.fromEntries(c.url.searchParams));

  it('pauses, resumes and pauses for 30 minutes as everyday switches', async () => {
    expect((await SAB_ACTIONS.pause?.(ctx, {}))?.everyday).toBe(true);
    expect((await SAB_ACTIONS.resume?.(ctx, {}))?.everyday).toBe(true);
    await SAB_ACTIONS.pause30?.(ctx, {});
    expect(modes().filter((m) => m.mode !== 'queue')).toEqual([
      { mode: 'pause', output: 'json' },
      { mode: 'resume', output: 'json' },
      { mode: 'config', name: 'set_pause', value: '30', output: 'json' },
    ]);
  });

  it('sets only full, half or a quarter of the speed', async () => {
    await SAB_ACTIONS.speed?.(ctx, { value: 25 });
    expect(modes()[0]).toMatchObject({ mode: 'config', name: 'speedlimit', value: '25' });
    await expect(SAB_ACTIONS.speed?.(ctx, { value: 10 })).rejects.toThrow();
  });

  it('retries only a download in the failed list, and records it in the burrow’s log', async () => {
    const done = await SAB_ACTIONS.retry?.(ctx, { target: '2ac817ee-8653-4ecb-8dc1-3271fa38f03c' });
    expect(done?.everyday).toBeFalsy();
    expect(done?.title).toContain('The.Movie.2024.2160p.WEB-DL');
    expect(modes().find((m) => m.mode === 'retry')).toMatchObject({
      value: '2ac817ee-8653-4ecb-8dc1-3271fa38f03c',
    });
    await expect(SAB_ACTIONS.retry?.(ctx, { target: 'not-there' })).rejects.toThrow(/failed list/);
  });

  it('says SABnzbd’s own refusal in plain words', async () => {
    answer(() => ({ json: { status: false, error: 'not implemented' } }));
    await expect(SAB_ACTIONS.clear_warnings?.(ctx, {})).rejects.toThrow(/not implemented/);
  });

  it('never deletes, restarts or shuts SABnzbd down', () => {
    expect(Object.keys(SAB_ACTIONS).sort()).toEqual(
      ['clear_warnings', 'pause', 'pause30', 'resume', 'retry', 'retry_all', 'speed'].sort(),
    );
  });
});

describe('the head (SD-05)', () => {
  it('says what it does, never warn or bad', () => {
    // The lines decide warn and bad (quiet-notices.md QN-S3x); the head says only what it does.
    expect(sabView(input(snapshot())).status?.status).toBe('ok');
    const calm = snapshot({ speedBps: 42e6 }, { failed: [], failedTotal: 0, warnings: [] });
    expect(sabView(input(calm)).status).toEqual({ status: 'ok', badge: 'Downloading · 42 MB/s' });
    expect(
      sabView(input({ ...calm, queue: { ...calm.queue, paused: true, pauseLeftMs: null } })).status,
    ).toEqual({ status: 'ok', badge: 'Paused' });
  });
});

describe('quiet notices (quiet-notices.md QN-01…QN-04, QN-11)', () => {
  const failedAt = (n: number, hoursAgo: number) => {
    const one = snapshot().rest?.failed[0];
    if (!one) throw new Error('fixture');
    return Array.from({ length: n }, (_, k) => ({
      ...one,
      id: `nzo_${k}`,
      at: new Date(now.getTime() - (hoursAgo + k) * 3600_000),
    }));
  };
  const lineOf = (s: SabSnapshot, check: string, more: Partial<SabInput> = {}) =>
    sabNotices(input(s, more)).filter((n) => n.check === check);

  it('counts only the last day’s failures: a heads-up, a problem from three, newest as its episode', () => {
    expect(lineOf(snapshot({}, { failed: failedAt(2, 30), failedTotal: 2 }), 'sabnzbd.failed')).toEqual([]);
    const two = lineOf(snapshot({}, { failed: failedAt(2, 1), failedTotal: 2 }), 'sabnzbd.failed')[0];
    expect(two).toMatchObject({ nature: 'fyi', tone: 'info', episode: 'nzo_0', ignore: { lifts: 'newer' } });
    expect(two?.link).toBeUndefined();
    const three = lineOf(snapshot({}, { failed: failedAt(3, 1), failedTotal: 3 }), 'sabnzbd.failed')[0];
    expect(three).toMatchObject({ nature: 'problem', tone: 'warn', link: { kind: 'ask' } });
  });

  it('keys a news server by its host: a refused login is only you, newest warning its episode', () => {
    const at = new Date('2026-10-21T19:00:00Z');
    const login = [{ type: 'WARNING', text: 'Failed login for server news.example.com', at }];
    const [server] = lineOf(snapshot({}, { warnings: login }), 'sabnzbd.server');
    expect(server).toMatchObject({
      nature: 'you',
      subject: { id: 'server:news.example.com', name: 'news.example.com' },
      episode: at.toISOString(),
      ignore: { lifts: 'newer' },
    });
    const [down] = lineOf(snapshot(), 'sabnzbd.server');
    expect(down).toMatchObject({ nature: 'problem', subject: { id: 'server:127.0.0.1' } });
  });

  it('keeps Paused calm for an hour, then a line only you act on, from when the pause began', () => {
    const since = new Date(now.getTime() - 2 * 3600_000);
    const [paused] = lineOf(snapshot({ paused: true, pauseLeftMs: null }), 'sabnzbd.paused', {
      pausedSince: since,
    });
    expect(paused).toMatchObject({ nature: 'you', ignore: { lifts: 'fixed' } });
    expect(paused?.episode).toBeUndefined();
  });

  it('says the download disk by its size, in bands', () => {
    const [disk] = lineOf(snapshot({ diskFreeBytes: 0.01e12, diskTotalBytes: 1e12 }), 'media.disk');
    expect(disk).toMatchObject({
      nature: 'problem',
      subject: { id: 'disk:931g', name: 'the download disk' },
      band: 98,
      tone: 'bad',
    });
  });

  it('says which checks it couldn’t read', () => {
    expect(sabSkipped(snapshot())).toEqual([]);
    expect(sabSkipped({ ...snapshot(), rest: null })).toEqual([
      'sabnzbd.failed',
      'sabnzbd.server',
      'sabnzbd.warnings',
    ]);
    expect(sabSkipped(snapshot({ diskTotalBytes: null }, { unread: ['warnings'], failedTotal: 40 }))).toEqual(
      ['media.disk', 'sabnzbd.server', 'sabnzbd.warnings', 'sabnzbd.failed'],
    );
  });

  it('lists every check it can raise', () => {
    expect(SABNZBD_KIND.checks).toBe(SAB_CHECKS);
    expect(SAB_CHECKS.map((c) => c.check)).toEqual([
      'media.disk',
      'sabnzbd.server',
      'sabnzbd.paused',
      'sabnzbd.failed',
      'sabnzbd.warnings',
    ]);
  });
});
