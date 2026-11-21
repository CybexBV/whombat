/**
 * Plausible's page (service-dashboards.md SD-62, SD-S18), in slots (service-slots.md): right now in Live (visitors now,
 * today against yesterday at this hour, the bounce rate and the visit time), where today's visitors come from (or every
 * site the key sees, the busiest first), visitors per day this week; today's top pages below,
 * the busiest first. Read with the connection's Stats API key: `POST /api/v2/query` (five queries for the busiest site,
 * one per other site) kept 5 minutes, the realtime count (`/api/v1/stats/realtime/visitors`) kept a minute, and the
 * sites (`/api/v1/sites`, a Sites API key's; else the connection's site) kept 15 minutes — well inside Plausible's 600
 * requests an hour. Worth a look: a site that had visitors yesterday and none today by noon (its script may be gone).
 * Read only.
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi, ThingPagePanel } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { KindCheck } from '../../quiet/types';
import { clip, line, list, num, plural, rec, str, thousands } from '../../words';
import { cachedRead, latestRead, ReadProblem } from '../read';
import type { KindModule } from '../registry';
import {
  countLine,
  type InventoryPanel,
  inventory,
  type LivePanel,
  liveList,
  lastDays as slotDays,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import { type KindNotice, lookInto, period } from '../storage/lines';
import type { KindCtx, KindView } from '../types';
import {
  lastDays,
  loader,
  localDay,
  nextMidnight,
  optional,
  rarelyRead,
  readJson,
  seenOfView,
  shortBadge,
  startOfDay,
  statusFrom,
  todayStart,
  viewOrProblem,
} from './common';

const NAME = 'Plausible';
/** Plausible allows 600 requests an hour per key: the statistics are kept 5 minutes (SD-S05). */
export const STATS_CACHE_MS = 5 * 60_000;
export const REALTIME_CACHE_MS = 60_000;
/** Sites Whombat counts today's visitors of, at most. */
export const SITES_MAX = 6;
const TOP = 8;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface PlausibleSite {
  domain: string;
  timeZone: string | null;
}

export interface PlausibleMain {
  site: string;
  /** The zone its days are in: the site's own when Plausible says, else the burrow's. */
  timeZone?: string;
  /** Visitors per local day of the site, oldest first; the last is today. */
  days: { day: string; visitors: number }[];
  today: { visitors: number; bounceRate: number | null; visitDurationS: number | null } | null;
  /** Visitors yesterday up to this moment of the day; null when Plausible didn't answer that. */
  yesterdaySoFar: number | null;
  pages: { name: string; visitors: number }[] | null;
  sources: { name: string; visitors: number }[] | null;
}

export interface PlausibleSnapshot {
  readAt: Date;
  main: PlausibleMain;
  /** Today's visitors per site, the busiest first (only when the key sees several). */
  sites: { domain: string; visitors: number | null }[];
  /** Visitors on the main site in the last 5 minutes (read apart, kept a minute). */
  now: number | null;
}

/** A v2 query's rows: their dimensions and metrics. */
export function queryRows(body: unknown): { dimensions: string[]; metrics: (number | null)[] }[] {
  return list(rec(body).results).map((r) => {
    const x = rec(r);
    return {
      dimensions: list(x.dimensions).map((d) => (typeof d === 'string' ? d : String(d ?? ''))),
      metrics: list(x.metrics).map((m) => num(m)),
    };
  });
}

/** `/api/v1/sites`: the domains and their zones. */
export function parseSites(body: unknown): PlausibleSite[] {
  return list(rec(body).sites)
    .map((s) => {
      const domain = str(rec(s).domain);
      return domain ? { domain: domain.slice(0, 200), timeZone: str(rec(s).timezone) } : null;
    })
    .filter((s): s is PlausibleSite => s !== null);
}

