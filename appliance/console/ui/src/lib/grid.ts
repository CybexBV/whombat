/**
 * The screen of widgets as the page reads it (contracts 3.6; Whombat desk-display.md “Screens of widgets”): the desk
 * socket's `DeskGlance.grid` (core's `DeskGrid`) and each monitor's in `DeskGlance.outputs`, checked member by member
 * like the rest of the state: what the page doesn't understand goes (a widget of an unknown type, a view of an unknown
 * kind, a field of the wrong type), a part without what it can't do without goes, and what is left is always drawable.
 * A grid with no page left is none, and the page draws the calm glance instead. A page's times (`show`) and a widget
 * taking over for a moment (`spotlight`, the doorbell) go to the drawing, which turns the pages and draws the moment.
 *
 * The shapes are `@whombat/screen`'s (the drawing's), which mirror core's member for member.
 */
import type {
  DeskAttention,
  DeskAttentionItem,
  DeskGrid,
  DeskImage,
  DeskLayout,
  DeskPage,
  DeskPageShow,
  DeskSpotlight,
  DeskViewBase,
  DeskViewMeter,
  DeskViewPoster,
  DeskViewRow,
  DeskWeatherDay,
  DeskWeatherHour,
  DeskWidget,
  DeskWidgetView,
  Weekday,
} from '@whombat/screen';
import { SCREEN_SIZES, VIEW_KINDS, type ViewKind, WEEKDAYS, WIDGET_TYPES } from '@whombat/screen';

export type {
  DeskAttention,
  DeskAttentionItem,
  DeskGrid,
  DeskImage,
  DeskLayout,
  DeskPage,
  DeskPageShow,
  DeskSpotlight,
  DeskViewBase,
  DeskWidget,
  DeskWidgetView,
};

/** A monitor on the box with its screen (`DeskOutputGrid`): its output, the monitor's name, the grid. */
export interface DeskOutputGrid {
  key: string;
  name: string | null;
  grid: DeskGrid;
}

/* The contract's bounds (core desk-screens.ts, checked against the vendored file by grid.test.ts) ---------------- */

export const DESK_PAGES_MAX = 6;
export const DESK_PAGE_WIDGETS_MAX = 24;
export const DESK_PAGE_SHAPES_MAX = 8;
export const DESK_SCREEN_VIEWS_MAX = 64;
export const DESK_ATTENTION_MAX = 12;
export const DESK_VIEW_ROWS_MAX = 12;
export const DESK_VIEW_POINTS_MAX = 120;
export const DESK_WIDGET_OPTS_MAX = 8;
export const DESK_GRID_MAX = 39;
export const DESK_OUTPUTS_MAX = 4;
export const DESK_SCREEN_ID_RE = /^(box|out_[a-z0-9-]{1,40}|scr_[A-Za-z0-9_-]{8,40})$/;
export const DESK_WIDGET_REF_RE =
  /^(server|connection|device|widget|account):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const DESK_SHAPE_RE = /^([1-9]|[1-3][0-9])x([1-9]|[1-3][0-9])$/;
export const DESK_OUTPUT_KEY_RE = /^[a-z0-9-]{1,40}$/;
/** The forecast's bounds (core weather.ts): hours from now on, and today and the days after it. */
export const WEATHER_HOURS_MAX = 24;
export const WEATHER_DAYS_MAX = 7;
/** MET Norway's `symbol_code` (`partlycloudy_night`, `heavyrain`), as core's `WeatherSymbol`. */
export const WEATHER_SYMBOL_RE = /^[a-z]{2,48}(_(day|night|polartwilight))?$/;
/** Why a widget takes over the screen for a moment (`DESK_SPOTLIGHT_REASONS`): the drawing has words for each. */
export const DESK_SPOTLIGHT_REASONS = ['doorbell'] as const satisfies readonly DeskSpotlight['reason'][];
/** A page's window opens and closes at a wall-clock time, `HH:MM` (notify.ts `ClockTime`). */
export const DESK_CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SPOTLIGHT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_ID_RE = /^p_[A-Za-z0-9_-]{1,32}$/;
const WIDGET_ID_RE = /^w_[A-Za-z0-9_-]{1,32}$/;
const OPT_KEY_RE = /^[a-z][a-zA-Z0-9]{0,23}$/;
const IMAGE_REF_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MARK_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TIME_RE =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;

