/**
 * Schedule math for automation schedules: five-field cron read in an IANA time zone, or a fixed interval.
 * Pure (Intl only), so the server, web ("Next run …") and tests agree.
 *
 * Local times that do not exist (the spring-forward gap) or happen twice (fall back) follow the
 * definition's explicit `DstPolicy`:
 *   skipped: `shift` → run at the same distance after the gap starts (02:30 in a 02:00–03:00 gap → 03:30),
 *            `skip`  → no run that day;
 *   repeated: `once` → the first of the two instants, `twice` → both.
 */
import type { DstPolicy, ScheduleSpec } from '../domain/automation.js';

export class ScheduleError extends Error {}

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Day-of-month / day-of-week restricted (standard cron: when both are, either may match). */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseValue(raw: string, min: number, names?: string[]): number {
  const lower = raw.toLowerCase();
  if (names) {
    const i = names.indexOf(lower);
    if (i >= 0) return i + min;
  }
  if (!/^\d{1,2}$/.test(raw)) throw new ScheduleError(`“${raw}” is not a number.`);
  return Number(raw);
}

function parseField(field: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (!part) throw new ScheduleError('A cron field has an empty item.');
    const [range, stepRaw] = part.split('/');
    if (range === undefined || part.split('/').length > 2) throw new ScheduleError(`“${part}” is not valid.`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1 || step > max)
      throw new ScheduleError(`“${part}” has a bad step.`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = parseValue(a ?? '', min, names);
      hi = parseValue(b ?? '', min, names);
    } else {
      lo = parseValue(range, min, names);
      hi = stepRaw === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi)
      throw new ScheduleError(`“${part}” is out of range (${min}–${max}).`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parses a five-field cron expression; throws `ScheduleError` with a readable message. */
export function parseCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new ScheduleError('A schedule has five fields: minute, hour, day of month, month, day of week.');
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const weekdays = parseField(dow, 0, 7, DAY_NAMES);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    minutes: parseField(m, 0, 59),
    hours: parseField(h, 0, 23),
    days: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12, MONTH_NAMES),
    weekdays,
    dayRestricted: dom !== '*',
    weekdayRestricted: dow !== '*',
  };
}

