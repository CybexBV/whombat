/**
 * The Find My connection's timeline in the fixture worlds (docs/implementation/macos/findmy-timeline.md §1, shaped
 * like its mockup): Noor and Ruben Visser kept for the last 30 days, Ilse de Wit and Sem Visser not. Noor goes from
 * Home in Rietveen to School and back, Ruben to Wilgendam by train, with a night without a location now and then, a
 * read that waited while someone used studio, and Oosterhaven on Saturdays. Each day is made from a plan in local
 * minutes, cut at the day's bounds, at now and at when each person was kept or the timeline last deleted, so it answers
 * `connections.findMyTimeline*` as the box does. The names, streets and spots are invented. Not imported by production
 * code.
 */
import {
  FIND_MY_TIMELINE_DAYS,
  type FindMySpot,
  type FindMyTimeline,
  type FindMyTimelineChanged,
  type FindMyTimelineDay,
  type FindMyTimelineMap,
  FindMyTimelineMapQuery,
  type FindMyTimelinePerson,
  FindMyTimelineQuery,
  type FindMyTimelineSegment,
  FindMyTimelineSetBody,
  type FindMyTimelineWhy,
  findMyDayBounds,
  findMyTimelineDates,
  findMyTimelinePins,
} from '@whombat/core/domain';
import { dayKey } from '@whombat/core/text';
import type { HostsFixtureAnswer } from './fixtures';
import {
  FIND_MY_MAP_DARK_PNG_B64,
  FIND_MY_MAP_LIGHT_PNG_B64,
  FIND_MY_MAP_PX,
  FIND_MY_PEOPLE,
  findMyFixtureFit,
  findMyFixtureMetres,
} from './fixtures-findmy';
import { FIND_MY_CONNECTION_ID } from './fixtures-findmy-connection';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** How often the fixture connection reads for its timeline (minutes). */
export const FIND_MY_TIMELINE_FIXTURE_PACE = 15;

/** Made-up places: Find My's words, a street and a spot (the towns are invented; the spots lie over open water). */
const SPOTS = {
  home: { place: 'Home', address: 'Lindenlaan 8, Rietveen', spot: { lat: 52.86, lon: 5.06, accuracyM: 100 } },
  school: {
    place: 'School',
    address: 'Schoolpad 1, Rietveen',
    spot: { lat: 52.8668, lon: 5.0712, accuracyM: 100 },
  },
  shop: {
    place: 'Rietveen',
    address: 'Dorpsstraat 22, Rietveen',
    spot: { lat: 52.8631, lon: 5.0655, accuracyM: 100 },
  },
  station: {
    place: 'Wilgendam',
    address: 'Stationsplein 2, Wilgendam',
    spot: { lat: 52.6968, lon: 5.4066, accuracyM: 100 },
  },
  kade: {
    place: 'Wilgendam',
    address: 'Kade 14, Wilgendam',
    spot: { lat: 52.7185, lon: 5.4392, accuracyM: 100 },
  },
  haven: {
    place: 'Oosterhaven',
    address: 'Havenweg 3, Oosterhaven',
    spot: { lat: 52.64, lon: 5.33, accuracyM: 100 },
  },
} as const satisfies Record<string, { place: string; address: string; spot: FindMySpot }>;
type SpotKey = keyof typeof SPOTS;

/** A day's plan in local minutes (0…1440): where someone was, the way between, and why there was no place. */
type Plan =
  | { k: 'stay'; from: number; to: number; spot: SpotKey; holes?: [number, number, FindMyTimelineWhy][] }
  | { k: 'trip'; from: number; to: number }
  | { k: 'gap'; from: number; to: number; why: FindMyTimelineWhy };

const T = (s: string) => {
  const [h = 0, m = 0] = s.split(':').map(Number);
  return h * 60 + m;
};
const stay = (
  from: number,
  to: number,
  spot: SpotKey,
  holes?: [number, number, FindMyTimelineWhy][],
): Plan => ({
  k: 'stay',
  from,
  to,
  spot,
  ...(holes ? { holes } : {}),
});
const trip = (from: number, to: number): Plan => ({ k: 'trip', from, to });
const gap = (from: number, to: number, why: FindMyTimelineWhy): Plan => ({ k: 'gap', from, to, why });