/** “2026-10-21T00:00:00Z” without milliseconds, as Plausible's date ranges take an instant. */
const instant = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The five queries of the main site (SD-62): 30 days per day, today, yesterday so far, top pages, top sources. */
export function mainQueries(site: string, now: Date, timeZone: string) {
  const days = lastDays(now, timeZone, 30);
  const today = todayStart(now, timeZone);
  const yesterday = startOfDay(lastDays(now, timeZone, 2)[0] as string, timeZone);
  const top = (dimension: string) => ({
    site_id: site,
    metrics: ['visitors'],
    date_range: 'day',
    dimensions: [dimension],
    order_by: [['visitors', 'desc']],
    pagination: { limit: TOP },
  });
  return {
    days: {
      site_id: site,
      metrics: ['visitors'],
      date_range: [days[0], days.at(-1)],
      dimensions: ['time:day'],
    },
    today: { site_id: site, metrics: ['visitors', 'bounce_rate', 'visit_duration'], date_range: 'day' },
    yesterday: {
      site_id: site,
      metrics: ['visitors'],
      date_range: [
        instant(yesterday),
        instant(new Date(yesterday.getTime() + (now.getTime() - today.getTime()))),
      ],
    },
    pages: top('event:page'),
    sources: top('visit:source'),
  };
}

/** Visitors per local day over 30 days, a day without visitors as 0 (Plausible leaves it out). */
export function perDay(body: unknown, now: Date, timeZone: string): PlausibleMain['days'] {
  const got = new Map<string, number>();
  for (const r of queryRows(body)) {
    const day = r.dimensions[0]?.slice(0, 10);
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) got.set(day, (got.get(day) ?? 0) + (r.metrics[0] ?? 0));
  }
  return lastDays(now, timeZone, 30).map((day) => ({ day, visitors: got.get(day) ?? 0 }));
}

const topOf = (body: unknown) =>
  queryRows(body)
    .map((r) => ({
      name: (r.dimensions[0] ?? '').slice(0, 200) || 'Direct / None',
      visitors: r.metrics[0] ?? 0,
    }))
    .slice(0, TOP);

async function readMain(
  services: Services,
  row: CatalogConnectionRow,
  site: string,
  now: Date,
  timeZone: string,
): Promise<PlausibleMain> {
  const q = mainQueries(site, now, timeZone);
  const query = (body: unknown) => readJson(services, row, NAME, '/api/v2/query', { method: 'POST', body });
  const [days, today, yesterday, pages, sources] = await Promise.all([
    query(q.days),
    optional(query(q.today)),
    optional(query(q.yesterday)),
    optional(query(q.pages)),
    optional(query(q.sources)),
  ]);
  const t = today ? queryRows(today)[0] : undefined;
  return {
    site,
    timeZone,
    days: perDay(days, now, timeZone),
    today: t
      ? {
          visitors: t.metrics[0] ?? 0,
          bounceRate: t.metrics[1] ?? null,
          visitDurationS: t.metrics[2] ?? null,
        }
      : null,
    yesterdaySoFar: yesterday ? (queryRows(yesterday)[0]?.metrics[0] ?? 0) : null,
    pages: pages ? topOf(pages) : null,
    sources: sources ? topOf(sources) : null,
  };
}

/** The sites the key sees (a Sites API key), else the connection's own. */
async function sitesOf(services: Services, row: CatalogConnectionRow): Promise<PlausibleSite[]> {
  const own = str(row.fields.site);
  const listed = await rarelyRead(
    services,
    `plausible-sites:${row.id}`,
    row,
    async () => parseSites(await readJson(services, row, NAME, '/api/v1/sites', { query: { limit: '100' } })),
    { optional: true },
  );
  const sites = listed?.length ? listed : [];
  if (own && !sites.some((s) => s.domain === own)) sites.unshift({ domain: own, timeZone: null });
  return sites;
}

