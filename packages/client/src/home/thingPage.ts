/**
 * A connection's or device's own page (contracts 0.88, CT-390; Whombat connection-pages.md CP-01…CP-07): the tabs a
 * client shows (the server's, then Activity and Settings), the panels laid out in rows (a wide panel and the narrow one
 * after it share a row on the web), the words a page needs beside the server's, and its head from a list the app holds
 * before it answers (app page-speed.md AP-2650). Pure; web and phone share it.
 */
import {
  type ChatSubject,
  parseThingId,
  type ThingPage,
  type ThingPageAccessItem,
  type ThingPagePanel,
  type ThingPageTab,
  type ThingSeriesColor,
  type ThingStatus,
  type ThingSummary,
  thingPanelPlace,
  thingPanelSpan,
} from '@whombat/core';
import {
  type ConnectionView,
  catalogEntry,
  connectionHost,
  type HostGuest,
  type HostServer,
  noticeNature,
} from '@whombat/core/domain';
import { daysAgo, formatClock, formatDate, toDate } from '@whombat/core/text';
import { guestKindText } from '../hosts/model';
import { STATUS_LEVEL_WORDS, thingStatusLevel } from './statusLevel';
import { THING_STATUS_LABELS } from './things';

/** A tab as the clients draw it: the server's, or one of their own. */
export interface ThingTabView {
  key: string;
  label: string;
  count: number | null;
  /** `activity` and `settings` are drawn by the client; the server's carry panels. */
  own: 'activity' | 'settings' | null;
  /**
   * The server a tab of the server's is about (`ThingPageTab.server`): the apps draw it themselves from that server's
   * own reads (Find My's tab names its Mac). Null: the tab is its panels.
   */
  server: string | null;
}

export const THING_ACTIVITY_TAB = 'activity';
export const THING_SETTINGS_TAB = 'settings';

/** The page's tabs: the server's in its order, then Activity, then Connection when the page has one. */
export function thingTabs(page: Pick<ThingPage, 'tabs' | 'settings'>): ThingTabView[] {
  const tabs: ThingTabView[] = page.tabs
    .filter((t) => t.key !== THING_ACTIVITY_TAB && t.key !== THING_SETTINGS_TAB)
    .map((t) => ({
      key: t.key,
      label: t.label,
      count: t.count ?? null,
      own: null,
      server: t.server ?? null,
    }));
  tabs.push({ key: THING_ACTIVITY_TAB, label: 'Activity', count: null, own: 'activity', server: null });
  // The connection's own settings: “Connection”, beside a service's own settings tab (service-settings.md SST-06).
  if (page.settings)
    tabs.push({ key: THING_SETTINGS_TAB, label: 'Connection', count: null, own: 'settings', server: null });
  return tabs;
}

/** The tab an address asks for, if the page has it; else the first (Overview). */
export function parseThingTab(
  page: Pick<ThingPage, 'tabs' | 'settings'>,
  wanted: string | null | undefined,
): string {
  const tabs = thingTabs(page);
  return tabs.find((t) => t.key === wanted)?.key ?? tabs[0]?.key ?? 'overview';
}

/** The server's tab by key (null for the clients' own tabs). */
export function serverTab(page: Pick<ThingPage, 'tabs'>, key: string): ThingPageTab | null {
  return page.tabs.find((t) => t.key === key) ?? null;
}

/**
 * Panels in rows for the web's grid: a `wide` panel followed by a `narrow` one share a row (`[wide, narrow]`), and so
 * do two `narrow` ones; everything else is a row of its own. Phones stack the flattened list.
 */
export function panelRows(panels: readonly ThingPagePanel[]): ThingPagePanel[][] {
  const rows: ThingPagePanel[][] = [];
  for (let i = 0; i < panels.length; i++) {
    const a = panels[i] as ThingPagePanel;
    const b = panels[i + 1];
    const wa = a.width ?? 'full';
    const wb = b?.width ?? 'full';
    if (
      b &&
      ((wa === 'wide' && wb === 'narrow') ||
        (wa === 'narrow' && wb === 'narrow') ||
        (wa === 'narrow' && wb === 'wide'))
    ) {
      rows.push([a, b]);
      i++;
    } else rows.push([a]);
  }
  return rows;
}

/** A chart-placed panel and how many of a row's three columns it takes. */
export interface PlacedChart {
  panel: ThingPagePanel;
  span: 1 | 2 | 3;
}

