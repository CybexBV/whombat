/**
 * Plausible's page from documented answers (service-dashboards.md SD-62): the v2 queries Whombat asks and how their
 * answers become the figures, the 30-day chart, the top lists, the sites and the no-visitors notice.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import {
  changeWords,
  mainQueries,
  NO_VISITORS,
  PLAUSIBLE_KIND,
  type PlausibleInput,
  type PlausibleMain,
  type PlausibleSnapshot,
  parseSites,
  perDay,
  plausibleFigures,
  plausibleSeen,
  plausibleView,
  queryRows,
  visitTime,
} from './plausible';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'plausible', name), 'utf8'));

const TZ = 'Europe/Amsterdam';
// Tuesday 21 October 2026, 17:00 in Amsterdam.
const now = new Date('2026-10-21T15:00:00Z');

const top = (name: string) =>
  queryRows(fixture(name)).map((r) => ({ name: r.dimensions[0] ?? '', visitors: r.metrics[0] ?? 0 }));

function main(over: Partial<PlausibleMain> = {}): PlausibleMain {
  const t = queryRows(fixture('query-today.json'))[0];
  return {
    site: 'example.com',
    days: perDay(fixture('query-days.json'), now, TZ),
    today: {
      visitors: t?.metrics[0] ?? 0,
      bounceRate: t?.metrics[1] ?? null,
      visitDurationS: t?.metrics[2] ?? null,
    },
    yesterdaySoFar: queryRows(fixture('query-yesterday.json'))[0]?.metrics[0] ?? null,
    pages: top('query-pages.json'),
    sources: top('query-sources.json'),
    ...over,
  };
}

const snapshot = (over: Partial<PlausibleSnapshot> = {}): PlausibleSnapshot => ({
  readAt: now,
  main: main(),
  sites: [],
  now: 3,
  ...over,
});

const input = (over: Partial<PlausibleInput> = {}): PlausibleInput => ({
  snapshot: snapshot(),
  now,
  timeZone: TZ,
  url: 'https://plausible.io',
  ...over,
});

describe('Plausible’s questions and answers', () => {
  it('asks five things of the main site, the day’s ranges in its zone', () => {
    const q = mainQueries('example.com', now, TZ);
    expect(q.days.date_range).toEqual(['2026-09-22', '2026-10-21']);
    expect(q.days.dimensions).toEqual(['time:day']);
    expect(q.today.metrics).toEqual(['visitors', 'bounce_rate', 'visit_duration']);
    // Yesterday from midnight in Amsterdam to 17:00.
    expect(q.yesterday.date_range).toEqual(['2026-10-19T22:00:00Z', '2026-10-20T15:00:00Z']);
    expect(q.pages.dimensions).toEqual(['event:page']);
    expect(q.sources.dimensions).toEqual(['visit:source']);
  });

  it('fills the days Plausible leaves out with nobody', () => {
    const days = perDay(fixture('query-days.json'), now, TZ);
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ day: '2026-09-22', visitors: 120 });
    expect(days.find((d) => d.day === '2026-10-01')?.visitors).toBe(0);
    expect(days.at(-1)).toEqual({ day: '2026-10-21', visitors: 42 });
  });

  it('reads the sites, and nothing from an answer that isn’t one', () => {
    expect(parseSites(fixture('sites.json')).map((s) => s.domain)).toEqual([
      'example.com',
      'shop.example.com',
    ]);
    expect(parseSites({ error: 'Invalid API key' })).toEqual([]);
    expect(queryRows({ results: 'no' })).toEqual([]);
    expect(queryRows({ results: [{ metrics: ['x', 4] }] })[0]?.metrics).toEqual([null, 4]);
  });
});

describe('Plausible’s card (SD-62)', () => {
  it('keeps visitors now, today against yesterday at this hour, bounce rate and visit time', () => {
    const figures = plausibleFigures(input());
    expect(figures.map((k) => [k.key, k.value])).toEqual([
      ['now', '3'],
      ['today', '42'],
      ['bounce', '38 %'],
      ['time', '1 min 32 s'],
    ]);
    expect(figures[1]?.sub).toContain('+14 %');
    for (const k of figures) expect(ThingPageKpi.safeParse(k).success).toBe(true);
    expect(plausibleSeen(input()).glance.facts?.map((f) => [f.label, f.value])).toEqual([
      ['Visitors now', '3'],
      ['Today', '42'],
    ]);
  });

  it('leaves out what Plausible didn’t answer', () => {
    const figures = plausibleFigures(
      input({ snapshot: snapshot({ now: null, main: main({ today: null, yesterdaySoFar: null }) }) }),
    );
    expect(figures.map((k) => k.key)).toEqual(['today']);
    expect(figures[0]?.value).toBe('42');
  });

  it('writes visit time and change plainly', () => {
    expect(visitTime(45)).toBe('45 s');
    expect(visitTime(92)).toBe('1 min 32 s');
    expect(visitTime(720)).toBe('12 min');
    expect(changeWords(42, 37)).toBe('+14 %');
    expect(changeWords(30, 40)).toBe('−25 %');
    expect(changeWords(5, 0)).toBeNull();
  });
});

describe('Plausible’s page in slots', () => {
  it('follows the slots, without a row of figures or the 30-day chart', () => {
    const view = plausibleView(input());
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.charts).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['pages', 'today', 'week', 'sources']);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('lists the pages read today in Live, the busiest first, with their share of today’s visitors', () => {
    const live = plausibleView(input()).panels.find((p) => p.id === 'pages');
    if (live?.kind !== 'list') throw new Error('no live list');
    expect(live.items.map((i) => [i.title, i.right])).toEqual([
      ['/', '30'],
      ['/pricing', '12'],
      ['/blog/hello-world', '6'],
    ]);
    expect(live.items[0]?.detail).toBe('71 % of today’s visitors');
    // Pages aren't the desk's figures.
    expect(live.items.some((i) => i.figure)).toBe(false);
  });

  it('counts today in Inventory: visitors now, today against yesterday, bounce and visit time', () => {
    const today = plausibleView(input()).panels.find((p) => p.id === 'today');
    if (today?.kind !== 'list') throw new Error('no inventory');
    expect(today.items.map((i) => [i.id, i.figure?.value])).toEqual([
      ['now', '3'],
      ['today', '42'],
      ['bounce', '38 %'],
      ['time', '1 min 32 s'],
    ]);
    expect(today.items[1]?.figure).toMatchObject({ note: '+14 % on yesterday', tone: 'ok' });
    const bare = plausibleView(
      input({ snapshot: snapshot({ now: null, main: main({ today: null, yesterdaySoFar: null }) }) }),
    ).panels.find((p) => p.id === 'today');
    expect(bare?.kind === 'list' && bare.items.map((i) => [i.id, i.right, i.detail])).toEqual([
      ['today', '42', 'So far today'],
    ]);
  });

  it('draws visitors per day this week with the average a day and the change on the week before', () => {
    const week = plausibleView(input()).panels.find((p) => p.id === 'week');
    if (week?.kind !== 'chart') throw new Error('no trend');
    const days = perDay(fixture('query-days.json'), now, TZ).map((d) => d.visitors);
    expect(week.series[0]?.values).toEqual(days.slice(-7));
    expect(week.figure?.rest).toBe('visitors a day');
    expect(week.labels?.at(-1)).toBe('Today');
  });

  it('shows where today’s visitors come from as bars below the slots', () => {
    const sources = plausibleView(input()).panels.find((p) => p.id === 'sources');
    if (sources?.kind !== 'bars') throw new Error('no bars');
    expect(sources.place).toBe('main');
    expect(sources.items[0]?.pct).toBe(1);
  });

  it('lists every site below the slots, the busiest first, when the key sees several', () => {
    const view = plausibleView(
      input({
        snapshot: snapshot({
          sites: [
            { domain: 'example.com', visitors: 42 },
            { domain: 'shop.example.com', visitors: 7 },
          ],
        }),
      }),
    );
    expect(slotProblems(view)).toEqual([]);
    const sites = view.panels.find((p) => p.id === 'sites');
    if (sites?.kind !== 'table') throw new Error('no table');
    expect(sites.rows.map((r) => r.id)).toEqual(['example.com', 'shop.example.com']);
    const today = view.panels.find((p) => p.id === 'today');
    expect(today?.kind === 'list' && today.meta).toBe('example.com');
    expect(view.open?.url).toBe('https://plausible.io/example.com');
  });
});

describe('Plausible’s Worth a look (SD-S18)', () => {
  // Nobody today; 140 yesterday; `lastWeek` on Tuesday 14 October.
  const quietDay = (lastWeek: number, over: Partial<PlausibleMain> = {}) =>
    main({
      today: { visitors: 0, bounceRate: null, visitDurationS: null },
      days: main().days.map((d, i, all) =>
        i === all.length - 1
          ? { ...d, visitors: 0 }
          : i === all.length - 8
            ? { ...d, visitors: lastWeek }
            : d,
      ),
      ...over,
    });

  it('warns when a busy site has nobody today past noon, until the site’s midnight', () => {
    const quiet = quietDay(90);
    const view = plausibleView(input({ snapshot: snapshot({ now: 0, main: quiet }) }));
    expect(view.notices.map((n) => [n.id, n.tone, n.nature, n.check, n.subject?.id])).toEqual([
      ['no-visitors', 'warn', 'problem', NO_VISITORS, 'site:example.com'],
    ]);
    const line = view.notices[0];
    expect(line?.link?.kind).toBe('ask');
    expect(line?.ignore).toMatchObject({ lifts: 'period', until: '2026-10-21T22:00:00.000Z' });
    expect(line?.episode).toBe('2026-10-21');
    expect(view.status?.status).toBe('warn');
    expect(ThingPageNotice.safeParse(line).success).toBe(true);
    // Before noon, or with someone on the site now, nothing.
    expect(plausibleView(input({ snapshot: snapshot({ now: 1, main: quiet }) })).notices).toEqual([]);
    const morning = new Date('2026-10-21T08:00:00Z');
    expect(
      plausibleView(input({ now: morning, snapshot: snapshot({ now: 0, main: quiet }) })).notices,
    ).toEqual([]);
  });

  it('stays calm when the same weekday last week was quiet too (a weekend)', () => {
    expect(plausibleView(input({ snapshot: snapshot({ now: 0, main: quietDay(3) }) })).notices).toEqual([]);
  });

  it('counts the morning in the site’s own zone', () => {
    // 15:00 UTC is 11:00 in New York: not past noon there.
    const ny = quietDay(90, { timeZone: 'America/New_York' });
    expect(plausibleView(input({ snapshot: snapshot({ now: 0, main: ny }) })).notices).toEqual([]);
  });

  it('watches the main site', () => {
    expect(PLAUSIBLE_KIND.checks?.map((c) => [c.check, c.perItem])).toEqual([[NO_VISITORS, true]]);
  });

  it('is calm otherwise', () => {
    const view = plausibleView(input());
    expect(view.notices).toEqual([]);
    expect(view.status?.status).toBe('ok');
  });
});