async function readPlausible(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<Omit<PlausibleSnapshot, 'now'>> {
  const sites = (await sitesOf(services, row)).slice(0, SITES_MAX);
  if (!sites.length) throw new ReadProblem('Plausible has no site to show yet.');
  let counts: { domain: string; visitors: number | null; timeZone: string | null }[] = [];
  if (sites.length > 1) {
    counts = await Promise.all(
      sites.map(async (s) => {
        const body = await optional(
          readJson(services, row, NAME, '/api/v2/query', {
            method: 'POST',
            body: { site_id: s.domain, metrics: ['visitors'], date_range: 'day' },
          }),
        );
        return { ...s, visitors: body ? (queryRows(body)[0]?.metrics[0] ?? 0) : null };
      }),
    );
    counts.sort((a, b) => (b.visitors ?? -1) - (a.visitors ?? -1));
  }
  const main = counts[0] ?? { ...(sites[0] as PlausibleSite), visitors: null };
  return {
    readAt: now,
    main: await readMain(services, row, main.domain, now, main.timeZone ?? timeZone),
    sites: counts.map(({ domain, visitors }) => ({ domain, visitors })),
  };
}

const statsKey = (row: CatalogConnectionRow, timeZone: string) => `plausible:${row.id}:${timeZone}`;

function statsLoad(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  return loader(NAME, () => readPlausible(services, row, now, timeZone));
}

/** Visitors in the last 5 minutes on a site (`/api/v1/stats/realtime/visitors` answers a number). */
function realtimeLoad(services: Services, row: CatalogConnectionRow, site: string) {
  return loader(NAME, async () =>
    num(await readJson(services, row, NAME, '/api/v1/stats/realtime/visitors', { query: { site_id: site } })),
  );
}

/** Plausible's read for its page (PS-01): the statistics kept 5 minutes, the realtime count a minute. */
export async function plausibleLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  const stats = await latestRead(
    services,
    statsKey(row, timeZone),
    row,
    statsLoad(services, row, now, timeZone),
    {
      ttlMs: STATS_CACHE_MS,
    },
  );
  if (!stats.ok) return stats;
  const site = stats.value.main.site;
  const live = await latestRead(
    services,
    `plausible-now:${row.id}:${site}`,
    row,
    realtimeLoad(services, row, site),
    {
      ttlMs: REALTIME_CACHE_MS,
    },
  );
  return { ...stats, value: { ...stats.value, now: live.ok ? live.value : null } as PlausibleSnapshot };
}

/* Words -------------------------------------------------------------------------------------------------------------- */

/** “1 min 32 s”, “45 s”, “12 min”. */
export function visitTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return m >= 10 || rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}