/**
 * A Summary's panels where they sit on a wide screen (dashboards.md DS-01, DS-04; CT-394; AP-2003): every `top` panel
 * (figures, a banner), chart rows of three columns filled in order (a panel that doesn't fit the row starts the next),
 * the `main` and `side` columns that stack their own panels, then the `bottom`. A 0.88 page without places is laid out
 * from `width` (`thingPanelPlace`; a `full` panel is `top` before any chart and `bottom` after one). Each list keeps
 * the panels' order. Phones don't use it: they stack the panels in the order given.
 */
export interface PlacedPanels {
  top: ThingPagePanel[];
  chart: PlacedChart[][];
  main: ThingPagePanel[];
  side: ThingPagePanel[];
  bottom: ThingPagePanel[];
}

export function placePanels(panels: readonly ThingPagePanel[]): PlacedPanels {
  const out: PlacedPanels = { top: [], chart: [], main: [], side: [], bottom: [] };
  let afterChart = false;
  let row: PlacedChart[] = [];
  let used = 0;
  for (const panel of panels) {
    const place = thingPanelPlace(panel, afterChart);
    if (place === 'chart') {
      const span = thingPanelSpan(panel);
      if (used + span > 3 && row.length) {
        out.chart.push(row);
        row = [];
        used = 0;
      }
      row.push({ panel, span });
      used += span;
    } else out[place].push(panel);
    if (place === 'chart' || panel.kind === 'chart') afterChart = true;
  }
  if (row.length) out.chart.push(row);
  return out;
}

/**
 * The charts a Summary's figures open (contracts 0.94 CT-449; Whombat connections-page.md CN-05; app
 * connections-page.md AP-2510): each figure that names charts, with those of the page's chart panels it names, in its
 * order; and the panels left to lay out, every one but those charts. A chart no figure names stays a card of its own;
 * a figure whose charts are all missing opens nothing. Web and phone share it.
 */
export interface FigureCharts {
  /** A figure's key → its charts (only figures with at least one). */
  open: Record<string, ChartPanel[]>;
  panels: ThingPagePanel[];
}

export function figureCharts(panels: readonly ThingPagePanel[]): FigureCharts {
  const byId = new Map<string, ChartPanel>();
  for (const p of panels) if (p.kind === 'chart') byId.set(p.id, p);
  const open: Record<string, ChartPanel[]> = {};
  const taken = new Set<string>();
  for (const p of panels) {
    if (p.kind !== 'kpis') continue;
    for (const k of p.items) {
      const charts = (k.charts ?? []).flatMap((id) => {
        const chart = byId.get(id);
        if (!chart || taken.has(id)) return [];
        taken.add(id);
        return [chart];
      });
      if (charts.length) open[k.key] = charts;
    }
  }
  return { open, panels: panels.filter((p) => !(p.kind === 'chart' && taken.has(p.id))) };
}

/**
 * A line's, bar's or small line's colour as a token name (CT-395, DS-06; AP-2004): blue, orange, green and violet the
 * chart colours (`--chart1`…`--chart4`, `theme.chart.*`), amber the warning colour (`warn`), red the serious one
 * (`bad`), grey the muted ink (`mut`). Without a colour: the chart colours in order by `index`.
 */
export type ThingSeriesToken = 'chart1' | 'chart2' | 'chart3' | 'chart4' | 'warn' | 'bad' | 'mut';

export const THING_SERIES_TOKENS: Record<ThingSeriesColor, ThingSeriesToken> = {
  blue: 'chart1',
  orange: 'chart2',
  green: 'chart3',
  violet: 'chart4',
  amber: 'warn',
  red: 'bad',
  grey: 'mut',
};

const SERIES_ORDER: readonly ThingSeriesToken[] = ['chart1', 'chart2', 'chart3', 'chart4'];

export function thingSeriesToken(color: ThingSeriesColor | null | undefined, index = 0): ThingSeriesToken {
  return color ? THING_SERIES_TOKENS[color] : (SERIES_ORDER[index % SERIES_ORDER.length] ?? 'chart1');
}

/** What a “Show more here” chip sends to Whombat. */
export function keepHereQuestion(suggestion: string, name: string): string {
  return `Keep “${suggestion}” on the ${name} page.`;
}

