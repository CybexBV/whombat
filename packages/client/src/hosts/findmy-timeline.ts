/**
 * A Find My timeline in words and numbers both apps share (docs/implementation/macos/findmy-timeline.md §1): the day's
 * name and its bar, each strip's parts and its axis, a colour per place that stays while the tab is open (Home first),
 * one person's day as a list with its rail, the map's numbered markers and the lines between them, the week's totals,
 * and the words of the card before it's on and of its settings. The box answers each day already cut into segments
 * (`connections.findMyTimeline`); this only says them. Pure; the hooks are `findmy-timeline-react.ts`.
 */
import {
  FIND_MY_LISTENED_MS,
  FIND_MY_TIMELINE_DAYS,
  type FindMySpot,
  type FindMyTimelineDay,
  type FindMyTimelinePerson,
  type FindMyTimelineSegment,
  type FindMyTimelineStay,
  type FindMyTimelineWhy,
  findMyDateAdd,
  findMyPlaceKey,
} from '@whombat/core/domain';
import { interpolate, resolveLanguage } from '@whombat/core/i18n';
import {
  dayKey,
  formatClock,
  monthName,
  shortMonthName,
  shortWeekdayName,
  weekdayName,
  zonedParts,
} from '@whombat/core/text';
import { clientTree } from '../i18n/catalog';
import { HOSTS_FIND_MY_TIMELINE_WORDS } from '../i18n/messages/connectionsHosts/findMy';
import { findMyEvery, findMyFirstName } from './findmy';

/** The timeline's words that aren't built from what was kept. */
export function findMyTimelineWords(locale?: string | null) {
  const w = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS);
  const days = FIND_MY_TIMELINE_DAYS;
  return {
    everyone: w.everyone,
    settings: w.settings,
    day: w.day,
    week: w.week,
    dayOrWeek: w.dayOrWeek,
    dayBefore: w.dayBefore,
    dayAfter: w.dayAfter,
    lastWeek: w.lastWeek,
    today: w.today,
    yesterday: w.yesterday,
    notKept: w.notKept,
    keepToo: (first: string) => interpolate(w.keepToo, { first }),
    onTheWay: w.onTheWay,
    notRead: w.notRead,
    noLocation: w.noLocation,
    now: w.now,
    nearby: w.nearby,
    soFar: (duration: string) => interpolate(w.soFar, { duration }),
    linesNote: (first: string) => interpolate(w.linesNote, { first }),
    spotsNote: (shortest: string) => interpolate(w.spotsNote, { shortest }),
    noLocationFor: (first: string) => interpolate(w.noLocationFor, { first }),
    inUse: (mac: string) => interpolate(w.inUse, { Mac: `${mac.charAt(0).toUpperCase()}${mac.slice(1)}` }),
    notReadThen: w.notReadThen,
    couldntRead: (mac: string) => interpolate(w.couldntRead, { mac }),
    nothingKept: (first: string) => interpolate(w.nothingKept, { first }),
    mapAlt: (first: string) => interpolate(w.mapAlt, { first }),
    drawing: w.drawing,
    noSpots: (first: string) => interpolate(w.noSpots, { first }),
    weekTitle: (first: string) => interpolate(w.weekTitle, { first }),
    pickDay: w.pickDay,
    stripLabel: (first: string, day: string) => interpolate(w.stripLabel, { first, day: day.toLowerCase() }),
    /** Before it's on. */
    introTitle: w.introTitle,
    introBody: w.introBody,
    introPlaces: (every: string) => interpolate(w.introPlaces, { every }),
    introOnly: w.introOnly,
    introDays: interpolate(w.introDays, { days }),
    keep: w.keep,
    shouldKnow: w.shouldKnow,
    noRead: w.noRead,
    keepLabel: (first: string) => interpolate(w.keepLabel, { first }),
    /** The settings. */
    whose: w.whose,
    whoseHint: w.whoseHint,
    keptSince: (date: string) => interpolate(w.keptSince, { date }),
    keptDays: interpolate(w.keptDays, { days }),
    keptDaysHint: interpolate(w.keptDaysHint, { days }),
    assistantReads: (name: string) => interpolate(w.assistantReads, { name }),
    assistantHint: (first: string) => interpolate(w.assistantHint, { first }),
    assistantLabel: (name: string) => interpolate(w.assistantLabel, { name }),
    onlyYou: (name: string) => interpolate(w.onlyYou, { name }),
    deleteTitle: w.deleteTitle,
    deleteHint: w.deleteHint,
    deleteButton: w.deleteButton,
    stopTitle: w.stopTitle,
    stopHint: w.stopHint,
    stopButton: w.stopButton,
    /** Asked first. */
    untickAsk: (first: string) => interpolate(w.untickAsk, { first }),
    untickBody: (name: string) => interpolate(w.untickBody, { name }),
    untickConfirm: (first: string) => interpolate(w.untickConfirm, { first }),
    deleteAsk: w.deleteAsk,
    deleteBody: w.deleteBody,
    deleteConfirm: w.deleteConfirm,
    stopAsk: w.stopAsk,
    stopBody: w.stopBody,
    stopConfirm: w.stopConfirm,
    cancel: w.cancel,
    /** Said after a change. */
    deleted: w.deleted,
    stopped: w.stopped,
  };
}

