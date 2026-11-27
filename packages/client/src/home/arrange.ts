/**
 * Arranging the Overview (Whombat docs/decisions/overview-arranged.md): the tiles in their arranged order with what each
 * shows and its size, the four figures at the top, the pinned charts' widths, the edits Arrange makes to them, the
 * desk-screen widgets `overview.views` reads for them, and the words. Pure; the web and the phone arrange the same.
 */
import {
  type DeskWidgetView,
  type HomeOverview,
  OVERVIEW_THING_RE,
  type OverviewLayout,
  type OverviewLayoutPin,
  type OverviewLayoutTile,
  type OverviewLayoutTop,
  type OverviewOwnFigure,
  type OverviewRange,
  type OverviewShow,
  type OverviewTileSize,
  overviewShowId,
} from '@whombat/core';
import type { HostServer } from '@whombat/core/domain';
import { clientTranslator, EN } from '../i18n/catalog';
import type { HomeThingRow } from './sections';

/* Words ----------------------------------------------------------------------------------------------------------- */

export const ARRANGE_WORDS = {
  arrange: EN['arrange.arrange'],
  done: EN['arrange.done'],
  arrangeLabel: EN['arrange.arrangeLabel'],
  doneLabel: EN['arrange.doneLabel'],
  barTitle: EN['arrange.barTitle'],
  barBody: EN['arrange.barBody'],
  barBodyPhone: EN['arrange.barBodyPhone'],
  same: EN['arrange.same'],
  add: EN['arrange.add'],
  addLine: (removed: number) => (removed ? `${removed} removed` : 'What you remove waits here'),
  addEmpty: EN['arrange.addEmpty'],
  addTiles: EN['arrange.addTiles'],
  addPins: EN['arrange.addPins'],
  changeTile: (name: string) => `Change the ${name} tile`,
  changeFigure: EN['arrange.changeFigure'],
  changePin: (title: string) => `Change ${title}`,
  figureTitle: EN['arrange.figureTitle'],
  figureSub: (n: number) => `Figure ${n} of 4`,
  pinSub: EN['arrange.pinSub'],
  shows: EN['arrange.shows'],
  span: EN['arrange.span'],
  size: EN['arrange.size'],
  width: EN['arrange.width'],
  place: EN['arrange.place'],
  earlier: EN['arrange.earlier'],
  later: EN['arrange.later'],
  remove: EN['arrange.remove'],
  close: EN['arrange.close'],
  own: EN['arrange.own'],
  shownAlready: EN['arrange.shownAlready'],
  reading: EN['arrange.reading'],
  couldntRead: EN['arrange.couldntRead'],
  couldntSave: EN['arrange.couldntSave'],
  mainFigures: EN['arrange.mainFigures'],
  sizes: { s: EN['arrange.sizes.s'], w: EN['arrange.sizes.w'], l: EN['arrange.sizes.l'] } satisfies Record<
    OverviewTileSize,
    string
  >,
  pinSizes: { half: EN['arrange.pinSizes.half'], full: EN['arrange.pinSizes.full'] },
  ranges: {
    '1h': EN['arrange.ranges.1h'],
    '24h': EN['arrange.ranges.24h'],
    '7d': EN['arrange.ranges.7d'],
  } satisfies Record<OverviewRange, string>,
  ownNames: {
    servers: EN['arrange.ownNames.servers'],
    connections: EN['arrange.ownNames.connections'],
    needsYou: EN['arrange.ownNames.needsYou'],
    doneToday: EN['arrange.ownNames.doneToday'],
  } satisfies Record<OverviewOwnFigure, string>,
} as const;