/* Small readers ---------------------------------------------------------------------------------------------------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined =>
  values.includes(v as T) ? (v as T) : undefined;
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const int = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pct = (v: unknown) => int(v, 0, 100);
const matching = (v: unknown, re: RegExp): string | undefined =>
  typeof v === 'string' && re.test(v) ? v : undefined;
const time = (v: unknown) =>
  typeof v === 'string' && TIME_RE.test(v) && Number.isFinite(Date.parse(v)) ? v : undefined;
/** A display string on one line, cut to `max` code points; undefined when it isn't one or is empty. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const one = v.replace(/\s+/g, ' ').trim();
  if (!one) return undefined;
  const points = Array.from(one);
  return points.length <= max ? one : points.slice(0, max).join('');
}
/** Drops the members that are undefined, so the drawing's `in` and spreads see only what was sent. */
function defined<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
const TONES = ['ok', 'warn', 'bad', 'off'] as const;
const tone = (v: unknown) => oneOf(v, TONES);
const SHAPES = ['poster', 'wide', 'square'] as const;
const points = (v: unknown, nullable: boolean): (number | null)[] =>
  list(v, DESK_VIEW_POINTS_MAX).flatMap((p) => {
    const n = num(p);
    return n !== undefined ? [n] : nullable && p === null ? [null] : [];
  });
/** A whole degree, Celsius or Fahrenheit as the view says. */
const degrees = (v: unknown) => int(v, -150, 150);
/** Rain in millimetres. */
const rainMm = (v: unknown) => {
  const n = num(v);
  return n !== undefined && n >= 0 && n <= 1000 ? n : undefined;
};
const symbol = (v: unknown) => matching(v, WEATHER_SYMBOL_RE);

export function parseImage(v: unknown): DeskImage | undefined {
  if (!isObj(v)) return undefined;
  const thing = matching(v.thing, DESK_WIDGET_REF_RE);
  const ref =
    typeof v.ref === 'string' && v.ref.length >= 16 && v.ref.length <= 600
      ? matching(v.ref, IMAGE_REF_RE)
      : undefined;
  const shape = oneOf(v.shape, SHAPES);
  if (!thing || !ref || !shape) return undefined;
  return defined({ thing, ref, shape, alt: text(v.alt, 120) });
}

/* The layout ------------------------------------------------------------------------------------------------------ */

const overlaps = (a: DeskWidget, b: DeskWidget) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function parseOpts(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v).slice(0, DESK_WIDGET_OPTS_MAX)) {
    const s = text(x, 120);
    if (OPT_KEY_RE.test(k) && s) out[k] = s;
  }
  return out;
}

/** What a widget is and shows (`DeskWidgetSpec`): an id, a type the page can draw, a sound ref; null otherwise. */
function parseSpec(w: unknown): Pick<DeskWidget, 'id' | 'type' | 'ref' | 'opts'> | null {
  if (!isObj(w)) return null;
  const id = matching(w.id, WIDGET_ID_RE);
  const type = oneOf(w.type, WIDGET_TYPES);
  const ref = w.ref === undefined ? undefined : matching(w.ref, DESK_WIDGET_REF_RE);
  if (!id || !type || (w.ref !== undefined && !ref)) return null;
  return defined({ id, type, ref, opts: parseOpts(w.opts) });
}