/** “+12 %”, “−8 %”, “Same as”; null without a base. */
export function changeWords(today: number, before: number): string | null {
  if (before <= 0) return null;
  const pct = Math.round(((today - before) / before) * 100);
  if (pct === 0) return 'Same as';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)} %`;
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface PlausibleInput {
  snapshot: PlausibleSnapshot;
  now: Date;
  timeZone: string;
  /** Plausible's own dashboard. */
  url: string;
}

function figures(input: PlausibleInput): ThingPageKpi[] {
  const { snapshot } = input;
  const m = snapshot.main;
  const many = snapshot.sites.length > 1;
  const todayN = m.today?.visitors ?? m.days.at(-1)?.visitors ?? 0;
  const out: ThingPageKpi[] = [];
  if (snapshot.now !== null)
    out.push({
      key: 'now',
      label: 'Visitors now',
      value: thousands(snapshot.now),
      sub: many ? clip(`on ${m.site}`, 80) : 'Last 5 minutes',
      color: 'green',
    });
  const change = m.yesterdaySoFar !== null ? changeWords(todayN, m.yesterdaySoFar) : null;
  out.push({
    key: 'today',
    label: 'Today',
    value: thousands(todayN),
    rest: todayN === 1 ? 'visitor' : 'visitors',
    sub: change
      ? change === 'Same as'
        ? 'Same as yesterday at this hour'
        : `${change} vs yesterday at this hour`
      : m.yesterdaySoFar !== null
        ? 'None yesterday at this hour'
        : 'So far today',
    spark: m.days.slice(-14).map((d) => d.visitors),
    color: 'blue',
  });
  if (m.today?.bounceRate != null)
    out.push({
      key: 'bounce',
      label: 'Bounce rate',
      value: `${Math.round(m.today.bounceRate)} %`,
      sub: 'Today',
    });
  if (m.today?.visitDurationS != null)
    out.push({ key: 'time', label: 'Visit time', value: visitTime(m.today.visitDurationS), sub: 'Today' });
  return out;
}

/** Today's visitors against yesterday by this hour, short enough to sit under the count; null when unknown. */
function todayChange(m: PlausibleMain, todayN: number): { text: string; tone?: 'ok' } | null {
  if (m.yesterdaySoFar === null) return null;
  const change = changeWords(todayN, m.yesterdaySoFar);
  if (!change) return { text: 'None yesterday by now' };
  if (change === 'Same as') return { text: 'Same as yesterday' };
  return { text: `${change} on yesterday`, ...(change.startsWith('+') ? { tone: 'ok' as const } : {}) };
}

/** Pages Live lists at most. */
const PAGES_SHOWN = 6;

/**
 * Live “Top pages”: what visitors read today, the busiest first, with its share of today's visitors. Null when
 * Plausible didn't answer the pages.
 */
export function pagesLive(input: PlausibleInput, siteUrl: string): LivePanel | null {
  const m = input.snapshot.main;
  if (!m.pages) return null;
  const todayN = m.today?.visitors ?? m.days.at(-1)?.visitors ?? 0;
  return liveList({
    id: 'pages',
    title: 'Top pages',
    meta: input.snapshot.sites.length > 1 ? clip(`Today · ${m.site}`, 120) : 'Today',
    link: { kind: 'url', label: 'Open Plausible', url: siteUrl },
    items: m.pages.slice(0, PAGES_SHOWN).map(
      (x, n): ThingPageItem => ({
        id: `page-${n}`,
        title: clip(x.name, 160),
        icon: 'log',
        ...(todayN > 0
          ? { detail: `${Math.min(100, Math.round((x.visitors / todayN) * 100))} % of today’s visitors` }
          : {}),
        right: thousands(x.visitors),
      }),
    ),
    empty: 'No visits yet today.',
  });
}

/**
 * Inventory “Today”: visitors in the last 5 minutes, today's against yesterday by this hour, and today's bounce rate and
 * visit time (the desk's figures read them, Visitors now first).
 */
export function todayInventory(input: PlausibleInput, siteUrl: string): InventoryPanel {
  const { snapshot } = input;
  const m = snapshot.main;
  const todayN = m.today?.visitors ?? m.days.at(-1)?.visitors ?? 0;
  const change = todayChange(m, todayN);
  const lines: ThingPageItem[] = [];
  if (snapshot.now !== null)
    lines.push(
      countLine({
        id: 'now',
        title: 'Visitors now',
        icon: 'device',
        detail: 'In the last 5 minutes',
        value: thousands(snapshot.now),
        url: siteUrl,
      }),
    );
  lines.push(
    countLine({
      id: 'today',
      title: 'Visitors today',
      icon: 'clock',
      detail: 'So far today',
      value: thousands(todayN),
      ...(change ? { note: change.text, ...(change.tone ? { noteTone: change.tone } : {}) } : {}),
    }),
  );
  if (m.today?.bounceRate != null)
    lines.push(
      countLine({
        id: 'bounce',
        title: 'Bounce rate',
        icon: 'info',
        detail: 'Left after one page',
        value: `${Math.round(m.today.bounceRate)} %`,
      }),
    );
  if (m.today?.visitDurationS != null)
    lines.push(
      countLine({
        id: 'time',
        title: 'Visit time',
        icon: 'clock',
        detail: 'A visit, on average',
        value: visitTime(m.today.visitDurationS),
      }),
    );
  return inventory({
    id: 'today',
    title: 'Today',
    ...(snapshot.sites.length > 1 ? { meta: clip(m.site, 120) } : {}),
    items: lines,
  });
}

/**
 * Trend: visitors per day this week, today last, its figure the visitors a day on average (a sum would count a
 * returning visitor once a day), with the change on the week before from the 30 days read.
 */
export function visitorsWeek(input: PlausibleInput): TrendPanel | null {
  const m = input.snapshot.main;
  const values = m.days.slice(-7).map((d) => d.visitors);
  if (values.length < 7 || !values.some((v) => v > 0)) return null;
  const week = values.reduce((a, b) => a + b, 0);
  const before = m.days.slice(-14, -7).reduce((a, d) => a + d.visitors, 0);
  return trend({
    id: 'week',
    title: 'This week',
    meta: 'Visitors per day',
    days: slotDays(input.now, m.timeZone ?? input.timeZone),
    values,
    label: 'Visitors',
    figure: { value: thousands(Math.round(week / 7)), rest: 'visitors a day' },
    change: weekChange(week, before),
    color: 'blue',
  });
}

/** The check (quiet-notices.md QN-03): the main site had nobody today. */
export const NO_VISITORS = 'plausible.no_visitors';

/** What Whombat watches (QN-15). */
export const PLAUSIBLE_WATCH: readonly KindCheck[] = [
  {
    check: NO_VISITORS,
    name: 'A busy site with no visitors today',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
];

/** The same weekday last week needs this many visitors for a day with nobody to stand out (QN-04). */
export const LAST_WEEK_MIN = 25;

/**
 * Worth a look (SD-S18; QN-S*): no visitors on the main site since midnight past noon in its own zone, while the same
 * weekday last week had at least 25 and that day or yesterday at least 50 — so a business site's quiet weekend
 * (Friday 60, Saturday 0) stays calm. A problem the assistant can look into; Ignore lasts until the site's midnight.
 */
export function plausibleNotices(input: PlausibleInput): KindNotice[] {
  const { snapshot, now } = input;
  const m = snapshot.main;
  const zone = m.timeZone ?? input.timeZone;
  const yesterday = m.days.at(-2)?.visitors ?? 0;
  const lastWeek = m.days.at(-8)?.visitors ?? 0;
  const today = m.today?.visitors ?? m.days.at(-1)?.visitors ?? 0;
  const pastNoon = now.getTime() - todayStart(now, zone).getTime() >= 12 * 3600_000;
  const busy = lastWeek >= LAST_WEEK_MIN && Math.max(yesterday, lastWeek) >= 50;
  if (!(pastNoon && busy && today === 0 && (snapshot.now ?? 0) === 0)) return [];
  const title = clip(`No visitors on ${m.site} today`, 120);
  return [
    {
      id: 'no-visitors',
      tone: 'warn',
      icon: 'warn',
      title,
      detail: `Yesterday had ${thousands(yesterday)}, the same day last week ${thousands(lastWeek)}. Its tracking script may be missing.`,
      link: lookInto(
        `Plausible counted nobody on ${m.site} today, after ${yesterday} yesterday and ${lastWeek} on the same day last week. Is the site up, and is its Plausible script still there?`,
      ),
      nature: 'problem',
      check: NO_VISITORS,
      subject: { id: `site:${m.site}`.slice(0, 160), name: clip(m.site, 80) },
      ignore: period('Until tomorrow.', nextMidnight(now, zone)),
      episode: localDay(now, zone),
      ...shortBadge(title, 'No visitors today'),
    },
  ];
}

const bars = (items: { name: string; visitors: number }[], prefix: string): ThingPageBar[] => {
  const top = Math.max(1, ...items.map((i) => i.visitors));
  return items.map((i, n) => ({
    id: `${prefix}-${n}`,
    label: clip(i.name, 80),
    ...(prefix === 'page' ? { mono: true } : {}),
    value: thousands(i.visitors),
    pct: Math.min(1, i.visitors / top),
  }));
};

/** The page's Plausible part (SD-62), in slots (service-slots.md), from what was read; pure. */
export function plausibleView(input: PlausibleInput): KindView {
  const { snapshot, url } = input;
  const m = snapshot.main;
  const notices = plausibleNotices(input);
  const siteUrl = `${url}/${encodeURIComponent(m.site)}`;
  const many = snapshot.sites.length > 1;
  const more: ThingPagePanel[] = [];
  if (m.sources)
    more.push({
      kind: 'bars',
      id: 'sources',
      title: 'Where they come from',
      meta: many ? clip(`Today · ${m.site}`, 120) : 'Today',
      items: bars(m.sources, 'source'),
      empty: 'No visits yet today.',
    });
  if (many)
    more.push({
      kind: 'table',
      id: 'sites',
      title: 'Sites',
      meta: 'Visitors today, the busiest first',
      columns: [
        { key: 'site', label: 'Site' },
        { key: 'today', label: 'Today', numeric: true },
      ],
      rows: snapshot.sites.map((x) => ({
        id: x.domain.slice(0, 200),
        cells: {
          site: { text: clip(x.domain, 200), mono: true, url: `${url}/${encodeURIComponent(x.domain)}` },
          today:
            x.visitors === null
              ? { text: '—', tone: 'muted' as const }
              : { text: thousands(x.visitors), mono: true },
        },
      })),
    });
  const facts: ThingLine[] = [line(`**${clip(m.site, 100)}**`)];
  if (many) facts.push(line(`**${snapshot.sites.length}** sites`));
  const todayN = m.today?.visitors ?? m.days.at(-1)?.visitors ?? 0;
  return {
    // Its figures are in Today; the card keeps them (`plausibleFigures`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    ...slotPanels({
      live: pagesLive(input, siteUrl),
      inventory: todayInventory(input, siteUrl),
      trend: visitorsWeek(input),
      more,
    }),
    tabs: [],
    facts,
    status: statusFrom(notices, `${plural(todayN, 'visitor')} today`),
    open: { label: 'Open Plausible', url: siteUrl },
    actions: [],
    readAt: snapshot.readAt,
    suggestions: ['Visitors this month vs last', 'Top countries this week', 'Goals this month'],
  };
}

/** The card's figures: visitors now, today, bounce rate and visit time (as the page's row used to be). */
export const plausibleFigures = (input: PlausibleInput): ThingPageKpi[] => figures(input);

/** The card from the page and the card's own figures (the page in slots has no row of figures). */
export function plausibleSeen(input: PlausibleInput) {
  return seenOfView({ ...plausibleView(input), kpis: plausibleFigures(input) }, 2);
}

/* The page ----------------------------------------------------------------------------------------------------------- */

/** Plausible's address (`fields.url`, plausible.io by default). */
export function plausibleUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (row.fields.url ?? row.baseUrl ?? 'https://plausible.io').replace(/\/+$/, '');
}

export async function plausiblePage(ctx: KindCtx): Promise<KindView> {
  const url = plausibleUrl(ctx.row);
  const site = str(ctx.row.fields.site);
  const read = await plausibleLatest(ctx.services, ctx.row, ctx.now, ctx.timeZone);
  return viewOrProblem(
    read,
    NAME,
    { label: 'Open Plausible', url: site ? `${url}/${encodeURIComponent(site)}` : url },
    (snapshot) => plausibleView({ snapshot, now: ctx.now, timeZone: ctx.timeZone, url }),
  );
}

export const PLAUSIBLE_KIND: KindModule = {
  page: plausiblePage,
  checks: PLAUSIBLE_WATCH,
  prefetch: (services, row, now, timeZone) => plausibleLatest(services, row, now, timeZone),
  seen: async (services, row, now, timeZone) => {
    const stats = await cachedRead(
      services,
      statsKey(row, timeZone),
      row,
      statsLoad(services, row, now, timeZone),
      STATS_CACHE_MS,
    );
    const live = await optional(
      cachedRead(
        services,
        `plausible-now:${row.id}:${stats.main.site}`,
        row,
        realtimeLoad(services, row, stats.main.site),
        REALTIME_CACHE_MS,
      ),
    );
    return plausibleSeen({ snapshot: { ...stats, now: live }, now, timeZone, url: plausibleUrl(row) });
  },
};