export function arrangeWords(locale?: string | null) {
  const tr = clientTranslator(locale);
  if (tr.language === 'en') return ARRANGE_WORDS;
  return {
    arrange: tr.t('arrange.arrange'),
    done: tr.t('arrange.done'),
    arrangeLabel: tr.t('arrange.arrangeLabel'),
    doneLabel: tr.t('arrange.doneLabel'),
    barTitle: tr.t('arrange.barTitle'),
    barBody: tr.t('arrange.barBody'),
    barBodyPhone: tr.t('arrange.barBodyPhone'),
    same: tr.t('arrange.same'),
    add: tr.t('arrange.add'),
    addLine: (removed: number) =>
      removed ? tr.t('arrange.addLine', { removed }) : tr.t('arrange.addLineEmpty'),
    addEmpty: tr.t('arrange.addEmpty'),
    addTiles: tr.t('arrange.addTiles'),
    addPins: tr.t('arrange.addPins'),
    changeTile: (name: string) => tr.t('arrange.changeTile', { name }),
    changeFigure: tr.t('arrange.changeFigure'),
    changePin: (title: string) => tr.t('arrange.changePin', { title }),
    figureTitle: tr.t('arrange.figureTitle'),
    figureSub: (n: number) => tr.t('arrange.figureSub', { n }),
    pinSub: tr.t('arrange.pinSub'),
    shows: tr.t('arrange.shows'),
    span: tr.t('arrange.span'),
    size: tr.t('arrange.size'),
    width: tr.t('arrange.width'),
    place: tr.t('arrange.place'),
    earlier: tr.t('arrange.earlier'),
    later: tr.t('arrange.later'),
    remove: tr.t('arrange.remove'),
    close: tr.t('arrange.close'),
    own: tr.t('arrange.own'),
    shownAlready: tr.t('arrange.shownAlready'),
    reading: tr.t('arrange.reading'),
    couldntRead: tr.t('arrange.couldntRead'),
    couldntSave: tr.t('arrange.couldntSave'),
    mainFigures: tr.t('arrange.mainFigures'),
    sizes: {
      s: tr.t('arrange.sizes.s'),
      w: tr.t('arrange.sizes.w'),
      l: tr.t('arrange.sizes.l'),
    },
    pinSizes: {
      half: tr.t('arrange.pinSizes.half'),
      full: tr.t('arrange.pinSizes.full'),
    },
    ranges: {
      '1h': tr.t('arrange.ranges.1h'),
      '24h': tr.t('arrange.ranges.24h'),
      '7d': tr.t('arrange.ranges.7d'),
    },
    ownNames: {
      servers: tr.t('arrange.ownNames.servers'),
      connections: tr.t('arrange.ownNames.connections'),
      needsYou: tr.t('arrange.ownNames.needsYou'),
      doneToday: tr.t('arrange.ownNames.doneToday'),
    },
  };
}

/* The starting layout and the arranged order ---------------------------------------------------------------------- */

/** The figures at the top of an Overview nobody arranged. */
export const OVERVIEW_STARTING_TOP: readonly OverviewLayoutTop[] = [
  { own: 'servers' },
  { own: 'connections' },
  { own: 'needsYou' },
  { own: 'doneToday' },
];

/** Whether a thing of Home can be a tile (a connection, a device or an account; servers have their own section). */
export const isTileThing = (id: string) => OVERVIEW_THING_RE.test(id);

export interface ArrangedTile<T> {
  tile: OverviewLayoutTile;
  item: T;
}

/**
 * The tiles in their arranged order and the removed ones (for *Add to Overview*). Without a layout every thing is a small
 * tile with its figures, in the order it came (Overview's, worst first); a thing connected after the layout was saved is
 * a small one at the end. A layout's entry for a thing that is gone is left out.
 */