/** The badge's tone for a page's status: a problem or an unreachable thing is `bad`, not checked or learning muted. */
export function thingBadgeTone(status: ThingStatus): 'ok' | 'warn' | 'bad' | 'mut' {
  switch (status) {
    case 'ok':
    case 'warn':
    case 'bad':
      return status;
    case 'offline':
      return 'bad';
    default:
      return 'mut';
  }
}

/** What an Ask chat about the thing is about: the connection or device by its own id (`con_…`, `dvp_…`). */
export function thingSubject(page: Pick<ThingPage, 'id' | 'kind' | 'name'>): ChatSubject {
  const parsed = parseThingId(page.id);
  return {
    kind: page.kind === 'device' ? 'device' : 'connection',
    id: parsed?.id ?? page.id,
    name: page.name,
  };
}

/* Before the page answers (app page-speed.md AP-2650…AP-2653) ------------------------------------------------------- */

/**
 * A thing page's head before `things.page` answers (AP-2650): the thing as a list the app already holds says it — its
 * name, what it is (the page's `icon`, `catalogId` and `kind`, so the same glyph or mark) and how it is.
 */
export interface ThingHeadPreview extends Pick<ThingPage, 'id' | 'kind' | 'name' | 'icon' | 'catalogId'> {
  /** Null when the list doesn't say how it is (`connections.list`): no badge until the page answers (AP-2652). */
  status: ThingStatus | null;
  /** The badge's words: the status's, as the sidebar says them (`THING_STATUS_LABELS`); null without a status. */
  badge: string | null;
}

/** The thing as Home's things list it (the sidebar's and Connections' rows; AP-2651), by its thingId; else null. */
export function thingHeadFromThings(
  things: readonly ThingSummary[],
  thingId: string,
): ThingHeadPreview | null {
  const t = things.find((x) => x.id === thingId);
  if (!t) return null;
  return {
    id: t.id,
    kind: t.kind,
    name: t.name,
    icon: t.icon,
    ...(t.catalogId ? { catalogId: t.catalogId } : {}),
    status: t.status,
    badge: THING_STATUS_LABELS[t.status],
  };
}

/**
 * A connection's page head as `connections.list` lists it (Settings → Connections, an agent's LOOKS AFTER; AP-2651), for
 * a `connection:con_…` thingId: named as the page names it (the label without the address it ends with, the server's
 * `displayName`), its icon its catalog entry, without a status. A device's head isn't drawn from it: its page's icon is
 * the device's, not the entry's.
 */
export function thingHeadFromConnections(
  connections: readonly Pick<ConnectionView, 'id' | 'catalogId' | 'label' | 'fields'>[],
  thingId: string,
): ThingHeadPreview | null {
  const parsed = parseThingId(thingId);
  if (parsed?.kind !== 'connection') return null;
  const c = connections.find((x) => x.id === parsed.id);
  if (!c) return null;
  return {
    id: thingId,
    kind: 'connection',
    name: connectionPageName(c),
    icon: c.catalogId.slice(0, 40),
    ...(/^[a-z][a-z0-9_]{1,30}$/.test(c.catalogId) ? { catalogId: c.catalogId } : {}),
    status: null,
    badge: null,
  };
}

/** A connection's name as its page says it: the label without the host (with or without its port) it ends with. */
function connectionPageName(c: Pick<ConnectionView, 'catalogId' | 'label' | 'fields'>): string {
  const entry = catalogEntry(c.catalogId);
  const host = entry ? connectionHost(entry, c.fields) : null;
  for (const h of [host, host?.replace(/:\d+$/, '')])
    if (h && c.label.endsWith(` · ${h}`) && c.label.length > h.length + 3)
      return c.label.slice(0, -(h.length + 3));
  return c.label;
}

/**
 * What it runs on split into the machine and its server: “homeassistant (pve-02)” as the runtime names it, or an older
 * runtime's “pve-02 · CT 131”; the server's name is set in the mono face.
 */
export function runsOnParts(name: string): { server: string; rest: string | null } {
  const named = /^(.+) \(([^()]+)\)$/.exec(name);
  if (named) return { server: named[2] as string, rest: named[1] as string };
  const i = name.indexOf(' · ');
  return i < 0 ? { server: name, rest: null } : { server: name.slice(0, i), rest: name.slice(i + 3) };
}

/**
 * A service page's head facts (docs/decisions/ui-refresh-chat.md, web and phone): when it was last checked stays on the
 * first line, by the status, what it runs on and its address; the rest (its version, Docker, its database, how long it
 * has been up, what Whombat may do) goes under “More detail”.
 */
