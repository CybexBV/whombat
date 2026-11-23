/**
 * The panels every connection's page has (connection-pages.md CP-03, CP-06; connection-pages-server.md CP-S16;
 * dashboards.md DS-04, DS-14): its status, response time, last use and problems as figures; the response time over the
 * range as a chart card; “Worth a look” from its state, checks and new tools; what Whombat may do with it from its
 * tools' tiers; and where every panel of the Summary sits. Pure.
 */
import {
  type CatalogEntry,
  openThingFigures,
  type ThingPage,
  type ThingPageAccessItem,
  type ThingPageKpi,
  type ThingPagePanel,
  type ThingPageTab,
  type ThingPanelPlace,
  type ThingStatus,
} from '@whombat/core';
import { toolRowAlwaysAsks } from '../connections/sync';
import type { CatalogConnectionRow, ConnectionToolRow } from '../connections/types';
import type { ConnectionGlance } from '../home/types';
import type { ChartPanel } from './kinds/types';
import { registerChecks } from './quiet/defaults';
import { shortHash } from './quiet/items';
import type { KindCheck, KindNotice, NoticeNature } from './quiet/types';
import {
  avgPeakLines,
  DEFAULT_RANGE,
  downsample,
  drawable,
  lastValue,
  onRange,
  PAGE_RANGES,
  type PageRange,
  RANGE_LABEL,
  RANGE_MS,
  type RawPoint,
  seriesStats,
  statsOf,
} from './series';
import { clip, clock, dayMonth, plural, span } from './words';

/** How often an open page reads again (DS-16; the kinds' reads are kept 30 s under it). */
export const PAGE_REFRESH_S = 60;
/** How soon a page shown from its last reading reads again, while a newer one is read (page-speed.md PS-02). */
export const REFRESHING_S = 5;

/** The first tab of every page (DS-15); its key stays `overview` for old links. */
export const SUMMARY_TAB = { key: 'overview', label: 'Summary' } as const;

/**
 * The page's tabs in the order the apps show them; they open the first. The kind's own dashboard tab first when it names
 * one (`KindView.lead`), its other tabs after it and the Summary last; else the Summary first.
 */
export function orderTabs(
  summary: ThingPageTab,
  own: readonly ThingPageTab[],
  lead: string | null,
): ThingPageTab[] {
  const first = lead ? own.find((t) => t.key === lead) : undefined;
  return first ? [first, ...own.filter((t) => t !== first), summary] : [summary, ...own];
}

/** What every connection's and device's page says about its range (CT-397). */
export function rangeFields(
  range: PageRange,
  ranges: readonly PageRange[] = PAGE_RANGES,
): Pick<ThingPage, 'range' | 'ranges' | 'refreshS'> {
  return { range, ranges: [...ranges], refreshS: PAGE_REFRESH_S };
}

/** The range a page is built over: the asked one when the kind offers it, else the kind's first (SD-S21). */
export function offeredRange(range: PageRange, ranges: readonly PageRange[] = PAGE_RANGES): PageRange {
  return ranges.includes(range) ? range : (ranges[0] ?? range);
}

/** The badge's words per status (CP-04, §2). */
export const BADGE: Record<ThingStatus, string> = {
  ok: 'Running fine',
  warn: 'Needs a look',
  bad: 'Problem',
  offline: 'Couldn’t reach it',
  unknown: 'Not checked yet',
  learning: 'Learning',
};

/** A connection's status from its state and the health pass's glance. */
export function connectionStatus(row: Pick<CatalogConnectionRow, 'status' | 'glance'>): {
  status: ThingStatus;
  badge: string;
} {
  if (row.status === 'needs_reauth') return { status: 'bad', badge: 'Needs you to sign in again' };
  const glance = row.glance as ConnectionGlance | null;
  if (!glance) return { status: 'unknown', badge: BADGE.unknown };
  // The figures stay true while an outage is ignored (quiet-notices.md QN-14): how the check went, not the dot.
  const answer = answerOf(glance);
  const status =
    answer === 'offline' ? 'offline' : answer === 'error' && glance.status === 'ok' ? 'warn' : glance.status;
  return { status, badge: BADGE[status] };
}

const STATUS_FIGURE: Record<ThingStatus, string> = {
  ok: 'Working',
  warn: 'Needs a look',
  bad: 'Not working',
  offline: 'Not answering',
  unknown: 'Not checked',
  learning: 'Learning',
};