export const FIND_MY_TIMELINE_WORDS = findMyTimelineWords('en');

/** A weekday's name as a title (“Saturday”, “Zaterdag”). */
function weekdayTitle(weekday: number, locale?: string | null): string {
  const name = weekdayName(weekday, locale);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The device's IANA time zone, whose days the timeline is cut into (UTC when it doesn't say). */
export function findMyDeviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Today's date in the zone, `YYYY-MM-DD`. */
export function findMyToday(now: number, tz: string): string {
  return dayKey(now, tz);
}

/** The first day the bar goes back to: as far as the box keeps. */
export function findMyFirstDay(today: string): string {
  return findMyDateAdd(today, -FIND_MY_TIMELINE_DAYS);
}

function dateParts(date: string): { y: number; m: number; d: number; weekday: number } {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/**
 * The bar's day: “Today” with “Monday 23 November”, “Yesterday” with “Sunday 22 November”, else “Saturday” with “21
 * November” (the year too when it isn't today's).
 */
export function findMyDayTitle(
  date: string,
  today: string,
  locale?: string | null,
): { title: string; date: string } {
  const w = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS);
  const p = dateParts(date);
  const year = p.y === dateParts(today).y ? '' : ` ${p.y}`;
  const day = `${p.d} ${monthName(p.m, locale)}${year}`;
  const weekday = weekdayName(p.weekday, locale);
  if (date === today) return { title: w.today, date: `${weekday} ${day}` };
  if (date === findMyDateAdd(today, -1)) return { title: w.yesterday, date: `${weekday} ${day}` };
  return { title: weekdayTitle(p.weekday, locale), date: day };
}

/** A week row's day: “Tue 17”. */
export function findMyWeekDay(date: string, locale?: string | null): string {
  const p = dateParts(date);
  return `${shortWeekdayName(p.weekday, locale)} ${p.d}`;
}

/** The week's dates in its card's head: “17 – 23 November”, “28 October – 3 November”. */
export function findMyWeekRange(first: string, last: string, locale?: string | null): string {
  const a = dateParts(first);
  const b = dateParts(last);
  return a.m === b.m && a.y === b.y
    ? `${a.d} – ${b.d} ${monthName(b.m, locale)}`
    : `${a.d} ${monthName(a.m, locale)} – ${b.d} ${monthName(b.m, locale)}`;
}

/** “kept since 23 Nov”, in the zone. */
export function findMyKeptSince(iso: string, tz: string, locale?: string | null): string {
  const p = zonedParts(iso, tz);
  return findMyTimelineWords(locale).keptSince(`${p.day} ${shortMonthName(p.month, locale)}`);
}

/** “7 h 50 min”, “40 min”, “2 h”. */
export function findMyDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE_MS));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** “5 minutes”, “a minute”, “an hour”, “2 hours”: the shortest stop the pace can miss. */
export function findMyMinutes(minutes: number, locale?: string | null): string {
  const w = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS).minutes;
  if (minutes === 1) return w.minute;
  if (minutes === 60) return w.hour;
  if (minutes > 60 && minutes % 60 === 0) return interpolate(w.hours, { count: minutes / 60 });
  return interpolate(w.minutes, { count: minutes });
}