export function headFacts(facts: readonly ThingPage['facts'][number][]): {
  checked: ThingPage['facts'][number] | null;
  detail: ThingPage['facts'][number][];
} {
  const text = (f: ThingPage['facts'][number]) => f.map((p) => p.text).join('');
  const checked = facts.find((f) => /^Checked\b/.test(text(f))) ?? null;
  return { checked, detail: facts.filter((f) => f !== checked) };
}

/**
 * Whether the page's Summary tells what isn't fine itself: a Worth a look panel with something in it
 * (servers-connections-places.md).
 */
export function pageTellsProblem(page: Pick<ThingPage, 'tabs'>): boolean {
  const summary = page.tabs[0];
  // A quiet heads-up is folded away and an FYI isn't a problem: neither tells it.
  return !!summary?.panels.some(
    (p) => p.kind === 'notices' && p.items.some((i) => !i.quiet && noticeNature(i) !== 'fyi'),
  );
}

/**
 * The status word in a page's head: none when it is fine; only the level's word (“Needs a look”,
 * “Offline”) when the page's Worth a look tells why, so the reason is said once; else the page's own badge, the only
 * place it is said. Before the page answers (no tabs yet) the level's word too, so the head doesn't change its words when
 * the page comes.
 */
export function pageHeadBadge(
  page: Pick<ThingPage, 'status' | 'badge'> & Partial<Pick<ThingPage, 'tabs' | 'causedBy'>>,
): string | null {
  if (page.status === 'ok') return null;
  // Not known yet, being learned, or down because of something else: its own words say what to look at.
  if (page.status === 'unknown' || page.status === 'learning') return page.badge;
  if (page.causedBy && page.causedBy.kind !== 'quiet') return page.badge;
  if (page.tabs && !pageTellsProblem({ tabs: page.tabs })) return page.badge;
  if (page.status === 'offline') return THING_STATUS_LABELS.offline;
  return STATUS_LEVEL_WORDS[thingStatusLevel(page.status)];
}

/**
 * The sentence under a page's name: none while it isn't fine and its Worth a look already tells why, so the problem is
 * said once; else the page's own verdict.
 */
export function pageHeadVerdict(
  page: Pick<ThingPage, 'status' | 'tabs'> & { verdict?: string | null },
): string | null {
  const verdict = page.verdict?.trim() || null;
  if (!verdict || page.status === 'ok') return verdict;
  return pageTellsProblem(page) ? null : verdict;
}

/** A list line's time on the right: `Today 07:31`, else the date (`17 Oct`). */
export function itemWhen(at: string, now: Date | number, timeZone: string): string {
  if (daysAgo(at, now, timeZone) <= 0) return `Today ${formatClock(at, timeZone)}`;
  return formatDate(at, timeZone, { now: toDate(now) });
}

/** A tool group's tier in words, as Settings → Connections says them (`Allowed`, `Asks you`, `Off`). */
export const THING_ACCESS_TIER_WORDS: Record<ThingPageAccessItem['tier'], string> = {
  allowed: 'Allowed',
  ask: 'Asks you',
  off: 'Off',
  mixed: 'Some ask',
};

/* Charts ------------------------------------------------------------------------------------------- */

type ChartPanel = Extract<ThingPagePanel, { kind: 'chart' }>;

/** A line's colour: the chart tokens in order on the left axis, the fourth (`--chart4`, violet) on the right. */
export type ThingChartColor = 'chart1' | 'chart2' | 'chart3' | 'chart4';

export interface ThingChartAxis {
  min: number;
  max: number;
  ticks: number[];
  label: (v: number) => string;
}

export interface ThingChartLine {
  key: string;
  label: string;
  unit: string | null;
  axis: 'left' | 'right';
  color: ThingChartColor;
  /** An area wash under it: the right axis's line (drawn behind), else the first line. */
  area: boolean;
  /** As read, oldest first (null: nothing read then). */
  values: (number | null)[];
  /** On the left axis's scale, where a chart draws it: a right-axis line mapped onto the left. */
  plotted: (number | null)[];
  /** The legend's figure (“5 %”, “3.0 GB”), null when there is none. */
  latest: string | null;
  /** A value in words, for the tooltip: “5 %”, “3.0 GB”. */
  format: (v: number) => string;
  /** A plotted value (on the left axis's scale) in this line's own words: what a chart's tooltip says. */
  formatPlotted: (v: number) => string;
}