export function arrangeTiles<T extends { row: Pick<HomeThingRow, 'id'> }>(
  layout: OverviewLayout | null | undefined,
  items: readonly T[],
): { shown: ArrangedTile<T>[]; removed: ArrangedTile<T>[] } {
  const own = items.filter((i) => isTileThing(i.row.id));
  if (!layout)
    return { shown: own.map((item) => ({ tile: { thing: item.row.id, size: 's' }, item })), removed: [] };
  const byId = new Map(own.map((i) => [i.row.id, i]));
  const shown: ArrangedTile<T>[] = [];
  const removed: ArrangedTile<T>[] = [];
  const placed = new Set<string>();
  for (const tile of layout.tiles) {
    const item = byId.get(tile.thing);
    if (!item || placed.has(tile.thing)) continue;
    placed.add(tile.thing);
    (tile.hidden ? removed : shown).push({ tile, item });
  }
  for (const item of own)
    if (!placed.has(item.row.id)) shown.push({ tile: { thing: item.row.id, size: 's' }, item });
  return { shown, removed };
}

/**
 * The whole layout as the page shows it now — every tile written down in its place — which an edit changes and
 * `overview.arrange` saves.
 */
export function layoutNow(
  layout: OverviewLayout | null | undefined,
  things: readonly Pick<HomeThingRow, 'id'>[],
): OverviewLayout {
  const { shown, removed } = arrangeTiles(
    layout,
    things.map((row) => ({ row })),
  );
  return {
    tiles: [...shown, ...removed].map((x) => x.tile),
    top: layout?.top?.length ? [...layout.top] : [...OVERVIEW_STARTING_TOP],
    pins: { ...(layout?.pins ?? {}) },
  };
}

/* Edits ----------------------------------------------------------------------------------------------------------- */

function withTile(layout: OverviewLayout, thing: string, f: (t: OverviewLayoutTile) => OverviewLayoutTile) {
  return { ...layout, tiles: layout.tiles.map((t) => (t.thing === thing ? f(t) : t)) };
}

/** What a tile shows: its main figures (no panel) or a panel, and its time span. */
export function showOnTile(layout: OverviewLayout, thing: string, show: OverviewShow): OverviewLayout {
  return withTile(layout, thing, ({ panel: _p, range: _r, ...t }) => ({
    ...t,
    ...(show.panel ? { panel: show.panel } : {}),
    ...(show.range ? { range: show.range } : {}),
  }));
}

export function rangeOfTile(layout: OverviewLayout, thing: string, range: OverviewRange): OverviewLayout {
  return withTile(layout, thing, (t) => ({ ...t, range }));
}

export function sizeTile(layout: OverviewLayout, thing: string, size: OverviewTileSize): OverviewLayout {
  return withTile(layout, thing, (t) => ({ ...t, size }));
}

/** Removed: it waits under *Add to Overview*. */
export function removeTile(layout: OverviewLayout, thing: string): OverviewLayout {
  return withTile(layout, thing, (t) => ({ ...t, hidden: true }));
}

/** Back on the Overview, after the last tile shown. */
export function addTile(layout: OverviewLayout, thing: string): OverviewLayout {
  const tile = layout.tiles.find((t) => t.thing === thing);
  if (!tile) return layout;
  const { hidden: _h, ...back } = tile;
  const rest = layout.tiles.filter((t) => t.thing !== thing);
  const at = rest.findIndex((t) => t.hidden);
  rest.splice(at === -1 ? rest.length : at, 0, back);
  return { ...layout, tiles: rest };
}

/** A tile dropped on another takes its place (the other and those after it move one on); on nothing, it goes last. */
export function moveTileTo(layout: OverviewLayout, thing: string, onto: string | null): OverviewLayout {
  if (thing === onto) return layout;
  const tile = layout.tiles.find((t) => t.thing === thing);
  if (!tile) return layout;
  const rest = layout.tiles.filter((t) => t.thing !== thing);
  let at = onto ? rest.findIndex((t) => t.thing === onto) : -1;
  if (at === -1) {
    at = rest.findIndex((t) => t.hidden);
    if (at === -1) at = rest.length;
  }
  // Dropped on the one just after it: it goes after that one (else nothing would move).
  const from = layout.tiles.indexOf(tile);
  if (onto && layout.tiles[from + 1]?.thing === onto) at += 1;
  rest.splice(at, 0, tile);
  return { ...layout, tiles: rest };
}

