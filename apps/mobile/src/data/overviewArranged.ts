/**
 * The Overview arranged by the person, on the phone (docs/decisions/overview-arranged.md): the
 * phone's own parts of it — how the tiles fall into rows (small ones two across, wide and large the full width), the day
 * as moments for Today, a small chart's path, what a figure's label says beside its value, and the choices of a gear's
 * sheet. The arranged order, the edits and what a figure says are the shared `home/arrange.ts`. Pure; the screen is
 * `screens/HomeScreen.tsx` and `screens/home/`.
 */
import { arrangeWords, isTileThing, overviewPageWords, topKey } from '@whombat/client';
import type {
  DeskCatalog,
  DeskCatalogItem,
  HomeOverview,
  OverviewLayoutTop,
  OverviewShow,
  OverviewTileSize,
} from '@whombat/core';
import { dayKey, formatClock } from '@whombat/core/text';
import { mobileTranslator } from '../i18n/translate';

/* Words ------------------------------------------------------------------------------------------------------------ */

/**
 * The phone's few words the shared `ARRANGE_WORDS` and `OVERVIEW_WORDS` don't have yet: the summary card's Live and its
 * all-fine heading, and Today's heading, count and fold.
 */
export function arrangedPhoneWords(locale?: string) {
  const { t } = mobileTranslator(locale);
  const page = overviewPageWords(locale);
  return {
    live: page.live,
    fine: page.fine,
    /** “read 2 s ago”, after the greeting and the date. */
    readAgo: (seconds: number) =>
      seconds < 60
        ? t('data.overviewArranged.readS', { n: Math.max(0, Math.round(seconds)) })
        : seconds < 3600
          ? t('data.overviewArranged.readMin', { n: Math.floor(seconds / 60) })
          : t('data.overviewArranged.readH', { n: Math.floor(seconds / 3600) }),
    today: page.today,
    todayCount: page.todayLine,
    allActivity: page.allActivity,
    showAll: t('data.overviewArranged.showAll'),
    showLess: t('data.overviewArranged.showLess'),
    automation: page.automation,
    planned: t('data.overviewArranged.planned'),
    failed: t('data.overviewArranged.failed'),
  };
}

export const ARRANGED_PHONE_WORDS = arrangedPhoneWords();

/* Tiles in rows ------------------------------------------------------------------------------------------------- */

/** A row of Connections: one or two small tiles side by side, or one wide or large tile across. */
export type TileRow<T> = { kind: 'pair'; items: T[] } | { kind: 'full'; item: T };

/**
 * The tiles as rows on a phone: small ones two across in their order, a wide or large one the full width. A small
 * tile left alone before a wide one keeps its half (the order holds; nothing jumps ahead of it).
 */
export function tileRows<T>(items: readonly T[], sizeOf: (item: T) => OverviewTileSize): TileRow<T>[] {
  const rows: TileRow<T>[] = [];
  let pair: T[] = [];
  const flush = () => {
    if (pair.length) rows.push({ kind: 'pair', items: pair });
    pair = [];
  };
  for (const item of items) {
    if (sizeOf(item) === 's') {
      pair.push(item);
      if (pair.length === 2) flush();
    } else {
      flush();
      rows.push({ kind: 'full', item });
    }
  }
  flush();
  return rows;
}

/** “Power now” beside “1.4 kW” reads “power now”; a label that starts with a short name (“CPU”, “UPS”) keeps it. */
export function figureWhat(label: string): string {
  const [a, b] = label;
  if (!a || !b) return label;
  return a === a.toUpperCase() && b === b.toLowerCase() && b !== b.toUpperCase()
    ? a.toLowerCase() + label.slice(1)
    : label;
}

/* Today --------------------------------------------------------------------------------------------------------- */

export type TodayTone = 'ok' | 'bad' | 'plan';

/** One moment of the day: what the assistant finished, or an automation that ran, failed or is still planned. */
export interface TodayMoment {
  id: string;
  at: number;
  /** “09:30”. */
  time: string;
  text: string;
  /** Where it came from: the assistant's name, or “Automation”. */
  from: string;
  tone: TodayTone;
  href: string | null;
}