/**
 * How often a connection with a timeline reads, in minutes: its own pace when faster, else every 15 minutes (a
 * timeline is read at least that often, even when Read in the background is Off).
 */
export function findMyTimelinePace(paceMinutes: number | null): number {
  const listened = FIND_MY_LISTENED_MS / MINUTE_MS;
  return paceMinutes ? Math.min(paceMinutes, listened) : listened;
}

/** A time on the day in the zone, “08:30”; the day's own end is “24:00”. */
export function findMyClock(iso: string, tz: string, dayTo?: string): string {
  if (dayTo && Date.parse(iso) >= Date.parse(dayTo)) return '24:00';
  return formatClock(iso, tz);
}

/** Find My's “seen …” words after “seen”: “seen 4 min ago”, “seen now”. */
function seen(when: string, locale?: string | null): string {
  return interpolate(clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS).seen, {
    when: `${when.charAt(0).toLowerCase()}${when.slice(1)}`,
  });
}

/**
 * The Everyone card's meta: today “Reads every 15 minutes · last read 15:18”, another day “Read every 15 minutes”.
 */
export function findMyEveryoneMeta(
  timeline: { paceMinutes: number | null; readAt: string | null },
  today: boolean,
  tz: string,
  locale?: string | null,
): string {
  const w = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS).meta;
  const pace = timeline.paceMinutes ? findMyEvery(timeline.paceMinutes, locale) : null;
  if (!today) return pace ? interpolate(w.read, { pace }) : '';
  const clock = timeline.readAt ? formatClock(timeline.readAt, tz) : null;
  if (pace) return clock ? interpolate(w.readsLast, { pace, clock }) : interpolate(w.reads, { pace });
  return clock ? interpolate(w.last, { clock }) : '';
}

/* Colours per place --------------------------------------------------------------------------------- */

/** How many place colours there are: the four chart series, then one more (the apps name them). */
export const FIND_MY_PLACE_TONES = 5;

/** Home's key: it always has the first colour. */
const HOME = findMyPlaceKey('Home');

/** A place's key for its colour: Find My's place words, without case or spaces (“Wilgendam” for both its streets). */
export function findMyPlaceColourKey(place: string): string {
  return findMyPlaceKey(place);
}

/**
 * The places in the order their colours were given: Home first always, then the ones `known` had, then new ones in the
 * order they were first reached on the days given. Kept while the tab is open, so a place keeps its colour from day to
 * day.
 */
export function findMyPlaceOrder(
  known: readonly string[],
  days: readonly Pick<FindMyTimelineDay, 'people'>[],
): string[] {
  const order = known[0] === HOME ? [...known] : [HOME, ...known.filter((k) => k !== HOME)];
  const seen = new Set(order);
  const stays: { at: number; key: string }[] = [];
  for (const day of days)
    for (const p of day.people)
      for (const s of p.segments)
        if (s.kind === 'stay') stays.push({ at: Date.parse(s.from), key: findMyPlaceColourKey(s.place) });
  stays.sort((a, b) => a.at - b.at);
  for (const { key } of stays)
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  return order;
}

/** A place's colour, 0…4: Home 0, the others in turn over the rest. */
export function findMyPlaceTone(order: readonly string[], place: string): number {
  const key = findMyPlaceColourKey(place);
  if (key === HOME) return 0;
  const i = order.indexOf(key);
  const at = i < 0 ? order.length : i;
  return 1 + ((Math.max(at, 1) - 1) % (FIND_MY_PLACE_TONES - 1));
}

export interface FindMyLegendItem {
  key: string;
  /** Find My's words, as first said. */
  label: string;
  tone: number;
}

/** The places of the segments given, in their colours' order, each once. */
export function findMyLegend(
  order: readonly string[],
  segments: readonly (readonly FindMyTimelineSegment[])[],
): FindMyLegendItem[] {
  const words = new Map<string, string>();
  for (const list of segments)
    for (const s of list)
      if (s.kind === 'stay') {
        const key = findMyPlaceColourKey(s.place);
        if (!words.has(key)) words.set(key, s.place);
      }
  const keys = [...words.keys()].sort((a, b) => rank(order, a) - rank(order, b));
  return keys.map((key) => ({
    key,
    label: words.get(key) ?? key,
    tone: findMyPlaceTone(order, words.get(key) ?? key),
  }));
}