/**
 * The generic figures (CP-06, DS-14): Status, Response time (with its small line over the range), Last used, Problems
 * (failed checks in 24 h). With the machine's figures beside them (`machine`), Problems becomes Status's line and Last
 * used goes, so the row keeps six (DS-S05).
 */
export function genericKpis(
  row: Pick<CatalogConnectionRow, 'status' | 'glance' | 'glanceAt' | 'checkedAt' | 'lastUsedAt'>,
  rtt: readonly RawPoint[],
  now: Date,
  timeZone: string,
  range: PageRange = DEFAULT_RANGE,
  machine = false,
): ThingPageKpi[] {
  const { status } = connectionStatus(row);
  const checked = row.glanceAt ?? row.checkedAt;
  const day = now.getTime() - 24 * 3600_000;
  const failed = rtt.filter((p) => p.value === null && p.at.getTime() > day).length;
  const statusTone =
    status === 'bad' || status === 'offline'
      ? ('bad' as const)
      : status === 'warn'
        ? ('warn' as const)
        : undefined;
  const out: ThingPageKpi[] = [
    {
      key: 'status',
      label: 'Status',
      value: row.status === 'needs_reauth' ? 'Signed out' : STATUS_FIGURE[status],
      ...(machine && failed
        ? { sub: `${plural(failed, 'failed check')} in 24 h`, tone: statusTone ?? ('warn' as const) }
        : {
            ...(checked ? { sub: `checked ${span(now.getTime() - checked.getTime())} ago` } : {}),
            ...(statusTone ? { tone: statusTone } : {}),
          }),
    },
  ];
  const from = now.getTime() - RANGE_MS[range];
  const answered = rtt.filter((p) => p.value !== null && p.at.getTime() > from).map((p) => p.value as number);
  const last = answered[answered.length - 1];
  if (last !== undefined) {
    const line = onRange([rtt], range, now).values[0] as (number | null)[];
    out.push({
      key: 'response',
      label: 'Response time',
      value: `${Math.round(last)} ms`,
      sub: `average ${Math.round(answered.reduce((a, b) => a + b, 0) / answered.length)} ms in ${RANGE_LABEL[range]}`,
      ...(drawable(line) ? { spark: downsample(line), color: 'blue' as const } : {}),
    });
  }
  if (!machine)
    out.push(
      row.lastUsedAt
        ? {
            key: 'used',
            label: 'Last used',
            value: dayMonth(row.lastUsedAt, timeZone),
            sub: `at ${clock(row.lastUsedAt, timeZone)}`,
          }
        : { key: 'used', label: 'Last used', value: 'Not yet' },
    );
  if (!machine)
    out.push({
      key: 'problems',
      label: 'Problems',
      value: String(failed),
      sub: 'failed checks in 24 h',
      ...(failed ? { tone: 'warn' as const } : {}),
    });
  return out;
}

/** The response time over the range as a chart card (null without two answers to draw). */
export function responseChart(
  rtt: readonly RawPoint[],
  range: PageRange,
  now: Date,
  timeZone: string,
): ChartPanel | null {
  const grid = onRange([rtt], range, now);
  const values = grid.values[0] as (number | null)[];
  if (!drawable(values)) return null;
  const last = lastValue(values);
  const ms = (n: number) => `${Math.round(n)} ms`;
  return {
    kind: 'chart',
    id: 'response',
    place: 'chart',
    span: 1,
    title: 'Response time',
    timestamps: grid.timestamps,
    series: [
      {
        key: 'response',
        label: 'Response time',
        unit: 'ms',
        values,
        color: 'blue',
        ...(last !== null ? { latest: ms(last) } : {}),
      },
    ],
    ...(last !== null ? { figure: { value: ms(last) } } : {}),
    ...statsOf(avgPeakLines(seriesStats(values, grid.timestamps), ms, now, timeZone)),
    axis: { min: 0, unit: 'ms' },
  };
}

const CHECK_WORDS: Record<string, string> = {
  credential: 'Its sign-in didn’t work at the last check',
  mcp: 'Whombat couldn’t use its tools at the last check',
  destination: 'Its address isn’t allowed any more',
  tools: 'Its tools couldn’t be read at the last check',
};