/** A shape's widgets: the ones the page can draw, inside the shape, each id once, none on another. */
function parseWidgets(v: unknown, cols: number, rows: number): DeskWidget[] {
  const out: DeskWidget[] = [];
  for (const w of list(v, DESK_PAGE_WIDGETS_MAX)) {
    if (!isObj(w)) continue;
    const spec = parseSpec(w);
    if (!spec) continue;
    const x = int(w.x, 0, DESK_GRID_MAX - 1);
    const y = int(w.y, 0, DESK_GRID_MAX - 1);
    const width = int(w.w, 1, DESK_GRID_MAX);
    const height = int(w.h, 1, DESK_GRID_MAX);
    if (x === undefined || y === undefined || width === undefined || height === undefined) continue;
    if (x + width > cols || y + height > rows) continue;
    const widget: DeskWidget = { ...spec, x, y, w: width, h: height };
    if (out.some((o) => o.id === widget.id || overlaps(o, widget))) continue;
    out.push(widget);
  }
  return out;
}

/**
 * When a page is in the turning: both times `HH:MM`, and the days it names that are days (each once). A window that
 * isn't one (a time it can't read, no day it knows) goes, and the page is always in: shown too often beats never.
 */
function parseShow(v: unknown): DeskPageShow | undefined {
  if (!isObj(v)) return undefined;
  const from = matching(v.from, DESK_CLOCK_RE);
  const to = matching(v.to, DESK_CLOCK_RE);
  if (!from || !to) return undefined;
  if (v.days === undefined) return { from, to };
  const days: Weekday[] = [];
  for (const d of list(v.days, WEEKDAYS.length)) {
    const day = oneOf(d, WEEKDAYS);
    if (day && !days.includes(day)) days.push(day);
  }
  return days.length > 0 ? { from, to, days } : undefined;
}

function parsePage(v: unknown): DeskPage | null {
  if (!isObj(v) || !isObj(v.layouts)) return null;
  const id = matching(v.id, PAGE_ID_RE);
  const name = text(v.name, 24);
  if (!id || !name) return null;
  const layouts: Record<string, DeskWidget[]> = {};
  for (const [shape, widgets] of Object.entries(v.layouts).slice(0, DESK_PAGE_SHAPES_MAX)) {
    const m = DESK_SHAPE_RE.exec(shape);
    if (m) layouts[shape] = parseWidgets(widgets, Number(m[1]), Number(m[2]));
  }
  const shapes = Object.keys(layouts);
  if (shapes.length === 0) return null;
  const last = typeof v.last === 'string' && v.last in layouts ? v.last : (shapes[0] as string);
  return defined({ id, name, layouts, last, show: parseShow(v.show) });
}

export function parseLayout(v: unknown): DeskLayout | null {
  if (!isObj(v)) return null;
  const pages: DeskPage[] = [];
  for (const p of list(v.pages, DESK_PAGES_MAX)) {
    const page = parsePage(p);
    if (page && !pages.some((o) => o.id === page.id)) pages.push(page);
  }
  if (pages.length === 0) return null;
  return {
    pages,
    turn: oneOf(v.turn, ['touch', '30s', '60s'] as const) ?? 'touch',
    size: oneOf(v.size, SCREEN_SIZES) ?? 'normal',
  };
}

/* The views ------------------------------------------------------------------------------------------------------- */

/** One of a row's limits (Fusebox's subscriptions): its short name, how many blocks are lit, its words, its reset. */
function parseMeter(v: unknown): DeskViewMeter | null {
  if (!isObj(v)) return null;
  const at = pct(v.pct);
  const said = text(v.text, 24);
  if (at === undefined || !said) return null;
  return defined({ key: text(v.key, 8), pct: at, text: said, reset: text(v.reset, 24), tone: tone(v.tone) });
}