function rank(order: readonly string[], key: string): number {
  const i = order.indexOf(key);
  return i < 0 ? order.length : i;
}

/* Strips and their axis ------------------------------------------------------------------------------ */

/** A gap's or hole's title: “No location”, else “Not read”. */
export function findMyWhyTitle(why: FindMyTimelineWhy, locale?: string | null): string {
  const w = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS);
  return why === 'no_location' ? w.noLocation : w.notRead;
}

/** A gap's line in the list: why there was no place, in plain words. */
export function findMyWhyText(
  why: FindMyTimelineWhy,
  first: string,
  mac: string,
  locale?: string | null,
): string {
  const w = findMyTimelineWords(locale);
  if (why === 'no_location') return w.noLocationFor(first);
  if (why === 'not_read') return w.notReadThen;
  if (why === 'in_use') return w.inUse(mac);
  return w.couldntRead(mac);
}

export type FindMyStripPart = {
  /** Where it starts and how wide it is, as parts of the day (0…1). */
  at: number;
  width: number;
  /** “Wilgendam · 08:30–12:15”, “On the way · 07:50–08:30”. */
  title: string;
} & ({ kind: 'stay'; tone: number } | { kind: 'trip' } | { kind: 'gap' });

type Span = { from: string; to: string };

function fraction(day: Span, iso: string): number {
  const from = Date.parse(day.from);
  const len = Date.parse(day.to) - from;
  if (!(len > 0)) return 0;
  return Math.min(1, Math.max(0, (Date.parse(iso) - from) / len));
}

/** A day's strip: each stay in its place's colour, trips hatched, gaps and a stay's holes as dashed gaps. */
export function findMyStrip(
  segments: readonly FindMyTimelineSegment[],
  day: Span,
  order: readonly string[],
  tz: string,
  locale?: string | null,
): FindMyStripPart[] {
  const out: FindMyStripPart[] = [];
  const onTheWay = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS).onTheWay;
  const range = (s: Span) => `${findMyClock(s.from, tz)}–${findMyClock(s.to, tz, day.to)}`;
  const place = (s: Span) => {
    const at = fraction(day, s.from);
    return { at, width: Math.max(0, fraction(day, s.to) - at) };
  };
  for (const s of segments) {
    if (s.kind === 'stay') {
      out.push({
        kind: 'stay',
        ...place(s),
        tone: findMyPlaceTone(order, s.place),
        title: `${s.place} · ${range(s)}`,
      });
      for (const h of s.holes)
        out.push({ kind: 'gap', ...place(h), title: `${findMyWhyTitle(h.why, locale)} · ${range(h)}` });
    } else if (s.kind === 'trip') out.push({ kind: 'trip', ...place(s), title: `${onTheWay} · ${range(s)}` });
    else out.push({ kind: 'gap', ...place(s), title: `${findMyWhyTitle(s.why, locale)} · ${range(s)}` });
  }
  return out;
}

/** Where now is on the day (0…1), or null when the day isn't today. */
export function findMyNowAt(day: Span, now: number): number | null {
  const from = Date.parse(day.from);
  const to = Date.parse(day.to);
  return now >= from && now < to ? fraction(day, new Date(now).toISOString()) : null;
}

export interface FindMyAxis {
  /** 00:00, 06:00, 12:00, 18:00, 24:00 where the clock shows them (a clock change moves the middle ones). */
  ticks: { label: string; at: number; near: boolean }[];
  /** Today: now's time and place. */
  now: { label: string; at: number } | null;
}

/** The zone's offset at an instant (ms; local = UTC + offset). */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Ticks closer to now than this part of the day give way to now's time on a narrow screen. */
const NEAR_NOW = 0.13;