/** A stored check's item and nature (quiet-notices.md QN-03; catalogue A.2 #4…#7): sign-in and address are a person's. */
const CHECK_ITEM: Record<string, { name: string; nature: NoticeNature }> = {
  credential: { name: 'Sign-in', nature: 'you' },
  mcp: { name: 'Its tools', nature: 'problem' },
  destination: { name: 'Address', nature: 'you' },
  tools: { name: 'Tools', nature: 'problem' },
};

/**
 * The checks every connection has (What Whombat watches, QN-15): whether it answers, its sign-in, the checks stored at
 * connect or Check again, new tools, reading its details, and the disk of the machine it runs on.
 */
export const GENERIC_CHECKS: readonly KindCheck[] = [
  { check: 'conn.answers', name: 'Whether it answers', nature: 'problem', perItem: false, startsOn: true },
  {
    check: 'conn.signin',
    name: 'Whether it’s still signed in',
    nature: 'you',
    perItem: false,
    startsOn: true,
  },
  { check: 'conn.check', name: 'Its sign-in and tools', nature: 'problem', perItem: true, startsOn: true },
  { check: 'conn.new_tools', name: 'New tools to decide on', nature: 'you', perItem: false, startsOn: false },
  { check: 'conn.read', name: 'Reading its details', nature: 'fyi', perItem: false, startsOn: false },
  { check: 'machine.disk', name: 'Its disk', nature: 'problem', perItem: false, startsOn: true },
  {
    check: 'machine.disk_forecast',
    name: 'When its disk will be full',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];
registerChecks(GENERIC_CHECKS);

/** A console's homebrew normally disappears during rest or after a reboot. */
export const answerCheckOf = (catalogId?: string) => (catalogId === 'ps5' ? 'ps5.available' : 'conn.answers');

export function genericChecksFor(catalogId: string): readonly KindCheck[] {
  return catalogId === 'ps5' ? GENERIC_CHECKS.filter((c) => c.check !== 'conn.answers') : GENERIC_CHECKS;
}

/** How the last check went, from the glance: `outcome` since 0136, else what an older glance said. */
export function answerOf(glance: ConnectionGlance | null): 'offline' | 'error' | null {
  if (!glance) return null;
  if (glance.outcome) return glance.outcome;
  if (glance.lines) return null;
  if (glance.status === 'offline') return 'offline';
  return glance.status === 'warn' && glance.line === 'It answered with an error' ? 'error' : null;
}

/**
 * “Worth a look” of any connection (CP-06; QN-01…QN-04): signed out (only you), not answering or answering with an
 * error (a problem, colouring only from the second check in a row), failed stored checks, new tools (only you, as
 * information), couldn't read its details (a heads-up). `newToolNames` names the new tools (another set is newer).
 */
export function genericNotices(
  row: Pick<CatalogConnectionRow, 'status' | 'glance' | 'checks' | 'label'> & { catalogId?: string },
  newTools: number,
  problem: string | null,
  newToolNames: readonly string[] = [],
): KindNotice[] {
  const out: KindNotice[] = [];
  const answer = answerOf(row.glance as ConnectionGlance | null);
  const homebrewNotReady =
    row.catalogId === 'ps5' &&
    (answer || row.checks.some((c) => c.id === 'credential' && c.state === 'error'));
  if (row.status === 'needs_reauth') out.push(signinNotice(row.label));
  else if (homebrewNotReady)
    out.push({
      id: 'homebrew-not-ready',
      tone: 'info',
      icon: 'info',
      title: 'Homebrew isn’t ready',
      detail:
        'Open WebKit Autoloader on your PS5 and leave Payload Manager running. Rest mode and a reboot can make it unavailable.',
      nature: 'fyi',
      check: answerCheckOf(row.catalogId),
      ignore: { lifts: 'fixed', words: 'Until homebrew answers again.' },
    });
  else if (answer === 'offline')
    out.push({
      id: 'offline',
      tone: 'bad',
      icon: 'network',
      title: 'Whombat can’t reach it',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: clip(`Why can’t Whombat reach ${row.label}?`, 300),
      },
      nature: 'problem',
      check: 'conn.answers',
      ignore: { lifts: 'fixed', words: 'Until it answers again.' },
      confirm: 2,
      badge: 'Couldn’t reach it',
      offline: true,
    });
  else if (answer === 'error')
    out.push({
      id: 'error',
      tone: 'warn',
      icon: 'warn',
      title: 'It’s answering with errors',
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: clip(`Why does ${row.label} answer with an error?`, 300),
      },
      nature: 'problem',
      check: 'conn.answers',
      ignore: { lifts: 'fixed', words: 'Until it answers properly again.' },
      confirm: 2,
      badge: 'It answered with an error',
    });
  if (row.status !== 'needs_reauth')
    for (const c of row.checks.filter((x) => x.state === 'error').slice(0, 3)) {
      // This unauthenticated service calls its readiness probe “credential” too.
      if (row.catalogId === 'ps5' && c.id === 'credential') continue;
      const item = CHECK_ITEM[c.id] ?? { name: 'A check', nature: 'problem' as const };
      out.push({
        id: `check-${c.id}`,
        tone: 'warn',
        icon: c.id === 'credential' ? 'key' : 'warn',
        title: CHECK_WORDS[c.id] ?? 'A check failed',
        ...(c.message ? { detail: clip(c.message, 200) } : {}),
        link: { kind: 'tab', label: 'Settings', tab: 'settings' },
        nature: item.nature,
        check: 'conn.check',
        subject: { id: c.id, name: item.name },
        ignore: { lifts: 'fixed', words: 'Until it passes this check again.' },
      });
    }
  if (newTools > 0)
    out.push({
      id: 'new-tools',
      tone: 'info',
      icon: 'info',
      title: `Whombat can do ${plural(newTools, 'new thing')} here`,
      detail: 'Choose whether it may.',
      link: { kind: 'tab', label: 'Decide', tab: 'settings' },
      nature: 'you',
      check: 'conn.new_tools',
      ignore: { lifts: 'newer', words: 'Until more new tools come.' },
      ...(newToolNames.length ? { episode: shortHash(newToolNames) } : {}),
    });
  if (problem && row.status !== 'needs_reauth')
    out.push({
      id: 'unread',
      tone: 'info',
      icon: 'warn',
      title: 'Whombat couldn’t read it just now',
      detail: clip(problem, 200),
      nature: 'fyi',
      check: 'conn.read',
      ignore: { lifts: 'fixed', words: 'Until Whombat can read it again.' },
    });
  return out;
}

