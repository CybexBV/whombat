/**
 * Arranging the Overview (Whombat docs/decisions/overview-arranged.md): the tiles in their arranged order with what each
 * shows and its size, the four figures at the top, the pinned charts' widths, the edits Arrange makes to them, the
 * desk-screen widgets `overview.views` reads for them, and the words. Pure; the web and the phone arrange the same.
 */
import {
  type DeskWidgetSpec,
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
  overviewWidgetSpec,
} from '@whombat/core';
import type { HostServer } from '@whombat/core/domain';
import type { HomeThingRow } from './sections';

/* Words ----------------------------------------------------------------------------------------------------------- */

export const ARRANGE_WORDS = {
  arrange: 'Arrange',
  done: 'Done',
  arrangeLabel: 'Arrange the Overview',
  doneLabel: 'Done arranging',
  barTitle: 'Arranging the Overview.',
  barBody: 'Drag a tile to move it, or press its gear to change what it shows and its size.',
  barBodyPhone: 'Press a tile’s gear to change what it shows, its size and its place.',
  same: 'Your phone and your computer show the same Overview.',
  add: 'Add to Overview',
  addLine: (removed: number) => (removed ? `${removed} removed` : 'What you remove waits here'),
  addEmpty: 'Everything is on the Overview.',
  addTiles: 'Connections',
  addPins: 'Pinned',
  changeTile: (name: string) => `Change the ${name} tile`,
  changeFigure: 'Change this figure',
  changePin: (title: string) => `Change ${title}`,
  figureTitle: 'Figure at the top',
  figureSub: (n: number) => `Figure ${n} of 4`,
  pinSub: 'Pinned from a chat',
  shows: 'What it shows',
  span: 'Time span',
  size: 'Size',
  width: 'Width',
  place: 'Place',
  earlier: 'Move earlier',
  later: 'Move later',
  remove: 'Remove from Overview',
  close: 'Close',
  own: 'Whombat',
  shownAlready: 'At the top already',
  reading: 'Reading what it can show…',
  couldntRead: 'Couldn’t read what it can show. Try again in a moment.',
  couldntSave: 'Couldn’t save the Overview. Try again.',
  mainFigures: 'Its main figures',
  sizes: { s: 'Small', w: 'Wide', l: 'Large' } satisfies Record<OverviewTileSize, string>,
  pinSizes: { half: 'Half', full: 'Full width' },
  ranges: { '1h': '1 hour', '24h': '24 hours', '7d': '7 days' } satisfies Record<OverviewRange, string>,
  ownNames: {
    servers: 'Servers running',
    connections: 'Connections working',
    needsYou: 'Needs you',
    doneToday: 'Done today',
  } satisfies Record<OverviewOwnFigure, string>,
} as const;

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

/** FNV-1a, base 36: a short stable name for what a tile shows, so its view is kept while tiles move. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The widget id of what a tile or figure shows: the same thing, panel and span read once for both. */
export function showId(show: OverviewShow & { thing: string }): string {
  return `w_${shortHash(`${show.thing}|${show.panel ?? ''}|${show.range ?? ''}`)}`;
}

/** The widgets to read for the tiles shown and the thing figures at the top, each once. */
export function overviewSpecs(
  tiles: readonly OverviewLayoutTile[],
  top: readonly OverviewLayoutTop[],
): DeskWidgetSpec[] {
  const out = new Map<string, DeskWidgetSpec>();
  const add = (show: OverviewShow & { thing: string }) => {
    const id = showId(show);
    if (!out.has(id) && isTileThing(show.thing)) out.set(id, overviewWidgetSpec(id, show as never));
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
  if (view.problem) return face({ value: '—', label: view.title, line: view.problem.text, tone: 'warn' });
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
  things: readonly Pick<HomeThingRow, 'id' | 'level'>[],
  fleet: readonly Pick<HostServer, 'status'>[] | null,
  assistant: string | null,
): FigureFace {
  const label = ARRANGE_WORDS.ownNames[own];
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
        unit: `of ${all.length}`,
        label,
        line: bad ? `${bad} not running` : warn ? `${warn} need${warn === 1 ? 's' : ''} a look` : 'All fine',
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
      const ok = mine.length - bad - warn;
      return face({
        value: String(ok),
        unit: `of ${mine.length}`,
        label,
        line: bad ? `${bad} not working` : warn ? `${warn} need${warn === 1 ? 's' : ''} a look` : 'All fine',
        tone: bad ? 'bad' : warn ? 'warn' : 'ok',
        parts: mine.length
          ? [
              { tone: 'ok', n: ok },
              { tone: 'warn', n: warn },
              { tone: 'bad', n: bad },
            ]
          : null,
      });
    }
    case 'needsYou': {
      const n = data.summary.needsYou;
      return face({
        value: String(n),
        label,
        line: n
          ? n === 1
            ? 'One thing waits for you'
            : `${n} things wait for you`
          : 'Nothing waits for you',
        tone: n ? 'warn' : 'ok',
      });
    }
    case 'doneToday': {
      const n = data.doneToday?.length ?? 0;
      const who = assistant?.trim() || 'Your assistant';
      return face({
        value: String(n),
        label,
        line: n ? `Finished by ${who}` : `${who} hasn’t finished anything yet`,
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
  live: 'Live',
  fine: 'Everything’s fine',
  read: (ago: string) => `read ${ago}`,
  justNow: 'just now',
  minAgo: (n: number) => `${n} min ago`,
  watching: (assistant: string, servers: number, connections: number) =>
    `${assistant} keeps an eye on ${servers} ${servers === 1 ? 'server' : 'servers'} and ${connections} ${connections === 1 ? 'connection' : 'connections'}.`,
  today: 'Today',
  todayLine: (done: number, planned: number) =>
    planned
      ? `${done} ${done === 1 ? 'thing' : 'things'} so far · ${planned} planned`
      : `${done} ${done === 1 ? 'thing' : 'things'} so far`,
  allActivity: 'All activity',
  now: 'Now',
  showAll: (n: number) => `Show all ${n}`,
  showFewer: 'Show fewer',
  failed: 'failed',
  automation: 'Automation',
} as const;

/** How long ago Home was read, for “read just now”, “read 3 min ago”. */
export function readAgo(at: string | number | Date, now: number): string {
  const ms = now - new Date(at).getTime();
  const min = Math.floor(ms / 60_000);
  return min < 1 ? OVERVIEW_PAGE_WORDS.justNow : OVERVIEW_PAGE_WORDS.minAgo(min);
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
  const who = assistant?.trim() || 'Your assistant';
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
      from:
        a.state === 'failed'
          ? `${OVERVIEW_PAGE_WORDS.automation} · ${OVERVIEW_PAGE_WORDS.failed}`
          : OVERVIEW_PAGE_WORDS.automation,
      tone: a.state === 'failed' ? 'bad' : a.state === 'scheduled' ? 'plan' : 'done',
      href: `/automations/${a.id}`,
    });
  }
  moments.sort((x, y) => x.minute - y.minute || x.key.localeCompare(y.key));
  const planned = moments.filter((m) => m.tone === 'plan').length;
  return { moments, now: minuteOf(now), done: moments.length - planned, planned };
}