/** The strips' axis: 00:00 … 24:00 and, today, now's time. */
export function findMyAxis(day: Span, tz: string, now: number | null): FindMyAxis {
  const from = Date.parse(day.from);
  const nowAt = now === null ? null : findMyNowAt(day, now);
  const ticks = [0, 6, 12, 18, 24].map((h) => {
    let at = h / 24;
    if (h > 0 && h < 24) {
      const t = from + h * HOUR_MS;
      at = fraction(day, new Date(t + offsetAt(from, tz) - offsetAt(t, tz)).toISOString());
    } else if (h === 24) at = 1;
    return {
      label: `${String(h).padStart(2, '0')}:00`,
      at,
      near: nowAt !== null && Math.abs(at - nowAt) < NEAR_NOW,
    };
  });
  return {
    ticks,
    now: nowAt === null || now === null ? null : { label: formatClock(now, tz), at: nowAt },
  };
}

/* Distances ------------------------------------------------------------------------------------------- */

/** Kilometres between two spots, in a straight line. */
export function findMyKm(a: Pick<FindMySpot, 'lat' | 'lon'>, b: Pick<FindMySpot, 'lat' | 'lon'>): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** “300 m”, “3.7 km”, “31 km”. */
export function findMyDistance(km: number, locale?: string | null): string {
  if (km < 1) return `${Math.max(100, Math.round(km * 10) * 100)} m`;
  if (km < 10) {
    const text = km.toFixed(1);
    return `${resolveLanguage(locale) === 'nl' ? text.replace('.', ',') : text} km`;
  }
  return `${Math.round(km)} km`;
}

/* One person's day ----------------------------------------------------------------------------------- */

const stays = (segments: readonly FindMyTimelineSegment[]) =>
  segments.filter((s): s is FindMyTimelineStay => s.kind === 'stay');

/**
 * The person card's meta: today while they're somewhere, “Now in Wilgendam · seen 4 min ago”; else “4 stops · about 62
 * km between them”.
 */
export function findMyDayMeta(
  segments: readonly FindMyTimelineSegment[],
  person: Pick<FindMyTimelinePerson, 'now'>,
  locale?: string | null,
): string {
  const w = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS).dayMeta;
  const list = stays(segments);
  const last = list.at(-1);
  if (last?.ongoing) {
    const when = person.now?.when;
    return when
      ? interpolate(w.nowSeen, { place: last.place, seen: seen(when, locale) })
      : interpolate(w.now, { place: last.place });
  }
  if (!list.length) return w.none;
  const count = w.stops(list.length);
  let km = 0;
  let measured = false;
  let prev: FindMySpot | null = null;
  for (const s of list) {
    if (s.spot && prev) {
      km += findMyKm(prev, s.spot);
      measured = true;
    }
    if (s.spot) prev = s.spot;
  }
  return measured && list.length > 1
    ? interpolate(w.between, { count, distance: findMyDistance(km, locale) })
    : count;
}

export type FindMyListRow = {
  key: string;
  /** “08:30”. */
  time: string;
  /** “7 h 50 min”, “1 h 35 min so far”. */
  duration: string;
} & (
  | {
      kind: 'stay';
      /** Its number among the day's stops, from 1. */
      n: number;
      tone: number;
      place: string;
      /** The street, and “seen 4 min ago” while they're there. */
      sub: string;
      ongoing: boolean;
      nearby: boolean;
      /** “No location 02:10–06:30”. */
      holes: string[];
    }
  | { kind: 'trip' | 'gap'; title: string; sub: string }
);

