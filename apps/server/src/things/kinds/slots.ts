/**
 * A service's Summary in slots (docs/decisions/service-slots.md, how-to in docs/service-pages.md): the builders give
 * each slot its kind, look, place and width, so a kind only says what is in it, and `slotPanels` puts them in their
 * order — Live beside Inventory, the Shelf across, then Trend and People beside the machine card the page adds.
 * `slotProblems` says what is out of place; every kind in slots tests its view with it. Pure.
 */
import type {
  ThingGalleryItem,
  ThingPageBar,
  ThingPageItem,
  ThingPagePanel,
  ThingSeriesColor,
  ThingTone,
} from '@whombat/core';
import type { RawPoint } from '../series';
import { clip, plural, thousands } from '../words';
import type { KindView } from './types';

type Of<K extends ThingPagePanel['kind']> = Extract<ThingPagePanel, { kind: K }>;
export type LivePanel = Of<'gallery'> | Of<'controls'> | Of<'list'>;
export type InventoryPanel = Of<'list'>;
export type ShelfPanel = Of<'gallery'>;
export type TrendPanel = Of<'chart'>;
export type PeoplePanel = Of<'bars'>;

/** What a builder leaves to the slot: the kind, look, place and width. */
type Own<P> = Omit<P, 'kind' | 'look' | 'place' | 'span' | 'width'>;

/** The slot's width of three columns. */
const SPAN = { live: 2, inventory: 1, shelf: 3, trend: 1, people: 1 } as const;
export type SlotName = keyof typeof SPAN;

/** Live: what happens now, a row each with a small picture and a wide progress bar (what plays, what downloads). */
export function liveRows(
  p: Omit<Own<Of<'gallery'>>, 'shape'> & { shape?: Of<'gallery'>['shape'] },
): Of<'gallery'> {
  return { ...p, kind: 'gallery', look: 'rows', shape: p.shape ?? 'poster', place: 'chart', span: SPAN.live };
}

/** Live as things to operate (Home Assistant's favourite lights and switches). */
export function liveControls(p: Own<Of<'controls'>>): Of<'controls'> {
  return { ...p, kind: 'controls', place: 'chart', span: SPAN.live };
}

/** Live as lines (what waits for a yes, with its buttons) when there are no pictures. */
export function liveList(p: Own<Of<'list'>>): Of<'list'> {
  return { ...p, kind: 'list', place: 'chart', span: SPAN.live };
}

/** One line of Inventory: its count large on the right with what changed under it, and its button. */
export function countLine(p: {
  id: string;
  title: string;
  icon?: ThingPageItem['icon'];
  detail?: string;
  tone?: ThingPageItem['tone'];
  /** “1,284”, “—” when unknown. */
  value: string;
  /** “+9 this week”, “No change”. */
  note?: string;
  noteTone?: ThingTone;
  actions?: ThingPageItem['actions'];
  url?: string;
}): ThingPageItem {
  return {
    id: p.id.slice(0, 200),
    title: clip(p.title, 160),
    ...(p.icon ? { icon: p.icon } : {}),
    ...(p.detail ? { detail: clip(p.detail, 300) } : {}),
    ...(p.tone ? { tone: p.tone } : {}),
    // Clients without counts show `right`.
    right: clip(p.value, 40),
    figure: {
      value: clip(p.value, 20),
      ...(p.note ? { note: clip(p.note, 40) } : {}),
      ...(p.noteTone ? { tone: p.noteTone } : {}),
    },
    ...(p.actions?.length ? { actions: p.actions } : {}),
    ...(p.url ? { url: p.url } : {}),
  };
}

/** Inventory: how much of each thing it holds (libraries, requests by state, categories). */
export function inventory(p: Own<Of<'list'>>): Of<'list'> {
  return { ...p, kind: 'list', look: 'counts', place: 'chart', span: SPAN.inventory };
}

/** Shelf: one row of pictures across the width (recently added, just available, finished today). */
export function shelf(
  p: Omit<Own<Of<'gallery'>>, 'shape'> & { shape?: Of<'gallery'>['shape'] },
): Of<'gallery'> {
  return {
    ...p,
    kind: 'gallery',
    look: 'shelf',
    shape: p.shape ?? 'poster',
    place: 'chart',
    span: SPAN.shelf,
  };
}

/** The last `n` days in the burrow's zone, today last: their timestamps, keys (`2026-11-04`) and words. */
export function lastDays(
  now: Date,
  timeZone: string,
  n = 7,
): { at: Date[]; keys: string[]; labels: string[] } {
  const DAY = 86_400_000;
  const at = Array.from({ length: n }, (_, i) => new Date(now.getTime() - (n - 1 - i) * DAY));
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' });
  return {
    at,
    keys: at.map((d) => dayKey(d, timeZone)),
    labels: at.map((d, i) => (i === n - 1 ? 'Today' : weekday.format(d))),
  };
}

/** The day a moment falls on in the burrow's zone (`2026-10-21`). */
export const dayKey = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);