function parseRow(v: unknown): DeskViewRow | null {
  if (!isObj(v)) return null;
  const title = text(v.title, 120);
  if (!title) return null;
  const meters = some(v.meters, 3, parseMeter);
  return defined({
    title,
    detail: text(v.detail, 120),
    meta: text(v.meta, 40),
    note: text(v.note, 40),
    time: text(v.time, 16),
    tone: tone(v.tone),
    progress: pct(v.progress),
    meters: meters.length > 0 ? meters : undefined,
    mark: matching(v.mark, MARK_RE),
    state: oneOf(v.state, ['on', 'off'] as const),
    image: parseImage(v.image),
  });
}

function parsePoster(v: unknown): DeskViewPoster | null {
  if (!isObj(v)) return null;
  const title = text(v.title, 120);
  if (!title) return null;
  return defined({
    title,
    detail: text(v.detail, 120),
    who: text(v.who, 80),
    progress: pct(v.progress),
    time: text(v.time, 40),
    image: parseImage(v.image),
  });
}

const some = <T>(v: unknown, max: number, parse: (x: unknown) => T | null): T[] =>
  list(v, max).flatMap((x) => {
    const p = parse(x);
    return p === null ? [] : [p];
  });
const words = (v: unknown, max: number, each: number): string[] | undefined => {
  const out = some(v, max, (x) => text(x, each) ?? null);
  return out.length > 0 ? out : undefined;
};

function parseWeatherHour(v: unknown): DeskWeatherHour | null {
  if (!isObj(v)) return null;
  const at = time(v.at);
  const temp = degrees(v.temp);
  const sign = symbol(v.symbol);
  return at && temp !== undefined && sign
    ? defined({ at, temp, symbol: sign, rainMm: rainMm(v.rainMm) })
    : null;
}

function parseWeatherDay(v: unknown): DeskWeatherDay | null {
  if (!isObj(v)) return null;
  const date = matching(v.date, DATE_RE);
  const high = degrees(v.high);
  const low = degrees(v.low);
  const sign = symbol(v.symbol);
  if (!date || high === undefined || low === undefined || !sign) return null;
  return defined({ date, high, low, symbol: sign, rainMm: rainMm(v.rainMm) });
}