/** One person's day as the list under the map: each stop numbered in its colour, the way between and the gaps. */
export function findMyListRows(
  segments: readonly FindMyTimelineSegment[],
  ctx: {
    tz: string;
    day: Span;
    person: Pick<FindMyTimelinePerson, 'name' | 'now'>;
    /** The Mac's name as the page shows it. */
    mac: string;
    order: readonly string[];
    /** The language the words are in (English when none is given). */
    locale?: string | null;
  },
): FindMyListRow[] {
  const locale = ctx.locale;
  const words = findMyTimelineWords(locale);
  const route$ = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS).route;
  const first = findMyFirstName(ctx.person.name);
  const clock = (iso: string) => findMyClock(iso, ctx.tz, ctx.day.to);
  let n = 0;
  let prev: FindMyTimelineStay | null = null;
  return segments.map((s, i): FindMyListRow => {
    const time = findMyClock(s.from, ctx.tz);
    const length = findMyDuration(Date.parse(s.to) - Date.parse(s.from));
    const key = `${s.kind}-${s.from}-${i}`;
    if (s.kind === 'stay') {
      n++;
      prev = s;
      const when = ctx.person.now?.when;
      const sub = [s.address, s.ongoing && when ? seen(when, locale) : null].filter(Boolean).join(' · ');
      return {
        kind: 'stay',
        key,
        time,
        duration: s.ongoing ? words.soFar(length) : length,
        n,
        tone: findMyPlaceTone(ctx.order, s.place),
        place: s.place,
        sub,
        ongoing: s.ongoing,
        nearby: s.ongoing && !!ctx.person.now?.nearby,
        holes: s.holes.map((h) => `${findMyWhyTitle(h.why, locale)} ${clock(h.from)}–${clock(h.to)}`),
      };
    }
    if (s.kind === 'trip') {
      const from: FindMyTimelineStay | null = prev;
      const to = stays(segments.slice(i + 1))[0] ?? null;
      const route =
        from && to
          ? findMyPlaceKey(from.place) === findMyPlaceKey(to.place)
            ? interpolate(route$.within, { place: to.place })
            : `${from.place} → ${to.place}`
          : to
            ? interpolate(route$.to, { place: to.place })
            : from
              ? interpolate(route$.from, { place: from.place })
              : null;
      const far =
        from?.spot && to?.spot
          ? interpolate(route$.far, { distance: findMyDistance(findMyKm(from.spot, to.spot), locale) })
          : null;
      return {
        kind: 'trip',
        key,
        time,
        duration: length,
        title: words.onTheWay,
        sub: [route, far].filter(Boolean).join(' · '),
      };
    }
    return {
      kind: 'gap',
      key,
      time,
      duration: length,
      title: findMyWhyTitle(s.why, locale),
      sub: findMyWhyText(s.why, first, ctx.mac, locale),
    };
  });
}

/* The map --------------------------------------------------------------------------------------------- */

export interface FindMyTimelineMark {
  /** The stops at this spot, numbered among the day's stays. */
  stops: number[];
  /** “2, 4”. */
  label: string;
  tone: number;
  /** Where its middle sits in the box. */
  x: number;
  y: number;
}

/** Each stop's number with its place's colour, for the markers. */
export function findMyStopTones(
  segments: readonly FindMyTimelineSegment[],
  order: readonly string[],
): Map<number, number> {
  return new Map(stays(segments).map((s, i) => [i + 1, findMyPlaceTone(order, s.place)]));
}

/**
 * The day's markers in a map box of `box`: the Mac's points (asked at `ask`) carried to the box showing the picture as
 * `cover` does (scaled to fill, centred), those outside the box left out.
 */
export function findMyTimelineMarks(
  points: readonly { stops: readonly number[]; x: number; y: number }[],
  ask: { w: number; h: number },
  box: { w: number; h: number },
  tones: ReadonlyMap<number, number>,
): FindMyTimelineMark[] {
  if (!(ask.w > 0 && ask.h > 0 && box.w > 0 && box.h > 0)) return [];
  const s = Math.max(box.w / ask.w, box.h / ask.h);
  const out: FindMyTimelineMark[] = [];
  for (const p of points) {
    const x = box.w / 2 + (p.x - ask.w / 2) * s;
    const y = box.h / 2 + (p.y - ask.h / 2) * s;
    if (x < 0 || x > box.w || y < 0 || y > box.h || !p.stops.length) continue;
    out.push({ stops: [...p.stops], label: p.stops.join(', '), tone: tones.get(p.stops[0] ?? 0) ?? 0, x, y });
  }
  return out;
}

export interface FindMyTimelineLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Whombat didn't read in between (a gap between the two stops): dotted, else dashed. */
  dotted: boolean;
}