/** *Move earlier* (−1) or *Move later* (+1) among the tiles shown. */
export function moveTileBy(layout: OverviewLayout, thing: string, by: -1 | 1): OverviewLayout {
  const shown = layout.tiles.filter((t) => !t.hidden);
  const i = shown.findIndex((t) => t.thing === thing);
  const j = i + by;
  if (i === -1 || j < 0 || j >= shown.length) return layout;
  const order = [...shown];
  [order[i], order[j]] = [order[j] as OverviewLayoutTile, order[i] as OverviewLayoutTile];
  return { ...layout, tiles: [...order, ...layout.tiles.filter((t) => t.hidden)] };
}

/** One of the four figures at the top. */
export function setTopFigure(layout: OverviewLayout, index: number, top: OverviewLayoutTop): OverviewLayout {
  const next = [...layout.top];
  while (next.length <= index) next.push(OVERVIEW_STARTING_TOP[next.length] ?? { own: 'servers' });
  next[index] = top;
  return { ...layout, top: next.slice(0, 4) };
}

/** A pinned chart's width, or whether it is removed from the Overview. */
export function setPin(layout: OverviewLayout, id: string, patch: OverviewLayoutPin): OverviewLayout {
  const was = layout.pins[id] ?? {};
  const merged: OverviewLayoutPin = { ...was, ...patch };
  if (patch.hidden === undefined && 'hidden' in patch) delete merged.hidden;
  const pins = { ...layout.pins, [id]: merged };
  if (!merged.size && !merged.hidden) delete pins[id];
  return { ...layout, pins };
}

/** The pinned charts in their order, those removed from the Overview apart. */
export function arrangePins<T extends { id: string }>(
  layout: OverviewLayout | null | undefined,
  pins: readonly T[],
): { shown: (T & { size: 'half' | 'full' })[]; removed: T[] } {
  const shown: (T & { size: 'half' | 'full' })[] = [];
  const removed: T[] = [];
  for (const p of pins) {
    const own = layout?.pins?.[p.id];
    if (own?.hidden) removed.push(p);
    else shown.push({ ...p, size: own?.size ?? 'half' });
  }
  return { shown, removed };
}

/* The widgets `overview.views` reads ------------------------------------------------------------------------------ */

/** The widget id of what a tile or figure shows: the same thing, panel and span read once for both. */
export const showId = overviewShowId;

/** What to read for the tiles shown and the thing figures at the top, each once (`overview.views`' `show`). */
export function overviewShows(
  tiles: readonly OverviewLayoutTile[],
  top: readonly OverviewLayoutTop[],
): (OverviewShow & { thing: string })[] {
  const out = new Map<string, OverviewShow & { thing: string }>();
  const add = (x: OverviewShow & { thing: string }) => {
    const id = showId(x);
    if (!out.has(id) && isTileThing(x.thing))
      out.set(id, {
        thing: x.thing,
        ...(x.panel ? { panel: x.panel } : {}),
        ...(x.range ? { range: x.range } : {}),
      });
  };
  for (const t of tiles) if (!t.hidden) add(t);
  for (const f of top) if ('thing' in f) add(f);
  return [...out.values()];
}

/* Figures --------------------------------------------------------------------------------------------------------- */

export type FigureTone = 'ok' | 'warn' | 'bad' | 'off';

/** A figure as a tile's head or one of the four at the top draws it: “1.4” “kW” “Power now”, a line, a small chart. */
export interface FigureFace {
  value: string;
  unit: string | null;
  label: string;
  line: string | null;
  tone: FigureTone | null;
  /** Points for a small chart, oldest first. */
  spark: number[] | null;
  /** A bar of parts (fine, needs a look, wrong, off), for Whombat's own counts. */
  parts: { tone: FigureTone; n: number }[] | null;
}