/**
 * The day so far and what is planned after now, oldest first, from Home's `doneToday` and `automationsToday`:
 * only today's (in the person's time zone); an automation planned for a moment already past counts as planned still.
 */
export function todayMoments(
  data: Pick<HomeOverview, 'doneToday' | 'automationsToday'>,
  now: Date | number,
  timeZone: string,
  assistant: string,
  locale?: string,
): TodayMoment[] {
  const automation = overviewPageWords(locale).automation;
  const today = dayKey(now, timeZone);
  const out: TodayMoment[] = [];
  for (const d of data.doneToday ?? []) {
    if (dayKey(d.at, timeZone) !== today) continue;
    out.push({
      id: `done:${d.id}`,
      at: Date.parse(d.at),
      time: formatClock(d.at, timeZone),
      text: d.text,
      from: assistant,
      tone: 'ok',
      href: d.href ?? null,
    });
  }
  for (const a of data.automationsToday) {
    if (dayKey(a.at, timeZone) !== today) continue;
    out.push({
      id: `automation:${a.id}:${a.at}`,
      at: Date.parse(a.at),
      time: formatClock(a.at, timeZone),
      text: a.name,
      from: automation,
      tone: a.state === 'failed' ? 'bad' : a.state === 'scheduled' ? 'plan' : 'ok',
      href: null,
    });
  }
  return out.sort((x, y) => x.at - y.at || x.id.localeCompare(y.id));
}

/** “7 things so far · 2 planned”: what happened and what is still to come. */
export function todayCounts(moments: readonly TodayMoment[]): { done: number; planned: number } {
  const planned = moments.filter((m) => m.tone === 'plan').length;
  return { done: moments.length - planned, planned };
}

/**
 * What Today shows folded on the phone: the last `n` moments that happened, topped up with the next planned ones when
 * fewer happened; everything when unfolded.
 */
export function todayShown(moments: readonly TodayMoment[], all: boolean, n = 3): TodayMoment[] {
  if (all || moments.length <= n) return [...moments];
  const past = moments.filter((m) => m.tone !== 'plan');
  const shown = past.slice(-n);
  if (shown.length < n) shown.push(...moments.filter((m) => m.tone === 'plan').slice(0, n - shown.length));
  return shown.sort((x, y) => x.at - y.at || x.id.localeCompare(y.id));
}

/* A small chart ------------------------------------------------------------------------------------------------- */

/**
 * A small chart's line, the wash under it and its newest reading: the points across the width, nought at the
 * bottom (4 in, for the line and its dot) and the highest a little under the top; all equal at nought, a flat line in
 * the middle.
 */