/** A view the page can draw, its members checked; null for an unknown kind or one without what it needs. */
export function parseView(v: unknown): DeskWidgetView | null {
  if (!isObj(v)) return null;
  const kind = oneOf(v.kind, VIEW_KINDS) as ViewKind | undefined;
  const id = matching(v.id, WIDGET_ID_RE);
  const title = text(v.title, 60);
  if (!kind || !id || !title) return null;
  const problemText = isObj(v.problem) ? text(v.problem.text, 120) : undefined;
  const base: DeskViewBase = defined({
    id,
    title,
    name: text(v.name, 40),
    mark: matching(v.mark, MARK_RE),
    tone: tone(v.tone),
    problem:
      problemText && isObj(v.problem)
        ? defined({ text: problemText, detail: text(v.problem.detail, 200) })
        : undefined,
    locked: v.locked === true ? true : undefined,
    at: time(v.at),
  });
  switch (kind) {
    case 'figures': {
      const items = some(v.items, 4, (x) => {
        if (!isObj(x)) return null;
        const value = text(x.value, 24);
        const label = text(x.label, 40);
        return value && label ? defined({ value, unit: text(x.unit, 12), label, tone: tone(x.tone) }) : null;
      });
      // Locked or with a problem, a widget says so instead of its figures.
      if (items.length === 0 && !base.locked && !base.problem) return null;
      const spark = points(v.spark, false) as number[];
      return defined({
        ...base,
        kind,
        items,
        line: text(v.line, 120),
        spark: spark.length > 0 ? spark : undefined,
        progress: pct(v.progress),
      });
    }
    case 'list':
      return defined({
        ...base,
        kind,
        head: text(v.head, 80),
        progress: pct(v.progress),
        rows: some(v.rows, DESK_VIEW_ROWS_MAX, parseRow),
        count: int(v.count, 0, 1_000_000),
        empty: text(v.empty, 120),
      });
    case 'posters':
      return defined({
        ...base,
        kind,
        head: text(v.head, 80),
        items: some(v.items, DESK_VIEW_ROWS_MAX, parsePoster),
        shape: oneOf(v.shape, SHAPES) ?? 'poster',
        empty: text(v.empty, 120),
      });
    case 'chart': {
      const series = some(v.series, 3, (x) =>
        isObj(x)
          ? defined({ label: text(x.label, 40), points: points(x.points, true), tone: tone(x.tone) })
          : null,
      );
      if (series.length === 0 && !base.locked && !base.problem) return null;
      const figureValue = isObj(v.figure) ? text(v.figure.value, 40) : undefined;
      const foot = some(v.foot, 4, (x) => {
        if (!isObj(x)) return null;
        const label = text(x.label, 30);
        const value = text(x.value, 40);
        return label && value ? { label, value } : null;
      });
      return defined({
        ...base,
        kind,
        figure:
          figureValue && isObj(v.figure)
            ? defined({ value: figureValue, rest: text(v.figure.rest, 60), tone: tone(v.figure.tone) })
            : undefined,
        stats: words(v.stats, 2, 80),
        series,
        unit: text(v.unit, 12),
        limit: num(v.limit),
        foot: foot.length > 0 ? foot : undefined,
      });
    }
    case 'camera':
      return defined({ ...base, kind, image: parseImage(v.image), event: text(v.event, 80) });
    case 'server': {
      const server = matching(v.server, SERVER_ID_RE);
      const state = tone(v.state);
      if (!server || !state) return null;
      const spark = points(v.spark, false).filter(
        (p): p is number => p !== null && Number.isInteger(p) && p >= 0 && p <= 100,
      );
      return defined({
        ...base,
        kind,
        line: text(v.line, 80),
        state,
        say: text(v.say, 40),
        cpu: pct(v.cpu),
        memory: pct(v.memory),
        disk: pct(v.disk),
        spark: spark.length > 0 ? spark : undefined,
        range: oneOf(v.range, ['1h', '24h', '7d'] as const),
        stats: words(v.stats, 2, 80),
        uptime: text(v.uptime, 40),
        server,
      });
    }
    case 'text': {
      const body = text(v.body, 600);
      return body ? { ...base, kind, body } : null;
    }
    case 'photo': {
      // One picture at a time (contracts 3.7, Whombat DK-160): a picture without its image is left out.
      const items = some(v.items, 12, (x) => {
        if (!isObj(x)) return null;
        const image = parseImage(x.image);
        return image ? defined({ image, caption: text(x.caption, 80), time: text(x.time, 40) }) : null;
      });
      const every = int(v.every, 30, 3600);
      return defined({ ...base, kind, items, every, empty: text(v.empty, 120) });
    }
    case 'board': {
      // Named tiles, each in its colour (contracts 3.7, Whombat DK-162): a tile without a name or tone is left out.
      const items = some(v.items, 48, (x) => {
        if (!isObj(x)) return null;
        const label = text(x.label, 40);
        const t = tone(x.tone);
        return label && t ? defined({ label, tone: t, value: text(x.value, 16) }) : null;
      });
      return defined({
        ...base,
        kind,
        head: text(v.head, 80),
        items,
        count: int(v.count, 0, 1_000_000),
        empty: text(v.empty, 120),
      });
    }
    case 'weather': {
      // Without its unit the numbers mean nothing, and MET Norway's forecast is shown with its credit.
      const unit = oneOf(v.unit, ['C', 'F'] as const);
      const credit = text(v.credit, 60);
      if (!unit || !credit) return null;
      const n = isObj(v.now) ? v.now : {};
      const nowTemp = degrees(n.temp);
      const nowSign = symbol(n.symbol);
      const nowText = text(n.text, 60);
      const t = isObj(v.today) ? v.today : {};
      const high = degrees(t.high);
      const low = degrees(t.low);
      const sun = isObj(v.sun)
        ? defined({
            rise: time(v.sun.rise),
            set: time(v.sun.set),
            polar: oneOf(v.sun.polar, ['day', 'night'] as const),
          })
        : undefined;
      return defined({
        ...base,
        kind,
        place: text(v.place, 80),
        unit,
        now:
          nowTemp !== undefined && nowSign && nowText
            ? defined({
                temp: nowTemp,
                symbol: nowSign,
                text: nowText,
                wind: text(n.wind, 24),
                feels: degrees(n.feels),
              })
            : undefined,
        today:
          high !== undefined && low !== undefined
            ? defined({ high, low, rainMm: rainMm(t.rainMm), rainChance: pct(t.rainChance) })
            : undefined,
        hours: some(v.hours, WEATHER_HOURS_MAX, parseWeatherHour),
        days: some(v.days, WEATHER_DAYS_MAX, parseWeatherDay),
        sun: sun && Object.keys(sun).length > 0 ? sun : undefined,
        credit,
      });
    }
  }
}