const [NOOR, RUBEN, ILSE, SEM] = FIND_MY_PEOPLE.map((p) => p.id) as [string, string, string, string];

/** Today as the mockup draws it, carried on to midnight (the part after now is cut). */
const TODAY: Record<string, Plan[]> = {
  [NOOR]: [
    stay(0, T('08:20'), 'home', [[T('02:10'), T('06:30'), 'no_location']]),
    trip(T('08:20'), T('08:35')),
    stay(T('08:35'), T('14:30'), 'school'),
    trip(T('14:30'), T('14:45')),
    stay(T('14:45'), T('15:00'), 'shop'),
    trip(T('15:00'), T('15:10')),
    stay(T('15:10'), 1440, 'home'),
  ],
  [RUBEN]: [
    stay(0, T('07:50'), 'home'),
    trip(T('07:50'), T('08:30')),
    stay(T('08:30'), T('12:15'), 'station'),
    trip(T('12:15'), T('12:30')),
    stay(T('12:30'), T('13:05'), 'kade'),
    gap(T('13:05'), T('13:45'), 'in_use'),
    stay(T('13:45'), T('17:40'), 'station'),
    trip(T('17:40'), T('18:20')),
    stay(T('18:20'), 1440, 'home'),
  ],
};

/** A small seeded random (mulberry32), so a date's plan is the same on every read. */
function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An earlier day's plan: school days and work days in the week, Rietveen's shop and Oosterhaven at weekends. */
function earlierPlan(person: string, date: string): Plan[] {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  const dayNo = Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const r = rng(dayNo * 97 + person.charCodeAt(0) * 13);
  const q = (a: number, b: number) => Math.round((a + r() * (b - a)) / 5) * 5;
  const night = (): [number, number, FindMyTimelineWhy][] =>
    r() < 0.6 ? [[q(60, 150), q(360, 400), 'no_location']] : [];
  if (person === RUBEN) {
    if (weekday === 0)
      return [stay(0, 1440, 'home', r() < 0.6 ? [[q(780, 840), q(870, 900), 'in_use']] : [])];
    if (weekend) {
      const a = q(600, 660);
      const b = q(900, 1020);
      return [
        stay(0, a, 'home'),
        trip(a, a + 25),
        stay(a + 25, b, 'haven'),
        trip(b, b + 25),
        stay(b + 25, 1440, 'home'),
      ];
    }
    const a = q(455, 485);
    const b = q(1020, 1080);
    const h = q(600, 900);
    return [
      stay(0, a, 'home'),
      trip(a, a + 40),
      stay(a + 40, b, 'station', r() < 0.55 ? [[h, h + q(20, 45), 'in_use']] : []),
      trip(b, b + 40),
      stay(b + 40, 1440, 'home'),
    ];
  }
  if (person === NOOR) {
    if (weekend) {
      const a = q(600, 700);
      return [
        stay(0, a, 'home', night()),
        trip(a, a + 10),
        stay(a + 10, a + 70, 'shop'),
        trip(a + 70, a + 80),
        stay(a + 80, 1440, 'home'),
      ];
    }
    const a = q(490, 505);
    const b = q(870, 930);
    return [
      stay(0, a, 'home', night()),
      trip(a, a + 15),
      stay(a + 15, b, 'school'),
      trip(b, b + 15),
      stay(b + 15, 1440, 'home'),
    ];
  }
  if (person === ILSE) return [stay(0, 1440, 'haven')];
  return [gap(0, 1440, 'no_location')];
}

export interface FindMyTimelineFixture {
  /** `GET …/find-my/timeline`. */
  timeline(query: Record<string, string>): HostsFixtureAnswer;
  /** `PUT …/find-my/timeline`. */
  set(body: unknown): HostsFixtureAnswer;
  /** `POST …/find-my/timeline/delete`. */
  remove(body: unknown): HostsFixtureAnswer;
  /** `GET …/find-my/timeline/map`. */
  map(query: Record<string, string>): HostsFixtureAnswer;
}