const face = (f: Partial<FigureFace> & Pick<FigureFace, 'value' | 'label'>): FigureFace => ({
  unit: null,
  line: null,
  tone: null,
  spark: null,
  parts: null,
  ...f,
});

/** The figure a view leads with: its first figure, a chart's figure, a list's count, a server's processor. */
export function viewFace(view: DeskWidgetView): FigureFace | null {
  if (view.problem) return face({ value: '', label: view.title, line: view.problem.text, tone: 'warn' });
  switch (view.kind) {
    case 'figures': {
      const [first] = view.items;
      if (!first) return null;
      const rest = view.items
        .slice(1, 3)
        .map((i) => `${i.value}${i.unit ? ` ${i.unit}` : ''} ${i.label.toLowerCase()}`);
      return face({
        value: first.value,
        unit: first.unit ?? null,
        label: first.label,
        line: view.line ?? (rest.length ? rest.join(' · ') : null),
        tone: first.tone ?? view.tone ?? null,
        spark: view.spark?.length ? [...view.spark] : null,
      });
    }
    case 'chart': {
      const points = (view.series[0]?.points ?? []).filter((p): p is number => p !== null);
      return face({
        value: view.figure?.value ?? (points.length ? String(points[points.length - 1]) : '—'),
        unit: view.figure ? null : (view.unit ?? null),
        label: view.title,
        line: view.figure?.rest ?? view.stats?.[0] ?? null,
        tone: view.figure?.tone ?? view.tone ?? null,
        spark: points.length ? points : null,
      });
    }
    case 'list':
      return face({
        value: String(view.count ?? view.rows.length),
        label: view.title,
        line: view.head ?? view.rows[0]?.title ?? view.empty ?? null,
        tone: view.tone ?? null,
      });
    case 'board':
      return face({
        value: String(view.count ?? view.items.length),
        label: view.title,
        line: view.head ?? null,
        tone: view.tone ?? null,
      });
    case 'posters':
      return face({
        value: String(view.items.length),
        label: view.title,
        line: view.head ?? view.items[0]?.title ?? view.empty ?? null,
        tone: view.tone ?? null,
      });
    case 'server':
      return face({
        value: view.cpu !== undefined ? String(view.cpu) : '—',
        unit: view.cpu !== undefined ? '%' : null,
        label: view.title,
        line: view.say ?? view.line ?? null,
        tone: view.state,
        spark: view.spark?.length ? [...view.spark] : null,
      });
    case 'text':
      return face({ value: '', label: view.title, line: view.body, tone: view.tone ?? null });
    case 'camera':
      return face({ value: '', label: view.title, line: view.event ?? null, tone: view.tone ?? null });
    case 'photo':
      return face({
        value: '',
        label: view.title,
        line: view.items[0]?.caption ?? null,
        tone: view.tone ?? null,
      });
    default:
      return null;
  }
}