/* What needs the person ------------------------------------------------------------------------------------------- */

function parseAttentionItem(v: unknown): DeskAttentionItem | null {
  if (!isObj(v)) return null;
  const key = text(v.key, 120);
  const kind = oneOf(v.kind, ['ask', 'look'] as const);
  const t = oneOf(v.tone, ['bad', 'warn'] as const);
  const title = text(v.title, 120);
  if (!key || !kind || !t || typeof v.pops !== 'boolean' || !title) return null;
  const ask = int(v.ask, 1, 1_000_000_000);
  const look = text(v.look, 120);
  // An ask names its number and a look its key: the modal's buttons need them.
  if ((kind === 'ask' && ask === undefined) || (kind === 'look' && !look)) return null;
  const research = oneOf(v.research, ['looking', 'found', 'fixing', 'fixed', 'failed'] as const);
  return defined({
    key,
    kind,
    tone: t,
    pops: v.pops,
    title,
    detail: text(v.detail, 200),
    since: time(v.since),
    name: text(v.name, 40),
    ask: kind === 'ask' ? ask : undefined,
    look: kind === 'look' ? look : undefined,
    server: matching(v.server, SERVER_ID_RE),
    research,
    // The step only while the assistant found it.
    fix: research === 'found' ? text(v.fix, 32) : undefined,
  });
}

export function parseAttention(v: unknown): DeskAttention {
  if (!isObj(v)) return { items: [], more: 0 };
  const items: DeskAttentionItem[] = [];
  for (const x of list(v.items, DESK_ATTENTION_MAX)) {
    const item = parseAttentionItem(x);
    if (item && !items.some((o) => o.key === item.key)) items.push(item);
  }
  return defined({
    items,
    more: int(v.more, 0, 1_000_000) ?? 0,
    tone: items.length > 0 ? oneOf(v.tone, ['bad', 'warn'] as const) : undefined,
  });
}

/* The grid -------------------------------------------------------------------------------------------------------- */

/**
 * A widget taking over the screen for a moment (the doorbell): its id, a widget the page can draw (no place: it's
 * drawn big), until when, and a reason the drawing has words for; none when any of it isn't right.
 */
export function parseSpotlight(v: unknown): DeskSpotlight | undefined {
  if (!isObj(v)) return undefined;
  const id = matching(v.id, SPOTLIGHT_ID_RE);
  const widget = parseSpec(v.widget);
  const until = time(v.until);
  const reason = oneOf(v.reason, DESK_SPOTLIGHT_REASONS);
  return id && widget && until && reason ? { id, widget, until, reason } : undefined;
}