/** “… needs you to sign in again” (QN-01: only a person can sign in again; the assistant is refused too). */
export function signinNotice(label: string): KindNotice {
  return {
    id: 'reconnect',
    tone: 'bad',
    icon: 'key',
    title: clip(`${label} needs you to sign in again`, 120),
    detail: 'Whombat can’t use it until then.',
    link: { kind: 'tab', label: 'Sign in again', tab: 'settings' },
    nature: 'you',
    check: 'conn.signin',
    ignore: { lifts: 'fixed', words: 'Until you sign in again.' },
    badge: 'Needs you to sign in again',
  };
}

/** One tier for a group of tools: theirs when they agree, else `mixed`. */
function groupTier(tiers: readonly ThingPageAccessItem['tier'][]): ThingPageAccessItem['tier'] {
  const set = new Set(tiers);
  return set.size === 1 ? (tiers[0] as ThingPageAccessItem['tier']) : 'mixed';
}

const TIER_OF = { can: 'allowed', ask: 'ask', off: 'off' } as const;

/**
 * What Whombat may do (CP-06): its tools grouped as reads, changes and those that always ask, with their tier; on Look
 * only every change is off. `labels` names a tool's own row (a device's actions).
 */
export function accessItems(
  entry: CatalogEntry,
  row: Pick<CatalogConnectionRow, 'access'>,
  tools: readonly Pick<ConnectionToolRow, 'name' | 'access' | 'tier' | 'origin'>[],
  labels: ReadonlyMap<string, string> = new Map(),
): ThingPageAccessItem[] {
  const items: ThingPageAccessItem[] = [];
  const reads = tools.filter((t) => t.access === 'read');
  const always = tools.filter((t) => t.access !== 'read' && toolRowAlwaysAsks(entry, t));
  const changes = tools.filter((t) => t.access !== 'read' && !always.includes(t) && !labels.has(t.name));
  const named = tools.filter((t) => t.access !== 'read' && labels.has(t.name) && !always.includes(t));
  const tierOf = (t: Pick<ConnectionToolRow, 'access' | 'tier'>) =>
    t.access !== 'read' && row.access === 'read' ? 'off' : TIER_OF[t.tier];
  if (reads.length) items.push({ label: 'Read', tier: groupTier(reads.map(tierOf)), count: reads.length });
  for (const t of named.slice(0, 5))
    items.push({ label: clip(labels.get(t.name) as string, 80), tier: tierOf(t), count: 1 });
  if (changes.length)
    items.push({ label: 'Change', tier: groupTier(changes.map(tierOf)), count: changes.length });
  if (always.length)
    items.push({
      label: 'Always asks first',
      tier: groupTier(always.map((t) => (tierOf(t) === 'off' ? 'off' : 'ask'))),
      count: always.length,
    });
  return items.slice(0, 8);
}