const bad = (message: string): HostsFixtureAnswer => ({
  status: 400,
  body: { error: { code: 'bad_request', message, details: { code: 'invalid_value' } } },
});

export function createFindMyTimelineFixture({
  clock,
  assistantReads = () => true,
  kept = [NOOR, RUBEN],
}: {
  clock: () => number;
  /** Whether the `findmy_timeline` tool is Allowed on the connection (the catalog world's tier). */
  assistantReads?: () => boolean;
  /** Who is kept from the start, for the last 30 days (none: before it's on). */
  kept?: readonly string[];
}): FindMyTimelineFixture {
  const start = clock();
  const st = {
    kept: new Map<string, number>(kept.map((id) => [id, start - FIND_MY_TIMELINE_DAYS * DAY_MS])),
    /** Every day before this was deleted. */
    deletedAt: Number.NEGATIVE_INFINITY,
    events: 0,
  };

  const people = (): FindMyTimelinePerson[] =>
    FIND_MY_PEOPLE.map((p) => {
      const since = st.kept.get(p.id);
      return {
        id: p.id,
        name: p.name,
        kept: since !== undefined,
        keptSince: since === undefined ? null : new Date(since).toISOString(),
        now: { place: p.place, when: p.when, nearby: p.nearby },
      };
    });

  /** The fixture's last read: on its pace, a couple of minutes ago. */
  const readAt = (now: number) => {
    const pace = FIND_MY_TIMELINE_FIXTURE_PACE * MINUTE_MS;
    let at = Math.floor(now / pace) * pace + 2 * MINUTE_MS;
    if (at > now) at -= pace;
    return at;
  };

  /** One person's segments of one day in `tz`, from their plan, cut at the day, now, and since kept. */
  const segmentsOf = (person: string, date: string, tz: string, now: number): FindMyTimelineSegment[] => {
    const since = st.kept.get(person);
    if (since === undefined) return [];
    const bounds = findMyDayBounds(date, tz);
    const dayFrom = Date.parse(bounds.from);
    const dayTo = Date.parse(bounds.to);
    const lo = Math.max(dayFrom, since, st.deletedAt, now - (FIND_MY_TIMELINE_DAYS + 1) * DAY_MS);
    const hi = Math.min(dayTo, now);
    if (hi <= lo) return [];
    const today = dayKey(now, tz) === date;
    const plan = today ? (TODAY[person] ?? earlierPlan(person, date)) : earlierPlan(person, date);
    const at = (m: number) => Math.min(dayTo, dayFrom + m * MINUTE_MS);
    const iso = (t: number) => new Date(t).toISOString();
    const out: FindMyTimelineSegment[] = [];
    for (const item of plan) {
      const a = Math.max(at(item.from), lo);
      const b = Math.min(at(item.to), hi);
      if (b <= a) continue;
      if (item.k === 'stay') {
        const s = SPOTS[item.spot];
        const holes = (item.holes ?? [])
          .map(([hf, ht, why]) => ({ from: Math.max(at(hf), a), to: Math.min(at(ht), b), why }))
          .filter((h) => h.to > h.from)
          .map((h) => ({ from: iso(h.from), to: iso(h.to), why: h.why }));
        out.push({
          kind: 'stay',
          from: iso(a),
          to: iso(b),
          place: s.place,
          address: s.address,
          spot: { ...s.spot },
          ongoing: today && b === now,
          holes,
        });
      } else if (item.k === 'trip') out.push({ kind: 'trip', from: iso(a), to: iso(b) });
      else out.push({ kind: 'gap', from: iso(a), to: iso(b), why: item.why });
    }
    return out;
  };

  const changed = (event: boolean): FindMyTimelineChanged => ({
    ok: true,
    eventId: event ? (`evt_findmy_timeline_${++st.events}` as FindMyTimelineChanged['eventId']) : null,
    people: people(),
  });
  const ok = (body: unknown): HostsFixtureAnswer => ({ status: 200, body });

  return {
    timeline(query) {
      const parsed = FindMyTimelineQuery.safeParse(query);
      if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'That isn’t a day.');
      const { date, tz, days } = parsed.data;
      const now = clock();
      const answer: FindMyTimeline = {
        connectionId: FIND_MY_CONNECTION_ID as FindMyTimeline['connectionId'],
        days: findMyTimelineDates(date, days).map((d): FindMyTimelineDay => {
          const bounds = findMyDayBounds(d, tz);
          return {
            date: d,
            from: bounds.from,
            to: bounds.to,
            people: [...st.kept.keys()].map((person) => ({
              person,
              segments: segmentsOf(person, d, tz, now),
            })),
          };
        }),
        people: people(),
        paceMinutes: FIND_MY_TIMELINE_FIXTURE_PACE,
        readAt: new Date(readAt(now)).toISOString(),
        assistantReads: assistantReads(),
      };
      return ok(answer);
    },
    set(body) {
      const parsed = FindMyTimelineSetBody.safeParse(body);
      if (!parsed.success) return bad('Say whose days to keep.');
      const known = new Set(FIND_MY_PEOPLE.map((p) => p.id));
      if (parsed.data.people.some((id) => !known.has(id))) return bad('That person isn’t on Find My.');
      const now = clock();
      const want = new Set(parsed.data.people);
      const before = [...st.kept.keys()].sort().join(',');
      for (const id of [...st.kept.keys()]) if (!want.has(id)) st.kept.delete(id);
      for (const id of want) if (!st.kept.has(id)) st.kept.set(id, now);
      // Nobody: the timeline stops and everything goes.
      if (want.size === 0) st.deletedAt = now;
      return ok(changed(before !== [...st.kept.keys()].sort().join(',')));
    },
    remove(body) {
      if (body && typeof body === 'object' && Object.keys(body).length) return bad('Nothing to say here.');
      st.deletedAt = clock();
      return ok(changed(true));
    },
    map(query) {
      const parsed = FindMyTimelineMapQuery.safeParse(query);
      if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'That isn’t a map.');
      const q = parsed.data;
      const pins = findMyTimelinePins(segmentsOf(q.person, q.date, q.tz, clock()));
      if (!pins.length)
        return {
          status: 409,
          body: {
            error: {
              code: 'conflict',
              message: 'Whombat has no spot for them on that day.',
              details: { code: 'find_my_no_places' },
            },
          },
        };
      // Fitted with more room than the people's map: the person's avatar stands above a stop.
      const fit = findMyFixtureFit(
        pins.map((p) => p.spot),
        q.w,
        q.h,
      );
      const region = { ...fit, spanM: fit.spanM * 1.5 };
      const perPoint = region.spanM / Math.min(q.w, q.h);
      const points: FindMyTimelineMap['points'] = pins.map((p) => {
        const m = findMyFixtureMetres(p.spot, region);
        return { stops: p.stops, x: q.w / 2 + m.x / perPoint, y: q.h / 2 - m.y / perPoint };
      });
      const map: FindMyTimelineMap = {
        connectionId: FIND_MY_CONNECTION_ID as FindMyTimelineMap['connectionId'],
        person: q.person,
        date: q.date,
        imageB64: q.dark ? FIND_MY_MAP_DARK_PNG_B64 : FIND_MY_MAP_LIGHT_PNG_B64,
        format: 'png',
        w: FIND_MY_MAP_PX.w,
        h: FIND_MY_MAP_PX.h,
        points,
        lat: region.lat,
        lon: region.lon,
        spanM: Math.round(region.spanM),
      };
      return ok(map);
    },
  };
}

/** The ids of the fixture's people, for tests: Noor and Ruben kept, Ilse and Sem not. */
export const FIND_MY_TIMELINE_FIXTURE_PEOPLE = { noor: NOOR, ruben: RUBEN, ilse: ILSE, sem: SEM } as const;
