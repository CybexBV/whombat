/**
 * Uptime that is true (docs/decisions/monitoring.md MON-09): how much of a period a thing answered, from the health
 * pass's `up` points (1 answered, 0 didn't; an hour rolled up keeps its share), and the line a page says it in: “Up
 * 99.6 % this week · down 3 times, 41 min”, “Up all week”. Pure.
 */
import type { ThingTextPart, ThingUptime } from '@whombat/core';
import { HEALTH_POINT_MS, pointRollupBefore } from '../things/points';
import type { RawPoint } from '../things/series';
import { dayMonth, line } from '../things/words';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The period a page's line covers. */
export const UPTIME_WEEK_MS = 7 * DAY;

/**
 * Whether the thing answered, point by point, oldest first: its `up` points, and before the first of them (points kept
 * before `up` was recorded) its response time: answered when it has one.
 */
export function upPoints(up: readonly RawPoint[], rtt: readonly RawPoint[]): RawPoint[] {
  const first = Math.min(...up.map((p) => p.at.getTime()));
  const older = rtt
    .filter((p) => p.at.getTime() < first)
    .map((p) => ({ at: p.at, value: p.value !== null && Number.isFinite(p.value) ? 1 : 0 }));
  return [...up.filter((p) => p.value !== null && Number.isFinite(p.value)), ...older].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
}

/** How much of `[from, to]` the points say it answered. */
export interface UpShare {
  /** 0…1; null without a point in the period. */
  share: number | null;
  /** The time the points stand for, ms. */
  coveredMs: number;
  /** The time they say it didn't answer, ms. */
  missedMs: number;
  /** The first point in the period. */
  first: Date | null;
}

/**
 * The share of `[from, to]` the thing answered (`upPoints`' output), each point weighed by the time it stands for: until
 * the next point, at most 7.5 minutes for a health reading or an hour for a rollup. The rest of a gap has no reading.
 */
export function upShare(points: readonly RawPoint[], from: Date, to: Date): UpShare {
  const inside = points.filter(
    (p) => p.value !== null && p.at.getTime() >= from.getTime() && p.at.getTime() <= to.getTime(),
  );
  let covered = 0;
  let up = 0;
  const rolledBefore = pointRollupBefore(to);
  for (const [i, p] of inside.entries()) {
    const at = p.at.getTime();
    const rolled = at < rolledBefore && at % HOUR === 0;
    const expected = rolled ? HOUR : HEALTH_POINT_MS;
    const next = inside[i + 1];
    const gap = next ? next.at.getTime() - at : expected;
    const weight = Math.max(0, Math.min(gap, rolled ? HOUR : expected * 1.5));
    covered += weight;
    up += weight * Math.min(1, Math.max(0, p.value as number));
  }
  return {
    share: covered > 0 ? up / covered : inside.length ? (inside[0]?.value ?? 0) : null,
    coveredMs: covered,
    missedMs: covered - up,
    first: inside[0]?.at ?? null,
  };
}

/** A stretch a thing was down: from, until (null while it lasts). */
export interface DownStretch {
  from: Date;
  to: Date | null;
}

/**
 * The stretches within `[from, to]` it was down, overlapping ones (its incident and a server's offline alert about the
 * same outage) made one: how many and how long, in whole minutes.
 */
export function downTime(
  stretches: readonly DownStretch[],
  from: Date,
  to: Date,
): { count: number; minutes: number; ms: number } {
  const clipped = stretches
    .map((s) => ({
      from: Math.max(s.from.getTime(), from.getTime()),
      to: Math.min((s.to ?? to).getTime(), to.getTime()),
    }))
    .filter((s) => s.to > s.from || (s.to === s.from && s.from > from.getTime()))
    .sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const s of clipped) {
    const last = merged.at(-1);
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  const ms = merged.reduce((sum, s) => sum + (s.to - s.from), 0);
  return { count: merged.length, minutes: Math.round(ms / MINUTE), ms };
}

/** “99.6 %”; never 100 % while it missed something (“99.9 %”), whole below 95. */
export function percentWords(share: number): string {
  if (share >= 1) return '100 %';
  const p = share * 100;
  if (p >= 95) return `${(Math.min(99.9, Math.floor(p * 10) / 10)).toFixed(1)} %`;
  return `${Math.round(p)} %`;
}

/** “once”, “twice”, “3 times”. */
export function timesWords(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** “41 min”, “2 h 5 min”, “3 d 4 h”; at least a minute. */
export function durationWords(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

export interface UptimeInput {
  /** The share it answered over the period, null when no check of it tells. */
  share: number | null;
  /** Its down stretches in the period. */
  downs: number;
  downMinutes: number;
  /** Where the period starts: `days` ago, or when Whombat started watching it. */
  from: Date;
  now: Date;
  timeZone: string;
  /** The period's length in days: 7 (“this week”) unless said. */
  days?: number;
}

/**
 * The line: “Up **99.6 %** this week · down **3 times**, **41 min**”, “Up **all week**”, “Down **twice** this week, **12
 * min**”; “since 21 Nov” for a thing watched less than a week. Null when Whombat knows nothing of it yet.
 */
export function uptimeLine(input: UptimeInput): { text: string; parts: ThingTextPart[] } | null {
  const { share, downs, downMinutes } = input;
  if (share === null && downs === 0) return null;
  const days = input.days ?? 7;
  const whole = input.now.getTime() - input.from.getTime() >= days * DAY;
  const period = !whole
    ? `since ${dayMonth(input.from, input.timeZone)}`
    : days === 7
      ? 'this week'
      : `in the last ${days} days`;
  const all = days === 7 ? 'all week' : `all ${days} days`;
  const down = downs ? `down **${timesWords(downs)}**, **${durationWords(downMinutes)}**` : '';
  let marked: string;
  if (share === null) marked = `Down **${timesWords(downs)}** ${period}, **${durationWords(downMinutes)}**`;
  else if (share >= 1 && !downs) marked = whole ? `Up **${all}**` : `Up ${period}`;
  else marked = `Up **${percentWords(share)}** ${period}${down ? ` · ${down}` : ''}`;
  return { text: marked.replace(/\*\*/g, ''), parts: line(marked) };
}

/** The page's `uptime` from the line's input; null when there is no line. */
export function thingUptime(input: UptimeInput): { uptime: ThingUptime; parts: ThingTextPart[] } | null {
  const said = uptimeLine(input);
  if (!said) return null;
  return {
    uptime: {
      text: said.text,
      upPct:
        input.share === null
          ? null
          : input.share >= 1
            ? 100
            : Math.min(99.9, Math.floor(input.share * 1000) / 10),
      downs: input.downs,
      downMinutes: input.downMinutes,
      from: input.from.toISOString(),
    },
    parts: said.parts,
  };
}