/** A screen's grid, checked; null when it has no page the page can draw (then the calm glance shows). */
export function parseGrid(v: unknown): DeskGrid | null {
  if (!isObj(v)) return null;
  const screen = matching(v.screen, DESK_SCREEN_ID_RE);
  const layout = parseLayout(v.layout);
  if (!screen || !layout) return null;
  const views: DeskWidgetView[] = [];
  for (const x of list(v.views, DESK_SCREEN_VIEWS_MAX)) {
    const view = parseView(x);
    if (view && !views.some((o) => o.id === view.id)) views.push(view);
  }
  const until = isObj(v.trying) ? time(v.trying.until) : undefined;
  return defined({
    screen,
    layout,
    views,
    attention: parseAttention(v.attention),
    popups: oneOf(v.popups, ['all', 'problems', 'none'] as const) ?? 'all',
    trying: until ? { until } : undefined,
    spotlight: parseSpotlight(v.spotlight),
  });
}

/** The monitors' screens: each with a key and a grid the page can draw, each key once. */
export function parseOutputGrids(v: unknown): DeskOutputGrid[] {
  const out: DeskOutputGrid[] = [];
  for (const x of list(v, DESK_OUTPUTS_MAX)) {
    if (!isObj(x)) continue;
    const key = matching(x.key, DESK_OUTPUT_KEY_RE);
    const grid = parseGrid(x.grid);
    if (key && grid && !out.some((o) => o.key === key))
      out.push({ key, name: text(x.name, 60) ?? null, grid });
  }
  return out;
}

/* Locked by the page ----------------------------------------------------------------------------------------------- */

/** Whombat's own widgets whose views are never private: the weather where the box is, public headlines. */
const PUBLIC_OWN_WIDGETS: ReadonlySet<string> = new Set(['weather', 'news']);

/** The ids of a layout's widgets that show as they are on a locked screen (by id, the first seen, as the runtime). */
function publicWidgetIds(layout: DeskLayout): Set<string> {
  const types = new Map<string, string>();
  for (const page of layout.pages)
    for (const widgets of Object.values(page.layouts))
      for (const w of widgets) if (!types.has(w.id)) types.set(w.id, w.type);
  return new Set([...types].filter(([, type]) => PUBLIC_OWN_WIDGETS.has(type)).map(([id]) => id));
}

/**
 * A grid as a locked screen may show it, for a desk the page can't vouch for (Whombat away, an unlock that ran out):
 * what the runtime would have sent for the lock view, as far as the page can tell. *Only the time* has no grid. Every
 * view shows everything; *A summary* shows the servers and Whombat's own widgets (the weather and the news as they
 * are: nothing in them is private), and every other widget says “Unlock to see it” (the page can't tell which are
 * private). No ask's words in either: `askTitle` (“Dusty has a question”).
 */
export function lockedGrid(
  g: DeskGrid,
  view: 'time' | 'summary' | 'everything',
  askTitle: string,
): DeskGrid | null {
  if (view === 'time') return null;
  const attention = {
    ...g.attention,
    items: g.attention.items.map((i) =>
      i.kind === 'ask' ? defined({ ...i, title: askTitle, detail: undefined }) : i,
    ),
  };
  if (view === 'everything') return { ...g, attention };
  const open = publicWidgetIds(g.layout);
  const views = g.views.map((v): DeskWidgetView => {
    if (open.has(v.id)) return v;
    const base: DeskViewBase = defined({
      id: v.id,
      title: v.title,
      name: v.name,
      mark: v.mark,
      locked: true,
    });
    switch (v.kind) {
      case 'server':
      case 'weather':
        return v;
      case 'figures':
        return { ...base, kind: v.kind, items: [] };
      case 'list':
        return { ...base, kind: v.kind, rows: [] };
      case 'posters':
        return { ...base, kind: v.kind, items: [], shape: v.shape };
      case 'chart':
        return { ...base, kind: v.kind, series: [] };
      case 'camera':
        return { ...base, kind: v.kind };
      default:
        return { ...base, kind: 'text', body: v.title };
    }
  });
  return { ...g, views, attention };
}