/** Whombat's own figures at the top, from Home and the servers. */
export function ownFace(
  own: OverviewOwnFigure,
  data: Pick<HomeOverview, 'summary' | 'doneToday'>,
  things: readonly Pick<HomeThingRow, 'id' | 'level' | 'notAnswering'>[],
  fleet: readonly Pick<HostServer, 'status'>[] | null,
  assistant: string | null,
  locale?: string | null,
): FigureFace {
  const tr = clientTranslator(locale);
  const label = arrangeWords(locale).ownNames[own];
  const needsLook = (n: number) => tr.tp('overview.figure.needsLook', n);
  switch (own) {
    case 'servers': {
      // Without the servers' list (no hosts service, or not read yet) there is nothing to count.
      if (!fleet?.length) return face({ value: '—', label, line: null });
      const all = fleet;
      const bad = all.filter((s) => s.status === 'bad' || s.status === 'offline').length;
      const warn = all.filter((s) => s.status === 'warn').length;
      const ok = all.length - bad - warn;
      return face({
        value: String(all.length - bad),
        unit: tr.t('overview.figure.total', { count: all.length }),
        label,
        line: bad
          ? tr.t('overview.figure.serverDown', { count: bad })
          : warn
            ? needsLook(warn)
            : tr.t('overview.figure.fine'),
        tone: bad ? 'bad' : warn ? 'warn' : 'ok',
        parts: all.length
          ? [
              { tone: 'ok', n: ok },
              { tone: 'warn', n: warn },
              { tone: 'bad', n: bad },
            ]
          : null,
      });
    }
    case 'connections': {
      const mine = things.filter((t) => isTileThing(t.id));
      const bad = mine.filter((t) => t.level === 'notWorking').length;
      const warn = mine.filter((t) => t.level === 'needsLook').length;
      // Down because of something else: its tile stays grey (the problem is its cause's), but it doesn't work.
      const off = mine.filter(
        (t) => t.notAnswering && t.level !== 'notWorking' && t.level !== 'needsLook',
      ).length;
      const ok = mine.length - bad - warn - off;
      return face({
        value: String(ok),
        unit: tr.t('overview.figure.total', { count: mine.length }),
        label,
        line: bad
          ? tr.t('overview.figure.connectionDown', { count: bad })
          : off
            ? tr.t('overview.figure.noAnswer', { count: off })
            : warn
              ? needsLook(warn)
              : tr.t('overview.figure.fine'),
        tone: bad ? 'bad' : off ? 'off' : warn ? 'warn' : 'ok',
        parts: mine.length
          ? [
              { tone: 'ok', n: ok },
              { tone: 'warn', n: warn },
              { tone: 'bad', n: bad },
              { tone: 'off', n: off },
            ]
          : null,
      });
    }
    case 'needsYou': {
      const n = data.summary.needsYou;
      return face({
        value: String(n),
        label,
        line: n ? tr.tp('overview.figure.waiting', n) : tr.t('overview.figure.noneWaiting'),
        tone: n ? 'warn' : 'ok',
      });
    }
    case 'doneToday': {
      const n = data.doneToday?.length ?? 0;
      const who = assistant?.trim() || tr.t('overview.page.assistant');
      return face({
        value: String(n),
        label,
        line: tr.t(n ? 'overview.figure.finished' : 'overview.figure.noneFinished', { who }),
      });
    }
  }
}

/** The name of a figure at the top as its picker lists it. */
export function topKey(top: OverviewLayoutTop): string {
  return 'own' in top ? `own:${top.own}` : showId(top);
}

/* The summary card and Today -------------------------------------------------------------------------------------- */

export const OVERVIEW_PAGE_WORDS = {
  live: EN['overview.page.live'],
  fine: EN['overview.page.fine'],
  read: (ago: string) => `read ${ago}`,
  justNow: EN['overview.page.justNow'],
  minAgo: (n: number) => `${n} min ago`,
  watching: (assistant: string, servers: number, connections: number) =>
    `${assistant} keeps an eye on ${servers} ${servers === 1 ? 'server' : 'servers'} and ${connections} ${connections === 1 ? 'connection' : 'connections'}.`,
  today: EN['overview.page.today'],
  todayLine: (done: number, planned: number) =>
    planned
      ? `${done} ${done === 1 ? 'thing' : 'things'} so far · ${planned} planned`
      : `${done} ${done === 1 ? 'thing' : 'things'} so far`,
  allActivity: EN['overview.page.allActivity'],
  now: EN['overview.page.now'],
  showAll: (n: number) => `Show all ${n}`,
  showFewer: EN['overview.page.showFewer'],
  failed: EN['overview.page.failed'],
  automation: EN['overview.page.automation'],
} as const;