/** How many moments fall on each of `keys`' days. */
export function countByDay(moments: readonly Date[], keys: readonly string[], timeZone: string): number[] {
  const index = new Map(keys.map((k, i) => [k, i]));
  const out = keys.map(() => 0);
  for (const m of moments) {
    const i = index.get(dayKey(m, timeZone));
    if (i !== undefined) out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

/**
 * Whombat's own readings as a value per day, for a service that keeps no history of its own: the points (a reading a
 * day, or the health pass's) that fall on each of `keys`' days, taken as the day's `last`, `sum`, `max` or `mean`; a
 * day without one is null. Fewer than 2 days with a value is no Trend: callers leave it out (`daysWith`).
 */
export function pointsByDay(
  points: readonly RawPoint[],
  keys: readonly string[],
  timeZone: string,
  how: 'last' | 'sum' | 'max' | 'mean',
): (number | null)[] {
  const index = new Map(keys.map((k, i) => [k, i]));
  const byDay: number[][] = keys.map(() => []);
  for (const p of points) {
    if (p.value === null || !Number.isFinite(p.value)) continue;
    const i = index.get(dayKey(p.at, timeZone));
    if (i !== undefined) byDay[i]?.push(p.value);
  }
  return byDay.map((vs) => {
    if (!vs.length) return null;
    if (how === 'last') return vs[vs.length - 1] as number;
    if (how === 'max') return Math.max(...vs);
    const sum = vs.reduce((a, b) => a + b, 0);
    return how === 'sum' ? sum : sum / vs.length;
  });
}

/** How many days have a value: a Trend needs 2. */
export const daysWith = (values: readonly (number | null)[]) => values.filter((v) => v !== null).length;

/** “+18 %”, “−12 %” (a real minus sign), or null when there was nothing to compare with. */
export function weekChange(now: number, before: number): string | null {
  if (before <= 0) return null;
  const p = Math.round(((now - before) / before) * 100);
  return p >= 0 ? `+${p} %` : `−${Math.abs(p)} %`;
}

/**
 * Trend: a bar per day with the day's word under it (“Thu” … “Today”), the total as its figure and the change on the
 * period before beside it. Outside the page's range: it always covers its own days.
 */
export function trend(p: {
  id: string;
  title: string;
  meta?: string;
  days: { at: Date[]; labels: string[] };
  /** A day Whombat has no reading for is null (no bar). */
  values: (number | null)[];
  /** The series' name: “Plays”, “Requests”. */
  label: string;
  /** The figure: “56” with “plays this week”. */
  figure: { value: string; rest?: string; tone?: ThingTone };
  /** “+18 %” and the words after it. */
  change?: string | null;
  changeWords?: string;
  color?: ThingSeriesColor;
  unit?: string;
  ask?: Of<'chart'>['ask'];
}): Of<'chart'> {
  return {
    kind: 'chart',
    id: p.id,
    place: 'chart',
    span: SPAN.trend,
    title: clip(p.title, 60),
    ...(p.meta ? { meta: clip(p.meta, 120) } : {}),
    style: 'bars',
    timestamps: p.days.at.map((d) => d.toISOString()),
    labels: p.days.labels,
    series: [
      {
        key: 'values',
        label: clip(p.label, 40),
        values: p.values,
        color: p.color ?? 'blue',
        ...(p.unit ? { unit: p.unit } : {}),
      },
    ],
    figure: p.figure,
    ...(p.change
      ? { stats: [[{ text: p.change, strong: true }, { text: p.changeWords ?? ' on last week' }]] }
      : {}),
    axis: { min: 0 },
    ...(p.ask ? { ask: p.ask } : {}),
  };
}

/** People: who uses it most, by name with their initial, a bar for each against the busiest. */
export function people(p: {
  id?: string;
  title: string;
  meta?: string;
  /**
   * Busiest first; `n` sizes the bar, `value` is its words (“21 plays”) or `plural(n, unit)`. A person may be marked:
   * `tone` colours their bar (a nearly full quota: amber) and `sub` says why under it (“Quota 300 GB”).
   */
  items: { name: string; note?: string; n: number; value?: string; tone?: ThingTone; sub?: string }[];
  unit?: [string, string?];
  ask?: Of<'bars'>['ask'];
}): Of<'bars'> | null {
  if (!p.items.length) return null;
  const most = Math.max(...p.items.map((i) => i.n), 0);
  return {
    kind: 'bars',
    id: p.id ?? 'people',
    place: 'chart',
    span: SPAN.people,
    title: clip(p.title, 60),
    ...(p.meta ? { meta: clip(p.meta, 120) } : {}),
    items: p.items.slice(0, 8).map(
      (i, k): ThingPageBar => ({
        id: `person-${k}`,
        label: clip(i.name, 80),
        person: true,
        ...(i.note ? { note: clip(i.note, 80) } : {}),
        value: clip(i.value ?? plural(i.n, p.unit?.[0] ?? 'time', p.unit?.[1]), 40),
        pct: most ? i.n / most : 0,
        ...(i.tone ? { tone: i.tone } : {}),
        ...(i.sub ? { sub: clip(i.sub, 120), ...(i.tone ? { subTone: i.tone } : {}) } : {}),
      }),
    ),
    ...(p.ask ? { ask: p.ask } : {}),
  };
}

/** A shelf item's tag of who asked for it (“Anna asked”). */
export function askedBy(name: string | null | undefined): Pick<ThingGalleryItem, 'person'> {
  return name ? { person: { name: clip(name, 60), note: clip(`${name} asked`, 80) } } : {};
}

/** “+9 this week”, “Nothing new” from a count of what came in. */
export function addedNote(
  n: number | null | undefined,
  unit?: [string, string],
): { note: string; noteTone?: 'ok' } | null {
  if (n == null) return null;
  if (n === 0) return { note: 'Nothing new' };
  return {
    note: unit ? `+${thousands(n)} ${n === 1 ? unit[0] : unit[1]}` : `+${thousands(n)} this week`,
    noteTone: 'ok',
  };
}

export interface Slots {
  live?: LivePanel | null;
  inventory?: InventoryPanel | null;
  shelf?: ShelfPanel | null;
  trend?: TrendPanel | null;
  people?: PeoplePanel | null;
  /** Its own panels after the slots (failed downloads, issues, backups): below the rows, in the main column. */
  more?: ThingPagePanel[];
  /** Its own lines in “The machine” after the machine's (its version, its database). */
  machine?: ThingPageBar[];
}

/**
 * A kind's panels and `slots` for its `KindView`, in the slots' order: Live, Inventory, Shelf, Trend, People, then its
 * own panels (placed `main` unless they say otherwise). A slot left out closes up: the server widens the last card of a
 * short row.
 */
export function slotPanels(s: Slots): Pick<KindView, 'panels' | 'slots'> {
  const order = [s.live, s.inventory, s.shelf, s.trend, s.people].filter(
    (p): p is NonNullable<typeof p> => !!p,
  ) as ThingPagePanel[];
  const more = (s.more ?? []).map((p) => (p.place ? p : ({ ...p, place: 'main' } as ThingPagePanel)));
  return { panels: [...order, ...more], slots: { machine: s.machine ?? [] } };
}

/** Which slot a panel fills, or null for a kind's own panel. */
export function slotOf(p: ThingPagePanel): SlotName | null {
  if (p.place !== 'chart') return null;
  if (p.kind === 'gallery') return p.look === 'rows' ? 'live' : p.look === 'shelf' ? 'shelf' : null;
  if (p.kind === 'controls') return 'live';
  if (p.kind === 'list') return p.look === 'counts' ? 'inventory' : p.span === SPAN.live ? 'live' : null;
  if (p.kind === 'chart') return p.labels ? 'trend' : null;
  if (p.kind === 'bars') return p.items.some((i) => i.person) ? 'people' : null;
  return null;
}

const RANK: Record<SlotName, number> = { live: 0, inventory: 1, shelf: 2, trend: 3, people: 4 };

/**
 * What is out of place in a kind's view in slots, in plain words; empty when it follows them. Tests call it on every
 * kind in slots, and the page logs it.
 */
export function slotProblems(view: Pick<KindView, 'panels' | 'slots' | 'kpis' | 'charts'>): string[] {
  const out: string[] = [];
  if (!view.slots) out.push('the view doesn’t say it is in slots');
  if (view.kpis?.length) out.push('a view in slots has no row of figures: its counts go in Inventory');
  // The page draws no chart cards for a view in slots: a chart over the range goes in `more`.
  for (const c of view.charts ?? []) out.push(`${c.id} is a chart card: in slots it goes in more`);
  const ids = new Set<string>();
  let rank = -1;
  let afterOwn = false;
  for (const p of view.panels) {
    if (ids.has(p.id)) out.push(`two panels are called ${p.id}`);
    ids.add(p.id);
    if (p.kind === 'kpis') out.push(`${p.id} is a row of figures`);
    if (p.kind === 'notices') out.push(`${p.id}: Worth a look is the page’s own strip`);
    const slot = slotOf(p);
    if (!slot) {
      if (p.place === 'chart') out.push(`${p.id} sits in the slots' rows but fills no slot`);
      else afterOwn = true;
      continue;
    }
    if (afterOwn) out.push(`${p.id} comes after the kind's own panels`);
    if (RANK[slot] < rank) out.push(`${p.id} (${slot}) is out of order`);
    rank = Math.max(rank, RANK[slot]);
    if (p.span !== SPAN[slot]) out.push(`${p.id} (${slot}) spans ${p.span ?? 1}, not ${SPAN[slot]}`);
    if (p.kind === 'chart' && p.labels?.length !== p.timestamps.length)
      out.push(`${p.id} has ${p.labels?.length ?? 0} labels for ${p.timestamps.length} days`);
    if (p.kind === 'list' && p.look === 'counts')
      for (const i of p.items) if (!i.figure) out.push(`${p.id}: ${i.title} has no count`);
  }
  return out;
}