/** Where a panel sits when its builder didn't say (DS-04): figures on top, charts in rows, notices beside. */
function defaultPlace(p: ThingPagePanel): ThingPanelPlace {
  if (p.kind === 'kpis') return 'top';
  if (p.kind === 'chart') return 'chart';
  if (p.kind === 'notices') return 'side';
  if (p.kind === 'widgets') return 'bottom';
  return 'main';
}

/**
 * Panels in rows of three columns (DS-04): chart cards, and any other panel placed in a row (a service's slots), each
 * row filled in order; a card that doesn't fit leaves its place to a later one that does, and the last card of a row
 * that stays short widens to fill it — no hole beside a card.
 */
export function packCharts<T extends ThingPagePanel>(charts: readonly T[]): T[] {
  const left = charts.map((c) => ({ ...c, span: Math.min(3, Math.max(1, c.span ?? 1)) as 1 | 2 | 3 }));
  const out: T[] = [];
  while (left.length) {
    const row: T[] = [];
    let free = 3;
    for (let i = 0; i < left.length && free > 0; ) {
      const c = left[i] as T;
      if ((c.span ?? 1) <= free) {
        row.push(c);
        free -= c.span ?? 1;
        left.splice(i, 1);
      } else if (!row.length) {
        row.push(c);
        free = 0;
        left.splice(i, 1);
      } else i++;
    }
    // A short row widens its last chart (a Trend reads better wide), else its last card.
    const lastCard = ([...row].reverse().find((c) => c.kind === 'chart') ?? row[row.length - 1]) as T;
    if (free > 0) {
      lastCard.span = Math.min(3, (lastCard.span ?? 1) + free) as 1 | 2 | 3;
      // A list of bars that takes a wider share (the machine card alone in its row) lays its lines side by side
      // rather than stretching each across the page.
      const bars = lastCard as ThingPagePanel;
      if (bars.kind === 'bars' && !bars.columns && bars.items.length > 1)
        bars.columns = Math.min(lastCard.span, bars.items.length);
    }
    out.push(...row);
  }
  return out;
}

const PLACE_ORDER: Record<ThingPanelPlace, number> = { top: 0, chart: 1, side: 2, main: 3, bottom: 5 };

/** The charts a Summary's figures open: the shared rule (`openThingFigures`, `@whombat/core`). */
export const openFigures = openThingFigures;

/**
 * A Summary's panels in their places (DS-04, CT-394): each gets its `place` (and a chart its `span`), in the order a
 * phone stacks them — figures, charts, “Worth a look”, the main column, the rest of the side column, the bottom.
 * `width` stays for 0.88 clients: whole width on top, below and for charts, wide for main and narrow for side, paired
 * as before (a wide and the narrow after it, or the other way round, share a row; one left alone is whole width).
 * The figures name the charts they open first (`openFigures`; `tabs`, the page's tab keys).
 */
export function layout(panels: readonly ThingPagePanel[], tabs: readonly string[] = []): ThingPagePanel[] {
  const placed = openFigures(panels, tabs).map(
    (p) => ({ ...p, place: p.place ?? defaultPlace(p) }) as ThingPagePanel,
  );
  const rank = (p: ThingPagePanel) =>
    p.place === 'side' ? (p.kind === 'notices' ? 2 : 4) : PLACE_ORDER[p.place as ThingPanelPlace];
  const ordered = placed
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p);
  const rows = packCharts(ordered.filter((p) => p.place === 'chart'));
  let c = 0;
  const out = ordered.map((p) => (p.place === 'chart' ? (rows[c++] as ThingPagePanel) : p));
  for (const p of out) p.width = p.place === 'main' ? 'wide' : p.place === 'side' ? 'narrow' : 'full';
  for (let i = 0; i < out.length; i++) {
    const a = out[i] as ThingPagePanel;
    const b = out[i + 1];
    if (a.width === 'full') continue;
    if (b && b.width !== 'full' && !(a.width === 'wide' && b.width === 'wide')) {
      i++;
      continue;
    }
    a.width = 'full';
  }
  return out;
}