export interface ThingChartModel {
  /** In the panel's order (the legend). */
  lines: ThingChartLine[];
  /** In drawing order: the right axis's lines first, behind the left's. */
  drawn: ThingChartLine[];
  left: ThingChartAxis;
  right: ThingChartAxis | null;
  /** The dashed line where it gets serious, on the left axis. */
  line: { value: number; label: string | null } | null;
  times: number[];
  empty: boolean;
}

const NBSP = '\u00a0';
const NICE = [1, 2, 2.5, 5, 10];

/** The smallest round step (1, 2, 2.5, 5 × 10ⁿ) of at least `raw`. */
function niceAtLeast(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw > 0 ? raw : 1));
  for (const m of NICE) if (m * pow >= raw - 1e-12) return m * pow;
  return 10 * pow;
}

/** A tick's number: whole, or with the decimals its step needs (`2.5`, `7.25`). */
function tickNumber(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * An axis's word, in the room an axis has (about five letters): `50%` and `72°` dense as the mock writes them, a short
 * unit on the right axis after a space (`8 GB`), else the bare number — the panel's meta says the unit (“last 24 h ·
 * Mbit/s”).
 */
function tickWords(unit: string | null, side: 'left' | 'right'): (v: number) => string {
  if (unit === '%' || unit?.startsWith('°')) return (v) => `${tickNumber(v)}${unit}`;
  if (unit && side === 'right' && unit.length <= 2) return (v) => `${tickNumber(v)}${NBSP}${unit}`;
  return tickNumber;
}

/**
 * A round axis over `values` with `gaps` gaps (three gridlines for two), with 7 % room over the top: from 0 (or below
 * for a negative), a percentage at most 100; readings that stay far from 0 (a pool's pH 7.2…7.6, the lowest above half
 * the highest; never a percentage) get an axis around them instead, or their line would be flat.
 */
function axisOver(
  values: readonly number[],
  unit: string | null,
  gaps: number,
): Omit<ThingChartAxis, 'label'> {
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const least = values.length ? Math.min(...values) : 0;
  const near = unit !== '%' && least > 0 && least > hi / 2;
  const span = hi - least || Math.abs(hi) || 1;
  const bottom = near ? least - span * 0.1 : lo;
  const top = near
    ? hi + span * 0.07
    : Math.max(unit === '%' && hi <= 100 ? Math.min(100, hi * 1.07) : hi * 1.07, lo < 0 ? 0 : 1e-9);
  let step = niceAtLeast((top - bottom) / gaps || 1);
  let min = Math.floor(bottom / step) * step;
  while (min + step * gaps < top - 1e-9) {
    step = niceAtLeast(step * 1.01);
    min = Math.floor(bottom / step) * step;
  }
  const ticks = Array.from({ length: gaps + 1 }, (_, k) => Math.round((min + k * step) * 1000) / 1000);
  return { min, max: min + step * gaps, ticks };
}

function decimalsOf(values: readonly (number | null)[]): 0 | 1 {
  return values.some((v) => v !== null && Math.abs(v - Math.round(v)) > 1e-9) ? 1 : 0;
}

function lastOf(values: readonly (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i] as number;
  return null;
}

const LEFT_COLORS: ThingChartColor[] = ['chart1', 'chart2', 'chart3'];

/**
 * A chart panel as the clients draw it (connection-pages.md CP-07, CP-09): one or two value axes with three gridlines
 * each, the right axis's lines mapped onto the left's scale so one plot draws them all, every value in words with its
 * unit, and the legend's latest figures (the server's when it sent them).
 */