export function overviewPageWords(locale?: string | null) {
  const tr = clientTranslator(locale);
  if (tr.language === 'en') return OVERVIEW_PAGE_WORDS;
  return {
    live: tr.t('overview.page.live'),
    fine: tr.t('overview.page.fine'),
    read: (ago: string) => tr.t('overview.page.read', { ago }),
    justNow: tr.t('overview.page.justNow'),
    minAgo: (n: number) => tr.t('overview.page.minAgo', { n }),
    watching: (assistant: string, servers: number, connections: number) =>
      tr.t('overview.page.watching', {
        assistant,
        servers: tr.tp('overview.page.serverCount', servers),
        connections: tr.tp('overview.page.connectionCount', connections),
      }),
    today: tr.t('overview.page.today'),
    todayLine: (done: number, planned: number) => {
      const soFar = tr.tp('overview.page.todayLine', done);
      return planned ? tr.t('overview.page.todayPlanned', { soFar, planned }) : soFar;
    },
    allActivity: tr.t('overview.page.allActivity'),
    now: tr.t('overview.page.now'),
    showAll: (n: number) => tr.t('overview.page.showAll', { n }),
    showFewer: tr.t('overview.page.showFewer'),
    failed: tr.t('overview.page.failed'),
    automation: tr.t('overview.page.automation'),
  };
}

/** How long ago Home was read, for “read just now”, “read 3 min ago”. */
export function readAgo(at: string | number | Date, now: number, locale?: string | null): string {
  const words = overviewPageWords(locale);
  const ms = now - new Date(at).getTime();
  const min = Math.floor(ms / 60_000);
  return min < 1 ? words.justNow : words.minAgo(min);
}

export type TodayTone = 'done' | 'bad' | 'plan';

export interface TodayMoment {
  key: string;
  /** Minutes since the local midnight, where the dot sits on the day's line. */
  minute: number;
  /** “21:00”. */
  time: string;
  text: string;
  /** Where it came from: the automation, or the assistant. */
  from: string;
  tone: TodayTone;
  href: string | null;
}

/**
 * The day's moments in time order: what the assistant finished and the automations that ran or failed so far, and
 * the automations still planned today. `now` as minutes since midnight for the line's Now.
 */
export function todayMoments(
  data: Pick<HomeOverview, 'doneToday' | 'automationsToday'>,
  now: number,
  timeZone: string,
  assistant: string | null,
  locale?: string | null,
): { moments: TodayMoment[]; now: number; done: number; planned: number } {
  const minuteOf = (at: string | number) => {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
    const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  };
  const dayOf = (at: string | number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(at),
    );
  const today = dayOf(now);
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const who = assistant?.trim() || clientTranslator(locale).t('overview.page.assistant');
  const words = overviewPageWords(locale);
  const moments: TodayMoment[] = [];
  for (const d of data.doneToday ?? []) {
    if (dayOf(d.at) !== today) continue;
    const minute = minuteOf(d.at);
    moments.push({
      key: `d:${d.id}`,
      minute,
      time: hhmm(minute),
      text: d.text,
      from: who,
      tone: 'done',
      href: d.href ?? null,
    });
  }
  for (const a of data.automationsToday ?? []) {
    if (dayOf(a.at) !== today) continue;
    const minute = minuteOf(a.at);
    moments.push({
      key: `a:${a.id}:${a.at}`,
      minute,
      time: hhmm(minute),
      text: a.name,
      from: a.state === 'failed' ? `${words.automation} · ${words.failed}` : words.automation,
      tone: a.state === 'failed' ? 'bad' : a.state === 'scheduled' ? 'plan' : 'done',
      href: `/automations/${a.id}`,
    });
  }
  moments.sort((x, y) => x.minute - y.minute || x.key.localeCompare(y.key));
  const planned = moments.filter((m) => m.tone === 'plan').length;
  return { moments, now: minuteOf(now), done: moments.length - planned, planned };
}