/* Time zones ------------------------------------------------------------------------------------ */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new ScheduleError(`“${timeZone}” is not a time zone.`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(ms: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's UTC offset at an instant, in ms (local = utc + offset). */
export function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instants at which a local wall-clock time happens in a zone: none (a DST gap), one, or two (the
 * repeated hour), in order.
 */
export function instantsForLocal(local: Omit<LocalParts, 'second'>, timeZone: string): number[] {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set([
    offsetAt(guess - 36 * 3600_000, timeZone),
    offsetAt(guess, timeZone),
    offsetAt(guess + 36 * 3600_000, timeZone),
  ]);
  const out: number[] = [];
  for (const off of offsets) {
    const t = guess - off;
    const p = localParts(t, timeZone);
    if (
      p.year === local.year &&
      p.month === local.month &&
      p.day === local.day &&
      p.hour === local.hour &&
      p.minute === local.minute &&
      !out.includes(t)
    )
      out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/** Where a nonexistent local time lands with `shift`: the offset from before the gap applied to it. */
function shiftedInstant(local: Omit<LocalParts, 'second'>, timeZone: string): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  // The offset in effect just before the gap (a day earlier is safely before it).
  const before = offsetAt(guess - 24 * 3600_000, timeZone);
  return guess - before;
}

/* Next fire times ------------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;
/** How far ahead a cron search looks before deciding the schedule never runs (covers Feb 29). */
const HORIZON_DAYS = 366 * 5;

function dayMatches(f: CronFields, y: number, m: number, d: number): boolean {
  if (!f.months.has(m)) return false;
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = f.days.has(d);
  const dowOk = f.weekdays.has(weekday);
  if (f.dayRestricted && f.weekdayRestricted) return domOk || dowOk;
  if (f.dayRestricted) return domOk;
  if (f.weekdayRestricted) return dowOk;
  return true;
}

/** Instants for one local day of a cron schedule, sorted, following the DST policy. */
function cronInstantsOnDay(
  f: CronFields,
  y: number,
  m: number,
  d: number,
  timeZone: string,
  dst: DstPolicy,
): number[] {
  const out: number[] = [];
  const hours = [...f.hours].sort((a, b) => a - b);
  const minutes = [...f.minutes].sort((a, b) => a - b);
  for (const hour of hours) {
    for (const minute of minutes) {
      const local = { year: y, month: m, day: d, hour, minute };
      const found = instantsForLocal(local, timeZone);
      if (found.length === 0) {
        if (dst.skipped === 'shift') out.push(shiftedInstant(local, timeZone));
      } else if (found.length === 2 && dst.repeated === 'twice') {
        out.push(...found);
      } else {
        out.push(found[0] as number);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface ScheduleContext {
  timeZone: string;
  dst: DstPolicy;
  /** Interval schedules count from here (the moment it was switched on). */
  anchor: number;
}

/** The first fire strictly after `after` (ms), or null when the schedule never fires again. */
export function nextFireAfter(spec: ScheduleSpec, after: number, ctx: ScheduleContext): number | null {
  if (spec.kind === 'interval') {
    const every = spec.everyMinutes * 60_000;
    if (after < ctx.anchor) return ctx.anchor;
    const k = Math.floor((after - ctx.anchor) / every) + 1;
    return ctx.anchor + k * every;
  }
  return nextCronFireAfter(parseCron(spec.expr), after, ctx);
}

function nextCronFireAfter(
  f: CronFields,
  after: number,
  ctx: ScheduleContext,
  days?: Map<number, number[]>,
): number | null {
  const start = localParts(after, ctx.timeZone);
  // Walk local calendar days from the day before (a shifted time can land on the next day's UTC).
  let cursor = Date.UTC(start.year, start.month - 1, start.day) - DAY_MS;
  for (let i = 0; i < HORIZON_DAYS; i++, cursor += DAY_MS) {
    const day = new Date(cursor);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(f, y, m, d)) continue;
    let instants = days?.get(cursor);
    if (!instants) {
      instants = cronInstantsOnDay(f, y, m, d, ctx.timeZone, ctx.dst);
      if (days) {
        // Catch-up revisits the same days for each fire. Keep only nearby days for this one search.
        days.set(cursor, instants);
        if (days.size > 3) days.delete(days.keys().next().value as number);
      }
    }
    let lo = 0;
    let hi = instants.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((instants[mid] as number) <= after) lo = mid + 1;
      else hi = mid;
    }
    if (lo < instants.length) return instants[lo] as number;
  }
  return null;
}

/** Fires in (from, to], oldest first, at most `max` (the newest ones when there are more). */
export function firesBetween(
  spec: ScheduleSpec,
  from: number,
  to: number,
  ctx: ScheduleContext,
  max: number,
): { fires: number[]; dropped: number } {
  const all: number[] = [];
  const cron = spec.kind === 'cron' ? parseCron(spec.expr) : null;
  const days = new Map<number, number[]>();
  let t = from;
  for (let guard = 0; guard < 10_000; guard++) {
    const next = cron ? nextCronFireAfter(cron, t, ctx, days) : nextFireAfter(spec, t, ctx);
    if (next === null || next > to) break;
    all.push(next);
    t = next;
  }
  const fires = all.slice(-max);
  return { fires, dropped: all.length - fires.length };
}

/** Throws `ScheduleError` when the schedule is malformed or never fires. */
export function checkSchedule(spec: ScheduleSpec, timeZone: string, now: number): void {
  formatter(timeZone);
  if (spec.kind === 'cron') {
    parseCron(spec.expr);
    if (
      nextFireAfter(spec, now, { timeZone, dst: { skipped: 'shift', repeated: 'once' }, anchor: now }) ===
      null
    )
      throw new ScheduleError('This schedule never runs.');
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const DAY_ALIASES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** A cron day of the week (`5`, `fri`, `7` for Sunday) as its index, else null. */
function dayIndex(field: string): number | null {
  const named = DAY_ALIASES[field.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^[0-7]$/.test(field)) return null;
  return Number(field) % 7;
}

/** “Monday”, “Monday and Thursday”, “Monday, Wednesday and Friday”. */
function andList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

/** The days a cron day-of-week field names, after “Every”: “day”, “weekday”, “Friday”, “Monday and Thursday”. */
function cronDays(dow: string): string | null {
  if (dow === '*') return 'day';
  if (/^(1-5|mon-fri)$/i.test(dow)) return 'weekday';
  const range = /^([a-z0-7]+)-([a-z0-7]+)$/i.exec(dow);
  if (range) {
    const a = dayIndex(range[1] as string);
    const b = dayIndex(range[2] as string);
    return a === null || b === null ? null : `${WEEKDAYS[a]} to ${WEEKDAYS[b]}`;
  }
  const days = dow.split(',').map(dayIndex);
  if (days.some((d) => d === null)) return null;
  const sorted = [...new Set(days as number[])].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
  return andList(sorted.map((d) => WEEKDAYS[d] as string));
}

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/**
 * A cron expression as people say it (“Every Friday at 16:00”, “Every weekday at 08:30”, “Every 15 minutes”, “On the
 * 1st of every month at 09:00”); null for one these words can't say, which is then “On its own schedule”.
 */
export function cronWords(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (mon !== '*') return null;
  const step = /^\*\/(\d{1,2})$/;
  if (hour === '*' && dom === '*' && dow === '*') {
    const every = step.exec(min);
    if (every) return Number(every[1]) === 1 ? 'Every minute' : `Every ${Number(every[1])} minutes`;
    if (/^\d{1,2}$/.test(min)) return 'Every hour';
    return null;
  }
  if (/^\d{1,2}$/.test(min) && step.test(hour) && dom === '*' && dow === '*')
    return `Every ${Number((step.exec(hour) as RegExpExecArray)[1])} hours`;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  const time = `${pad(Number(hour))}:${pad(Number(min))}`;
  if (/^\d{1,2}$/.test(dom) && dow === '*') return `On the ${ordinal(Number(dom))} of every month at ${time}`;
  if (dom !== '*') return null;
  const days = cronDays(dow);
  return days ? `Every ${days} at ${time}` : null;
}

/**
 * When an automation runs, as people read it: “Every 30 minutes”, “Every Monday at 09:00”, “Every weekday at 08:30”;
 * “On its own schedule” for a cron expression words can't say. The time zone is the Whombat's own, so it goes without
 * saying; `timeZone` is kept for callers that name the schedule's zone elsewhere.
 */
export function describeSchedule(spec: ScheduleSpec, _timeZone: string): string {
  if (spec.kind === 'interval') {
    const m = spec.everyMinutes;
    if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`;
    if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  return cronWords(spec.expr) ?? 'On its own schedule';
}