/** Lines between the day's stops in order, from marker to marker; dotted where Whombat didn't read in between. */
export function findMyTimelineLines(
  segments: readonly FindMyTimelineSegment[],
  marks: readonly FindMyTimelineMark[],
): FindMyTimelineLine[] {
  const byStop = new Map<number, FindMyTimelineMark>();
  for (const m of marks) for (const n of m.stops) byStop.set(n, m);
  const out: FindMyTimelineLine[] = [];
  let n = 0;
  let last: FindMyTimelineMark | null = null;
  let unread = false;
  for (const s of segments) {
    if (s.kind === 'gap') unread = true;
    if (s.kind !== 'stay') continue;
    n++;
    const here = byStop.get(n) ?? null;
    if (last && here && last !== here)
      out.push({ x1: last.x, y1: last.y, x2: here.x, y2: here.y, dotted: unread });
    last = here;
    unread = false;
  }
  return out;
}

/** The marker the person's avatar stands over: the stop they're at now, today. */
export function findMyNowMark(
  segments: readonly FindMyTimelineSegment[],
  marks: readonly FindMyTimelineMark[],
): FindMyTimelineMark | null {
  const list = stays(segments);
  const last = list.at(-1);
  if (!last?.ongoing) return null;
  return marks.find((m) => m.stops.includes(list.length)) ?? null;
}

/* The week -------------------------------------------------------------------------------------------- */

export interface FindMyTotal {
  key: string;
  label: string;
  /** A place's colour, or how On the way and Not read are drawn. */
  tone: number | 'trip' | 'gap';
  /** “104 h”, in whole hours. */
  value: string;
}

/** Whole hours: “104 h”; a little time is “under 1 h”. */
function hours(ms: number, locale?: string | null): string {
  const h = Math.round(ms / HOUR_MS);
  return h === 0 ? clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS).underHour : `${h} h`;
}

/** One person's week in whole hours: each place in its colours' order, then On the way, then Not read. */
export function findMyWeekTotals(
  days: readonly (readonly FindMyTimelineSegment[])[],
  order: readonly string[],
  locale?: string | null,
): FindMyTotal[] {
  const w = clientTree(locale, HOSTS_FIND_MY_TIMELINE_WORDS);
  const places = new Map<string, { label: string; ms: number }>();
  let trip = 0;
  let gap = 0;
  const len = (s: Span) => Math.max(0, Date.parse(s.to) - Date.parse(s.from));
  for (const segments of days)
    for (const s of segments) {
      if (s.kind === 'stay') {
        const holes = s.holes.reduce((sum, h) => sum + len(h), 0);
        const key = findMyPlaceColourKey(s.place);
        const p = places.get(key) ?? { label: s.place, ms: 0 };
        p.ms += Math.max(0, len(s) - holes);
        places.set(key, p);
        gap += holes;
      } else if (s.kind === 'trip') trip += len(s);
      else gap += len(s);
    }
  const out: FindMyTotal[] = [...places.entries()]
    .filter(([, p]) => p.ms > 0)
    .sort(([a], [b]) => rank(order, a) - rank(order, b))
    .map(([key, p]) => ({
      key,
      label: p.label,
      tone: findMyPlaceTone(order, p.label),
      value: hours(p.ms, locale),
    }));
  if (trip > 0) out.push({ key: 'trip', label: w.onTheWay, tone: 'trip', value: hours(trip, locale) });
  if (gap > 0) out.push({ key: 'gap', label: w.notRead, tone: 'gap', value: hours(gap, locale) });
  return out;
}

/* Who is on it ---------------------------------------------------------------------------------------- */

/** Whether the connection keeps a timeline: someone is ticked. */
export function findMyTimelineOn(people: readonly Pick<FindMyTimelinePerson, 'kept'>[]): boolean {
  return people.some((p) => p.kept);
}

/** The person whose day the card shows: the one picked while they're kept, else the first kept. */
export function findMyPickedPerson(
  people: readonly Pick<FindMyTimelinePerson, 'id' | 'kept'>[],
  picked: string | null,
): string | null {
  const kept = people.filter((p) => p.kept);
  return kept.find((p) => p.id === picked)?.id ?? kept[0]?.id ?? null;
}

/** Whose days to keep after ticking or unticking one person (the box's order: as listed). */
export function findMyWhoseAfter(
  people: readonly Pick<FindMyTimelinePerson, 'id' | 'kept'>[],
  id: string,
  keep: boolean,
): string[] {
  return people.filter((p) => (p.id === id ? keep : p.kept)).map((p) => p.id);
}
