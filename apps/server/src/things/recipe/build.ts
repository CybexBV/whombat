/**
 * A page from a recipe and its reads' answers (docs/decisions/connection-looks.md), in the slots every service page uses:
 * Live, Inventory, Trend, a list below them, the head's facts and Worth a look's lines. It also says what each part shows
 * in words and what is wrong, for the assistant trying a recipe before it is saved. Pure.
 */
import type {
  ConnectionPage,
  PageCount,
  PageItems,
  PageValue,
  PageWarning,
  ThingLine,
  ThingPageItem,
} from '@whombat/core';
import {
  countLine,
  daysWith,
  inventory,
  lastDays,
  liveList,
  pointsByDay,
  slotPanels,
  trend,
} from '../kinds/slots';
import type { KindView } from '../kinds/types';
import type { KindCheck, KindNotice } from '../quiet/types';
import type { RawPoint } from '../series';
import { clip, line } from '../words';
import { holds, MISSING, scaledNumber, toneOf, valueAt, words } from './values';

/** A read's outcome: its JSON answer, or why there is none in words. */
export type ReadAnswer = { ok: true; value: unknown } | { ok: false; problem: string };

/** What a warning that matters is watched as, and the rest. */
export const PAGE_CHECKS: readonly KindCheck[] = [
  {
    check: 'page.broken',
    name: 'What the service reports as down or broken',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'page.heads_up',
    name: 'The service’s other warnings',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
];

/** The point a count or the trend keeps for itself: `pg:<id>`. */
export const pointKey = (id: string) => `pg:${id}`;
export const TREND_KEY = pointKey('trend');

/** The numbers a recipe keeps as points from this read: its counts that say what changed, and its trend. */
export function recipePoints(
  page: ConnectionPage,
  answers: ReadonlyMap<string, ReadAnswer>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const at = (v: PageValue) => {
    const a = answers.get(v.read);
    return a?.ok ? scaledNumber(valueAt(a.value, v.at), v) : null;
  };
  for (const c of page.counts?.lines ?? []) if (c.change) out[pointKey(c.id)] = at(c.value);
  if (page.trend) out[TREND_KEY] = at(page.trend.value);
  return out;
}

/** The point keys a recipe keeps. */
export function recipePointKeys(page: ConnectionPage): string[] {
  return [
    ...(page.counts?.lines ?? []).filter((c) => c.change).map((c) => pointKey(c.id)),
    ...(page.trend ? [TREND_KEY] : []),
  ];
}

export interface Built {
  view: Pick<KindView, 'panels' | 'slots' | 'kpis' | 'notices' | 'facts'>;
  /** A line per part in words: “Live · Downloading now: 3 items — Ubuntu 24.04 (45 %), …”. */
  shows: string[];
  /** What is wrong, in words. */
  problems: string[];
}

interface Ctx {
  now: Date;
  timeZone: string;
  /** The connection's name, for words. */
  name: string;
  /** Its kept points by key, oldest first (`recipePointKeys`). */
  points: ReadonlyMap<string, readonly RawPoint[]>;
}

const WEEK = 7 * 86_400_000;

/** The page a recipe builds from its answers. */
export function buildRecipe(page: ConnectionPage, answers: ReadonlyMap<string, ReadAnswer>, ctx: Ctx): Built {
  const shows: string[] = [];
  const problems: string[] = [];
  const reported = new Set<string>();
  /** A read's answer, or null with its problem said once. */
  const answer = (read: string): unknown | typeof MISSING => {
    const a = answers.get(read);
    if (!a) return MISSING;
    if (a.ok) return a.value;
    if (!reported.has(read)) {
      reported.add(read);
      problems.push(`Read “${read}”: ${a.problem}`);
    }
    return MISSING;
  };
  const value = (v: PageValue, where: string): { raw: unknown; text: string | null } | null => {
    const json = answer(v.read);
    if (json === MISSING) return null;
    const raw = valueAt(json, v.at);
    if (raw === MISSING) {
      problems.push(`${where}: nothing at “${v.at}” in “${v.read}”.`);
      return null;
    }
    return { raw, text: words(raw, v, ctx.now, ctx.timeZone) };
  };

  const items = (p: PageItems, where: string): ThingPageItem[] | null => {
    const json = answer(p.read);
    if (json === MISSING) return null;
    const list = valueAt(json, p.items);
    if (list === MISSING) {
      problems.push(`${where}: nothing at “${p.items}” in “${p.read}”.`);
      return null;
    }
    if (!Array.isArray(list)) {
      problems.push(`${where}: “${p.items}” in “${p.read}” isn’t a list.`);
      return null;
    }
    const out: ThingPageItem[] = [];
    let unnamed = 0;
    for (const [i, item] of list.slice(0, p.limit ?? 8).entries()) {
      const name = words(valueAt(item, p.name.at), p.name, ctx.now, ctx.timeZone);
      if (!name) {
        unnamed++;
        continue;
      }
      const detail = p.detail ? words(valueAt(item, p.detail.at), p.detail, ctx.now, ctx.timeZone) : null;
      const right = p.right ? words(valueAt(item, p.right.at), p.right, ctx.now, ctx.timeZone) : null;
      const tone = toneOf(item, p.tone);
      out.push({
        id: `${where}-${i}`,
        title: clip(name, 160),
        ...(detail ? { detail: clip(detail, 300) } : {}),
        ...(right ? { right: clip(right, 40) } : {}),
        ...(tone ? { tone } : {}),
        ...(p.icon ? { icon: p.icon } : {}),
      });
    }
    if (unnamed && !out.length) problems.push(`${where}: no item has a name at “${p.name.at}”.`);
    return out;
  };
  const listWords = (title: string, rows: ThingPageItem[], empty?: string) =>
    rows.length
      ? `${title}: ${rows
          .slice(0, 4)
          .map((r) => `${r.title}${r.right ? ` (${r.right})` : ''}${r.tone ? ` [${r.tone}]` : ''}`)
          .join(', ')}${rows.length > 4 ? `, … ${rows.length} in all` : ''}`
      : `${title}: empty${empty ? ` (“${empty}”)` : ''}`;

  // Live.
  let live: ReturnType<typeof liveList> | null = null;
  if (page.live) {
    const rows = items(page.live, 'live');
    if (rows) {
      live = liveList({
        id: 'live',
        title: page.live.title,
        ...(page.live.meta ? { meta: page.live.meta } : {}),
        items: rows,
        ...(page.live.empty ? { empty: page.live.empty } : {}),
      });
      shows.push(`Live · ${listWords(page.live.title, rows, page.live.empty)}`);
    }
  }

  // Inventory.
  let counts: ReturnType<typeof inventory> | null = null;
  if (page.counts) {
    const lines: ThingPageItem[] = [];
    for (const c of page.counts.lines) {
      const v = value(c.value, `Count “${c.id}”`);
      if (!v) continue;
      if (v.text === null) {
        problems.push(
          `Count “${c.id}”: the value at “${c.value.at}” can’t be written as ${c.value.format ?? 'text'}.`,
        );
        continue;
      }
      const note = c.change ? changeNote(c, v.raw, ctx) : null;
      const tone = toneOf(answerOf(answers, c.value.read), c.tone);
      lines.push(
        countLine({
          id: c.id,
          title: c.title,
          ...(c.detail ? { detail: c.detail } : {}),
          ...(c.icon ? { icon: c.icon } : {}),
          value: v.text,
          ...(note ? { note } : {}),
          ...(tone ? { tone, noteTone: tone } : {}),
        }),
      );
    }
    if (lines.length) {
      counts = inventory({
        id: 'counts',
        title: page.counts.title,
        ...(page.counts.meta ? { meta: page.counts.meta } : {}),
        items: lines,
      });
      shows.push(
        `Counts · ${page.counts.title}: ${lines.map((l) => `${l.title} ${l.figure?.value ?? ''}${l.figure?.note ? ` (${l.figure.note})` : ''}`).join(', ')}`,
      );
    }
  }

  // Trend: from Whombat's own readings, so it fills in day by day.
  let trendPanel: ReturnType<typeof trend> | null = null;
  if (page.trend) {
    const t = page.trend;
    const now = value(t.value, 'Trend');
    if (now && scaledNumber(now.raw, t.value) === null)
      problems.push(`Trend: the value at “${t.value.at}” in “${t.value.read}” isn’t a number.`);
    const days = lastDays(ctx.now, ctx.timeZone);
    const points = ctx.points.get(TREND_KEY) ?? [];
    const values = pointsByDay(points, days.keys, ctx.timeZone, t.how);
    if (daysWith(values) >= 2) {
      const known = values.filter((v): v is number => v !== null);
      const total = t.how === 'sum' ? known.reduce((a, b) => a + b, 0) : (known[known.length - 1] as number);
      const figure = words(total, t.value, ctx.now, ctx.timeZone) ?? String(total);
      trendPanel = trend({
        id: 'trend',
        title: t.title,
        ...(t.meta ? { meta: t.meta } : {}),
        days,
        values: values.map((v) => (v === null ? null : Math.round(v * 100) / 100)),
        label: t.label,
        figure: { value: figure, ...(t.rest ? { rest: t.rest } : {}) },
        ...(t.value.unit ? { unit: t.value.unit } : {}),
      });
      shows.push(`Trend · ${t.title}: ${daysWith(values)} days, ${figure}`);
    } else
      shows.push(
        `Trend · ${t.title}: shows once Whombat has readings on two days (now ${now?.text ?? 'nothing'}).`,
      );
  }

  // Anything else, below the slots.
  const more = [];
  if (page.list) {
    const rows = items(page.list, 'list');
    if (rows) {
      more.push({
        kind: 'list' as const,
        id: 'list',
        title: page.list.title,
        ...(page.list.meta ? { meta: page.list.meta } : {}),
        items: rows,
        ...(page.list.empty ? { empty: page.list.empty } : {}),
      });
      shows.push(`List · ${listWords(page.list.title, rows, page.list.empty)}`);
    }
  }

  // The head's facts.
  const facts: ThingLine[] = [];
  for (const f of page.facts ?? []) {
    const v = value(f.value, `Fact “${f.label}”`);
    if (v?.text) facts.push(line(`${f.label} **${clip(v.text, 60)}**`));
  }
  if (facts.length) shows.push(`Facts · ${facts.map((f) => f.map((p) => p.text).join('')).join(' · ')}`);

  // Worth a look.
  const notices: KindNotice[] = [];
  for (const w of page.warnings ?? []) {
    const json = answer(w.value.read);
    if (json === MISSING) continue;
    const raw = valueAt(json, w.value.at);
    if (!holds(raw, w, w.value.scale)) continue;
    notices.push(warningNotice(w, words(raw, w.value, ctx.now, ctx.timeZone)));
  }
  for (const n of notices) shows.push(`Worth a look · ${n.title}${n.detail ? `: ${n.detail}` : ''}`);
  if (page.warnings?.length && !notices.length) shows.push('Worth a look · nothing now');

  return {
    view: {
      ...slotPanels({ live, inventory: counts, trend: trendPanel, more }),
      kpis: [],
      notices,
      facts,
    },
    shows,
    problems,
  };
}

function answerOf(answers: ReadonlyMap<string, ReadAnswer>, read: string): unknown {
  const a = answers.get(read);
  return a?.ok ? a.value : undefined;
}

/** “+3 on last week”, “No change”, from the count's reading a week ago. */
function changeNote(c: PageCount, raw: unknown, ctx: Ctx): string | null {
  const now = scaledNumber(raw, c.value);
  if (now === null) return null;
  const points = ctx.points.get(pointKey(c.id)) ?? [];
  const weekAgo = ctx.now.getTime() - WEEK;
  // The reading nearest a week ago, within a day of it.
  let best: RawPoint | null = null;
  for (const p of points) {
    if (p.value === null) continue;
    const off = Math.abs(p.at.getTime() - weekAgo);
    if (off < 86_400_000 && (!best || off < Math.abs(best.at.getTime() - weekAgo))) best = p;
  }
  if (!best || best.value === null) return null;
  const diff = now - best.value;
  if (Math.abs(diff) < 1e-9) return 'No change';
  const n = Math.abs(diff);
  const amount = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return diff > 0 ? `+${amount} on last week` : `−${amount} on last week`;
}

function warningNotice(w: PageWarning, valueWords: string | null): KindNotice {
  return {
    id: `page-${w.id}`,
    tone: w.important ? 'bad' : 'info',
    icon: w.important ? 'warn' : 'info',
    title: clip(w.title, 120),
    ...(w.detail || valueWords ? { detail: clip(w.detail ?? `Now ${valueWords}.`, 200) } : {}),
    ...(w.important
      ? { link: { kind: 'ask' as const, label: 'Look into it', question: `${w.title}. What can I do?` } }
      : {}),
    nature: w.important ? 'problem' : 'fyi',
    check: w.important ? 'page.broken' : 'page.heads_up',
    subject: { id: `page:${w.id}`, name: clip(w.title, 80) },
    ignore: { lifts: 'fixed', words: 'Until it’s back to normal.' },
  };
}