export function thingChartModel(panel: Pick<ChartPanel, 'series' | 'timestamps' | 'line'>): ThingChartModel {
  const numbers = (axis: 'left' | 'right') =>
    panel.series
      .filter((s) => (s.axis ?? 'left') === axis)
      .flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const leftSeries = panel.series.filter((s) => (s.axis ?? 'left') === 'left');
  const rightSeries = panel.series.filter((s) => s.axis === 'right');
  // A chart whose every line is on the right is a one-axis chart: its lines go on the left.
  const twoAxes = leftSeries.length > 0 && rightSeries.length > 0;
  const leftUnit = (twoAxes ? leftSeries : panel.series)[0]?.unit ?? null;
  const leftValues = twoAxes ? numbers('left') : [...numbers('left'), ...numbers('right')];
  const left = axisOver(panel.line ? [...leftValues, panel.line.value] : leftValues, leftUnit, 2);
  const rightUnit = twoAxes ? (rightSeries[0]?.unit ?? null) : null;
  const right = twoAxes ? axisOver(numbers('right'), rightUnit, left.ticks.length - 1) : null;
  const toLeft = (v: number) =>
    right ? left.min + ((v - right.min) / (right.max - right.min || 1)) * (left.max - left.min) : v;
  const fromLeft = (v: number) =>
    right ? right.min + ((v - left.min) / (left.max - left.min || 1)) * (right.max - right.min) : v;
  let leftColor = 0;
  let rightColor = 0;
  const lines = panel.series.map((s, i): ThingChartLine => {
    const axis = twoAxes && s.axis === 'right' ? 'right' : 'left';
    const unit = s.unit ?? null;
    const values = s.values.map((v) => (v !== null && Number.isFinite(v) ? v : null));
    const decimals = decimalsOf(values);
    const format = (v: number) => {
      const n = decimals ? v.toFixed(1) : String(Math.round(v));
      return unit ? `${n}${NBSP}${unit}` : n;
    };
    const last = lastOf(values);
    const color =
      axis === 'right'
        ? ((['chart4', 'chart3'] as const)[rightColor++] ?? 'chart3')
        : (LEFT_COLORS[leftColor++] ?? 'chart3');
    return {
      key: s.key,
      label: s.label,
      unit,
      axis,
      color,
      area: twoAxes ? axis === 'right' && s === rightSeries[0] : i === 0,
      values,
      plotted: axis === 'right' ? values.map((v) => (v === null ? null : toLeft(v))) : values,
      latest: s.latest ?? (last === null ? null : format(last)),
      format,
      formatPlotted: axis === 'right' ? (v) => format(fromLeft(v)) : format,
    };
  });
  const times = panel.timestamps.map((t) => toDate(t).getTime());
  return {
    lines,
    drawn: [...lines.filter((l) => l.axis === 'right'), ...lines.filter((l) => l.axis === 'left')],
    left: { ...left, label: tickWords(leftUnit, 'left') },
    right: right ? { ...right, label: tickWords(rightUnit, 'right') } : null,
    line: panel.line ? { value: panel.line.value, label: panel.line.label ?? null } : null,
    times,
    empty: lines.every((l) => l.values.every((v) => v === null)),
  };
}

/* What it runs on (CP-08) ------------------------------------------------------------------------- */

export interface RunsOnChoice {
  serverId: string;
  /** The guest's id, or null for the server itself. */
  guestId: string | null;
  name: string;
  /** “CT 131”, “VM 118”, “Docker”; the server's own line (its system). */
  note: string | null;
  /** What it is called once chosen: “homeassistant (pve-02)”, “pve-02”. */
  label: string;
}

export interface RunsOnServerChoices {
  server: RunsOnChoice;
  guests: RunsOnChoice[];
}

/**
 * The runs-on picker's choices: every server Whombat watches with its guests under it, in the fleet's order and the
 * guests by name. `query` keeps a server whose name has it with all its guests, else the guests whose name or kind
 * (“CT 131”) has it under their server.
 */
export function runsOnChoices(
  servers: readonly Pick<HostServer, 'id' | 'name' | 'os'>[],
  guests: readonly Pick<HostGuest, 'id' | 'serverId' | 'name' | 'platform' | 'kind' | 'vmid'>[],
  query = '',
): RunsOnServerChoices[] {
  const q = query.trim().toLowerCase();
  const out: RunsOnServerChoices[] = [];
  for (const s of servers) {
    const server: RunsOnChoice = { serverId: s.id, guestId: null, name: s.name, note: s.os, label: s.name };
    const all = guests
      .filter((g) => g.serverId === s.id)
      .map((g): RunsOnChoice => {
        const note = guestKindText(g);
        return { serverId: s.id, guestId: g.id, name: g.name, note, label: `${g.name || note} (${s.name})` };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) {
      out.push({ server, guests: all });
      continue;
    }
    const found = all.filter((g) => `${g.name} ${g.note ?? ''}`.toLowerCase().includes(q));
    if (found.length) out.push({ server, guests: found });
  }
  return out;
}