export function sparkPaths(
  points: readonly number[],
  width: number,
  height: number,
): { line: string; area: string; end: { x: number; y: number } } | null {
  const ps = points.filter(Number.isFinite);
  if (ps.length < 2 || !(width > 0) || !(height > 0)) return null;
  // From nought (or the lowest, when below it) to a little over the highest, as the mock draws them.
  const lo = Math.min(0, ...ps);
  const top = Math.max(...ps);
  const hi = top > 0 ? top * 1.15 : top;
  const span = hi - lo;
  const pad = 4;
  const n = (v: number) => String(Number(v.toFixed(1)));
  const xy = ps.map((p, i) => ({
    x: (i / (ps.length - 1)) * width,
    y: span > 0 ? height - pad - ((p - lo) / span) * (height - 2 * pad) : height / 2,
  }));
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`).join('');
  const end = xy[xy.length - 1] as { x: number; y: number };
  return { line, area: `${line}L${n(width)} ${n(height)}L0 ${n(height)}Z`, end };
}

/* A gear's choices ---------------------------------------------------------------------------------------------- */

/** One choice of *What it shows*: its main figures or one panel of its page, and what it says now. */
export interface ShowChoice {
  key: string;
  show: OverviewShow;
  name: string;
  line: string;
  /** It draws a chart: *Time span* is offered. */
  chart: boolean;
}

const showOf = (item: DeskCatalogItem): OverviewShow =>
  item.type === 'panel' && item.opts.panel ? { panel: item.opts.panel } : {};

/** What a thing's tile can show: its main figures first, then each panel of its page, each once. */
export function tileShowChoices(
  catalog: DeskCatalog | undefined,
  thing: string,
  locale?: string,
): ShowChoice[] {
  const mainFigures = arrangeWords(locale).mainFigures;
  const out: ShowChoice[] = [];
  const seen = new Set<string>();
  for (const group of catalog?.groups ?? []) {
    for (const item of group.items) {
      if ((item.ref ?? group.thing) !== thing) continue;
      if (item.type !== 'figures' && item.type !== 'panel') continue;
      const show = showOf(item);
      const key = show.panel ?? '';
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        show,
        name: show.panel ? item.name : mainFigures,
        line: item.line,
        chart: item.view === 'chart',
      });
    }
  }
  return out.sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : 0));
}

/** A choice of a figure at the top: Whombat's own or a thing's; `taken` when another place at the top shows it. */
export interface TopChoice {
  key: string;
  top: OverviewLayoutTop;
  name: string;
  line: string | null;
  taken: boolean;
  chosen: boolean;
}

export interface TopChoiceGroup {
  key: string;
  label: string;
  /** The thing a group is about; null for Whombat's own. */
  thing: string | null;
  items: TopChoice[];
}

/**
 * What a figure at the top can show: Whombat's own four, then every thing's figures and panels grouped by
 * thing; the ones already at the top elsewhere greyed (`taken`), the one it shows now `chosen`.
 */
export function topChoiceGroups(
  catalog: DeskCatalog | undefined,
  top: readonly OverviewLayoutTop[],
  index: number,
  locale?: string,
): TopChoiceGroup[] {
  const words = arrangeWords(locale);
  const here = top[index] ? topKey(top[index] as OverviewLayoutTop) : null;
  const elsewhere = new Set(top.filter((_, i) => i !== index).map(topKey));
  const choice = (t: OverviewLayoutTop, name: string, line: string | null): TopChoice => {
    const key = topKey(t);
    return { key, top: t, name, line, taken: elsewhere.has(key), chosen: key === here };
  };
  const own: TopChoiceGroup = {
    key: 'own',
    label: words.own,
    thing: null,
    items: (Object.keys(words.ownNames) as (keyof typeof words.ownNames)[]).map((o) =>
      choice({ own: o }, words.ownNames[o], null),
    ),
  };
  const groups: TopChoiceGroup[] = [own];
  for (const group of catalog?.groups ?? []) {
    const items: TopChoice[] = [];
    const seen = new Set<string>();
    for (const item of group.items) {
      const thing = item.ref ?? group.thing;
      if (!thing || !isTileThing(thing) || (item.type !== 'figures' && item.type !== 'panel')) continue;
      const t: OverviewLayoutTop = { thing, ...showOf(item) };
      const key = topKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(choice(t, item.type === 'figures' ? words.mainFigures : item.name, item.line));
    }
    if (items.length) groups.push({ key: group.key, label: group.label, thing: group.thing ?? null, items });
  }
  return groups;
}

/* A pinned chart's place ---------------------------------------------------------------------------------------- */

/**
 * Where *Move earlier* (−1) or *Move later* (+1) puts a pinned chart among all the Overview's pins (`widgets.move`'s
 * position: taken out, then put in there), stepping over those removed from the Overview; null at an end.
 */
export function pinMovePosition(
  all: readonly string[],
  shown: readonly string[],
  id: string,
  by: -1 | 1,
): number | null {
  const i = shown.indexOf(id);
  const next = i === -1 ? undefined : shown[i + by];
  if (next === undefined) return null;
  const at = all.indexOf(next);
  return at === -1 ? null : at;
}
