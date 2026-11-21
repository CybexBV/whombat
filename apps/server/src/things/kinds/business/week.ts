/**
 * A week of things that happened, for the developer kinds' Trend (pipelines and runs on the default branches, threads
 * that finished, tasks done): how many per day of the last 7, the week's total and how many failed, and the change on
 * the week before when the read reaches back that far. A read that may have missed older ones (a full page) says from
 * when it is whole (`since`): a day on or before it may lack some, so it gets no bar rather than a short one. Pure.
 */
import type { ThingTextPart } from '@whombat/core';
import { countByDay, dayKey, lastDays, type TrendPanel, weekChange } from '../slots';

const DAY = 86_400_000;

export interface Happened {
  at: Date;
  failed?: boolean;
}

export interface WeekCounts {
  days: ReturnType<typeof lastDays>;
  /** Per day, today last; null for a day the read may not hold whole. */
  values: (number | null)[];
  total: number;
  failed: number;
  /** “+18 %”, “−12 %”; null when the week before isn't known whole or had nothing. */
  change: string | null;
}

/** The last 7 days of `items`; `since` is when a read that filled its page reaches back to (null: it holds them all). */
export function weekCounts(
  items: readonly Happened[],
  now: Date,
  timeZone: string,
  since: Date | null,
): WeekCounts {
  const days = lastDays(now, timeZone);
  const cut = since ? dayKey(since, timeZone) : null;
  const values = countByDay(
    items.map((i) => i.at),
    days.keys,
    timeZone,
  ).map((n, i) => (cut && (days.keys[i] as string) <= cut ? null : n));
  const whole = new Set(days.keys.filter((_, i) => values[i] !== null));
  const inWeek = items.filter((i) => whole.has(dayKey(i.at, timeZone)));
  const before = lastDays(new Date(now.getTime() - 7 * DAY), timeZone).keys;
  const reaches = !cut || cut < (before[0] as string);
  const prior = countByDay(
    items.map((i) => i.at),
    before,
    timeZone,
  ).reduce((a, b) => a + b, 0);
  return {
    days,
    values,
    total: inWeek.length,
    failed: inWeek.filter((i) => i.failed).length,
    change: reaches && whole.size === days.keys.length ? weekChange(inWeek.length, prior) : null,
  };
}

/** A Trend with one more line under its figure (“3 failed”); a Trend holds two. */
export function withStat(chart: TrendPanel, parts: ThingTextPart[]): TrendPanel {
  return { ...chart, stats: [...(chart.stats ?? []), parts].slice(0, 2) };
}
