/**
 * A Find My timeline (docs/implementation/macos/findmy-timeline.md): the rows the box keeps, a day of segments built
 * from them, the day's bounds in a time zone, the map's pins, and what the apps and the assistant send and get.
 */
import { describe, expect, it } from 'vitest';
import {
  FIND_MY_TIMELINE_DAYS,
  FIND_MY_TIMELINE_PINS_MAX,
  FindMyStop,
  FindMyTimeline,
  FindMyTimelineArgs,
  FindMyTimelineMap,
  FindMyTimelineMapQuery,
  FindMyTimelineQuery,
  type FindMyTimelineRow,
  FindMyTimelineSegment,
  FindMyTimelineSetBody,
  findMyDateAdd,
  findMyDayBounds,
  findMyStopKey,
  findMyTimelineDates,
  findMyTimelineDay,
  findMyTimelinePins,
  findMyTimelineTolerance,
} from './findmy-timeline.js';

const MIN = 60_000;
const PACE = 5 * MIN;
const TOL = findMyTimelineTolerance(PACE);

/** A day in UTC, so times read as written: 23 November 2026. */
const DAY = { from: '2026-11-23T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z' };
const at = (hhmm: string, date = '2026-11-23') => `${date}T${hhmm}:00.000Z`;
const LATE = at('12:00', '2026-11-25');

const home = { lat: 52.1, lon: 5.1, accuracyM: 100 };
const school = { lat: 52.2, lon: 5.2, accuracyM: 100 };

const place = (
  first: string,
  last: string,
  words: string,
  address: string | null = `${words}straat 1, Rietveen`,
  spot: typeof home | null = words === 'Home' ? home : school,
): FindMyTimelineRow => ({ kind: 'place', place: words, address, spot, firstAt: first, lastAt: last });
const none = (first: string, last: string): FindMyTimelineRow => ({
  kind: 'none',
  firstAt: first,
  lastAt: last,
});
const unread = (first: string, last: string, code: 'in_use' | 'timeout' = 'in_use'): FindMyTimelineRow => ({
  kind: 'unread',
  code,
  firstAt: first,
  lastAt: last,
});

const day = (rows: FindMyTimelineRow[], now = LATE, bounds = DAY) =>
  findMyTimelineDay(rows, { ...bounds, now, toleranceMs: TOL });

/** Segments as `kind from–to (place|why)`, holes after a stay as `[from–to why]`. */
function brief(segments: ReturnType<typeof findMyTimelineDay>): string[] {
  const t = (s: string) => s.slice(11, 16);
  // A segment that ends at midnight ends at 24:00 of its day.
  const span = (x: { from: string; to: string }) =>
    `${t(x.from)}–${x.to.endsWith('T00:00:00.000Z') ? '24:00' : t(x.to)}`;
  return segments.map((s) => {
    if (s.kind === 'stay')
      return [
        `stay ${span(s)} ${s.place}`,
        ...(s.ongoing ? ['ongoing'] : []),
        ...s.holes.map((h) => `[${span(h)} ${h.why}]`),
      ].join(' ');
    if (s.kind === 'trip') return `trip ${span(s)}`;
    return `gap ${span(s)} ${s.why}`;
  });
}

describe('the tolerance', () => {
  it('is twice the pace and five minutes', () => {
    expect(findMyTimelineTolerance(5 * MIN)).toBe(15 * MIN);
    expect(findMyTimelineTolerance(15 * MIN)).toBe(35 * MIN);
    expect(FIND_MY_TIMELINE_DAYS).toBe(30);
  });
});

describe('the rows the box keeps', () => {
  it('are a place with its words, street and spot, no location, or a read that didn’t work', () => {
    const times = { firstAt: at('08:00'), lastAt: at('09:00') };
    expect(
      FindMyStop.safeParse({ kind: 'place', place: 'Home', address: null, spot: null, ...times }).success,
    ).toBe(true);
    expect(FindMyStop.safeParse({ kind: 'none', ...times }).success).toBe(true);
    expect(FindMyStop.safeParse({ kind: 'unread', code: 'in_use', ...times }).success).toBe(true);
    expect(FindMyStop.safeParse({ kind: 'unread', code: 'nope', ...times }).success).toBe(false);
    expect(
      FindMyStop.safeParse({ kind: 'place', place: '', address: null, spot: null, ...times }).success,
    ).toBe(false);
  });

  it('are the same by street, else by place words, without case or spaces', () => {
    const key = (place: string, address: string | null) => findMyStopKey({ kind: 'place', place, address });
    expect(key('Wilgendam', 'Kade 14, Wilgendam')).not.toBe(key('Wilgendam', 'Stationsplein 2, Wilgendam'));
    expect(key('Home', 'Lindenlaan 8')).toBe(key('Thuis', 'lindenlaan  8'));
    expect(key('Home', null)).toBe(key(' home', null));
    expect(key('Home', null)).not.toBe(findMyStopKey({ kind: 'none' }));
    expect(findMyStopKey({ kind: 'unread' })).toBe('unread');
  });
});

describe('a day of segments', () => {
  it('has nothing before the first row and nothing for a day still to come', () => {
    expect(day([])).toEqual([]);
    expect(brief(day([place(at('10:00'), at('12:00'), 'Home')])).length).toBe(2);
    expect(day([place(at('10:00'), at('12:00'), 'Home')], at('23:00', '2026-11-22'))).toEqual([]);
  });

  it('goes on the way between two places read within the tolerance', () => {
    const rows = [
      place(at('07:00'), at('08:20'), 'Home'),
      place(at('08:35'), at('14:30'), 'School'),
      place(at('14:45'), at('15:00'), 'Rietveen'),
    ];
    expect(brief(day(rows, at('15:05')))).toEqual([
      'stay 07:00–08:20 Home',
      'trip 08:20–08:35',
      'stay 08:35–14:30 School',
      'trip 14:30–14:45',
      'stay 14:45–15:05 Rietveen ongoing',
    ]);
  });

  it('says not read between two places read further apart than the tolerance, and never joins different places', () => {
    const rows = [place(at('07:00'), at('08:00'), 'Home'), place(at('09:00'), at('10:00'), 'School')];
    expect(brief(day(rows))).toEqual([
      'stay 07:00–08:00 Home',
      'gap 08:00–09:00 not_read',
      'stay 09:00–10:00 School',
      'gap 10:00–24:00 not_read',
    ]);
  });

  it('gives the time next to a row without a place to that row', () => {
    const rows = [
      place(at('07:00'), at('08:20'), 'Home'),
      none(at('08:25'), at('08:30')),
      unread(at('08:35'), at('08:40'), 'timeout'),
      place(at('08:45'), at('09:00'), 'School'),
    ];
    expect(brief(day(rows, at('09:00')))).toEqual([
      'stay 07:00–08:20 Home',
      'gap 08:20–08:35 no_location',
      'gap 08:35–08:45 timeout',
      'stay 08:45–09:00 School ongoing',
    ]);
  });

  it('joins one place across no location, a read that didn’t work and a long pause, as holes', () => {
    const rows = [
      place(at('00:00'), at('02:10'), 'Home'),
      none(at('02:15'), at('06:25')),
      place(at('06:30'), at('07:00'), 'Home'),
      unread(at('07:05'), at('07:30')),
      place(at('07:35'), at('08:00'), 'Home'),
      place(at('10:00'), at('11:00'), 'Home'),
      place(at('11:10'), at('12:00'), 'School'),
    ];
    expect(brief(day(rows, at('12:05')))).toEqual([
      'stay 00:00–11:00 Home [02:10–06:30 no_location] [07:00–07:35 in_use] [08:00–10:00 not_read]',
      'trip 11:00–11:10',
      'stay 11:10–12:05 School ongoing',
    ]);
  });

  it('keeps the last read’s words, street and spot on a joined stay', () => {
    const rows = [
      place(at('06:00'), at('07:00'), 'Home', 'Lindenlaan 8', null),
      none(at('07:05'), at('08:00')),
      place(at('08:05'), at('09:00'), 'Thuis', 'lindenlaan 8', home),
    ];
    const [stay] = day(rows, at('09:05'));
    expect(stay).toMatchObject({ kind: 'stay', place: 'Thuis', address: 'lindenlaan 8', spot: home });
  });

  it('does not join the same place across a trip', () => {
    const rows = [
      place(at('07:00'), at('08:00'), 'Home'),
      place(at('08:05'), at('08:30'), 'School'),
      place(at('08:35'), at('09:00'), 'Home'),
    ];
    expect(brief(day(rows, at('09:05'))).filter((s) => s.startsWith('stay'))).toEqual([
      'stay 07:00–08:00 Home',
      'stay 08:05–08:30 School',
      'stay 08:35–09:05 Home ongoing',
    ]);
  });

  it('keeps a stop of one read as a stay without length', () => {
    const rows = [
      place(at('07:00'), at('08:00'), 'Home'),
      place(at('08:05'), at('08:05'), 'Rietveen'),
      place(at('08:10'), at('09:00'), 'School'),
    ];
    expect(brief(day(rows))).toEqual([
      'stay 07:00–08:00 Home',
      'trip 08:00–08:05',
      'stay 08:05–08:05 Rietveen',
      'trip 08:05–08:10',
      'stay 08:10–09:00 School',
      'gap 09:00–24:00 not_read',
    ]);
  });

  it('cuts at midnight on both sides', () => {
    const rows = [
      place(at('18:00', '2026-11-22'), at('07:50'), 'Home'),
      place(at('08:00'), at('23:50'), 'School'),
      place(at('23:55'), at('09:00', '2026-11-24'), 'Home'),
    ];
    expect(brief(day(rows))).toEqual([
      'stay 00:00–07:50 Home',
      'trip 07:50–08:00',
      'stay 08:00–23:50 School',
      'trip 23:50–23:55',
      'stay 23:55–24:00 Home',
    ]);
    // A stay that ends right at midnight isn't a stop of the next day.
    const next = { from: DAY.to, to: '2026-11-25T00:00:00.000Z' };
    const ending = [place(at('18:00'), at('00:00', '2026-11-24'), 'Home')];
    expect(brief(day(ending, LATE, next))).toEqual(['gap 00:00–24:00 not_read']);
  });

  it('cuts holes and the pause across midnight too', () => {
    const rows = [
      place(at('20:00', '2026-11-22'), at('22:00', '2026-11-22'), 'Home'),
      place(at('03:00'), at('07:00'), 'Home'),
      place(at('09:00'), at('10:00'), 'School'),
    ];
    expect(brief(day(rows, at('10:05')))).toEqual([
      'stay 00:00–07:00 Home [00:00–03:00 not_read]',
      'gap 07:00–09:00 not_read',
      'stay 09:00–10:05 School ongoing',
    ]);
  });

  it('runs today’s last stay to now while its last read is within the tolerance', () => {
    const rows = [place(at('13:45'), at('15:18'), 'Wilgendam')];
    const [stay] = day(rows, at('15:20'));
    expect(stay).toMatchObject({ kind: 'stay', to: at('15:20'), ongoing: true });
    // Read longer ago: it ends at its last read, and the time since wasn’t read.
    expect(brief(day(rows, at('15:40')))).toEqual(['stay 13:45–15:18 Wilgendam', 'gap 15:18–15:40 not_read']);
    // Yesterday's view of a stay still going runs to midnight, not ongoing there.
    const going = [place(at('20:00'), at('00:10', '2026-11-24'), 'Home')];
    const yesterday = day(going, at('00:12', '2026-11-24'));
    expect(yesterday).toMatchObject([{ kind: 'stay', to: DAY.to, ongoing: false }]);
  });

  it('is never ongoing after no location or a read that didn’t work', () => {
    const rows = [place(at('13:00'), at('15:10'), 'Home'), none(at('15:15'), at('15:15'))];
    expect(brief(day(rows, at('15:20')))).toEqual(['stay 13:00–15:10 Home', 'gap 15:10–15:15 no_location']);
  });

  it('carries ongoing over to a stay joined across a hole', () => {
    const rows = [
      place(at('13:00'), at('15:00'), 'Home'),
      unread(at('15:05'), at('15:10')),
      place(at('15:15'), at('15:18'), 'Home'),
    ];
    expect(brief(day(rows, at('15:20')))).toEqual(['stay 13:00–15:20 Home ongoing [15:00–15:15 in_use]']);
  });

  it('answers segments the contract takes', () => {
    const rows = [
      place(at('00:00'), at('02:10'), 'Home'),
      none(at('02:15'), at('06:25')),
      place(at('06:30'), at('08:20'), 'Home'),
      place(at('08:35'), at('09:00'), 'School'),
      unread(at('10:00'), at('10:30')),
    ];
    for (const s of day(rows)) expect(FindMyTimelineSegment.parse(s)).toEqual(s);
  });
});

describe('a day’s bounds', () => {
  const hours = (b: { from: string; to: string }) => (Date.parse(b.to) - Date.parse(b.from)) / 3_600_000;

  it('runs from local midnight to the next', () => {
    expect(findMyDayBounds('2026-11-23', 'Europe/Amsterdam')).toEqual({
      from: '2026-11-22T23:00:00.000Z',
      to: '2026-11-23T23:00:00.000Z',
    });
    expect(findMyDayBounds('2026-07-01', 'Europe/Amsterdam').from).toBe('2026-06-30T22:00:00.000Z');
    expect(findMyDayBounds('2026-11-23', 'UTC')).toEqual(DAY);
    expect(findMyDayBounds('2026-11-23', 'Asia/Kolkata').from).toBe('2026-11-22T18:30:00.000Z');
    expect(findMyDayBounds('2026-11-23', 'America/Los_Angeles').from).toBe('2026-11-23T08:00:00.000Z');
  });

  it('is 23 hours when the clock goes forward and 25 when it goes back (Europe/Amsterdam)', () => {
    const spring = findMyDayBounds('2026-03-29', 'Europe/Amsterdam');
    expect(spring).toEqual({ from: '2026-03-28T23:00:00.000Z', to: '2026-03-29T22:00:00.000Z' });
    expect(hours(spring)).toBe(23);
    const autumn = findMyDayBounds('2026-10-25', 'Europe/Amsterdam');
    expect(autumn).toEqual({ from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z' });
    expect(hours(autumn)).toBe(25);
    expect(hours(findMyDayBounds('2026-10-26', 'Europe/Amsterdam'))).toBe(24);
  });

  it('starts at the jump when the clock skips midnight, and at the first when it repeats it (America/Havana)', () => {
    // Cuba goes forward at midnight: 8 March 2026 starts at 01:00 local.
    const spring = findMyDayBounds('2026-03-08', 'America/Havana');
    expect(spring.from).toBe('2026-03-08T05:00:00.000Z');
    expect(hours(spring)).toBe(23);
    // And back at 01:00 to midnight: 1 November 2026 has midnight twice and 25 hours from the first.
    const autumn = findMyDayBounds('2026-11-01', 'America/Havana');
    expect(autumn.from).toBe('2026-11-01T04:00:00.000Z');
    expect(hours(autumn)).toBe(25);
  });

  it('cuts a day across the clock change in the zone’s own hours', () => {
    const bounds = findMyDayBounds('2026-10-25', 'Europe/Amsterdam');
    const rows = [place('2026-10-24T20:00:00.000Z', '2026-10-25T23:30:00.000Z', 'Home')];
    expect(day(rows, LATE, bounds)).toMatchObject([{ kind: 'stay', from: bounds.from, to: bounds.to }]);
  });

  it('refuses a date or a zone it doesn’t know', () => {
    expect(() => findMyDayBounds('2026-02-30', 'UTC')).toThrow(RangeError);
    expect(() => findMyDayBounds('23-11-2026', 'UTC')).toThrow(RangeError);
    expect(() => findMyDayBounds('2026-11-23', 'Mars/Olympus')).toThrow(RangeError);
  });

  it('counts dates back and forward', () => {
    expect(findMyDateAdd('2026-03-01', -1)).toBe('2026-02-28');
    expect(findMyDateAdd('2026-12-31', 1)).toBe('2027-01-01');
    expect(findMyTimelineDates('2026-11-23', 3)).toEqual(['2026-11-21', '2026-11-22', '2026-11-23']);
    expect(findMyTimelineDates('2026-11-23', 1)).toEqual(['2026-11-23']);
  });
});

describe('the map’s pins', () => {
  const stay = (words: string, spot: typeof home | null, address = `${words} 1`) => ({
    kind: 'stay' as const,
    from: at('08:00'),
    to: at('09:00'),
    place: words,
    address,
    spot,
    ongoing: false,
    holes: [],
  });
  const trip = { kind: 'trip' as const, from: at('09:00'), to: at('09:10') };

  it('numbers the stops in order and puts a spot visited twice on one pin', () => {
    const pins = findMyTimelinePins([
      stay('Home', home),
      trip,
      stay('School', school),
      trip,
      stay('Rietveen', null),
      trip,
      stay('Home', home),
    ]);
    expect(pins).toEqual([
      { spot: home, stops: [1, 4] },
      { spot: school, stops: [2] },
    ]);
  });

  it('keeps the first twenty spots', () => {
    const many = Array.from({ length: 25 }, (_, i) => stay(`Place ${i}`, { lat: i, lon: i, accuracyM: 50 }));
    const pins = findMyTimelinePins(many);
    expect(pins).toHaveLength(FIND_MY_TIMELINE_PINS_MAX);
    expect(pins.at(-1)?.stops).toEqual([20]);
  });
});

describe('what the apps and the assistant send and get', () => {
  it('asks for one to seven days ending on a date, in a time zone', () => {
    expect(FindMyTimelineQuery.parse({ date: '2026-11-23', tz: 'Europe/Amsterdam' })).toEqual({
      date: '2026-11-23',
      tz: 'Europe/Amsterdam',
      days: 1,
    });
    expect(FindMyTimelineQuery.parse({ date: '2026-11-23', tz: 'UTC', days: '7' }).days).toBe(7);
    for (const bad of [
      { date: '2026-11-23', tz: 'UTC', days: 8 },
      { date: '2026-11-23', tz: 'UTC', days: 0 },
      { date: '2026-11-23', tz: 'Mars/Olympus' },
      { date: '23 November', tz: 'UTC' },
    ])
      expect(FindMyTimelineQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('answers the days, everyone, the pace, the last read and whether the assistant reads it', () => {
    const answer = {
      connectionId: 'con_findmy01',
      days: [
        {
          date: '2026-11-23',
          ...DAY,
          people: [{ person: '0123456789ab', segments: day([place(at('08:00'), at('09:00'), 'Home')]) }],
        },
      ],
      people: [
        {
          id: '0123456789ab',
          name: 'Noor Visser',
          kept: true,
          keptSince: at('07:00'),
          now: { place: 'Home', when: '5 min ago', nearby: false },
        },
        { id: 'abcdef012345', name: 'Ilse de Wit', kept: false, keptSince: null, now: null },
      ],
      paceMinutes: 5,
      readAt: at('15:18'),
      assistantReads: true,
    };
    expect(FindMyTimeline.parse(answer)).toEqual(answer);
    expect(FindMyTimeline.safeParse({ ...answer, days: [] }).success).toBe(false);
  });

  it('keeps whom it is given, each once', () => {
    expect(FindMyTimelineSetBody.parse({ people: [] })).toEqual({ people: [] });
    expect(FindMyTimelineSetBody.safeParse({ people: ['0123456789ab', 'abcdef012345'] }).success).toBe(true);
    expect(FindMyTimelineSetBody.safeParse({ people: ['0123456789ab', '0123456789ab'] }).success).toBe(false);
    expect(FindMyTimelineSetBody.safeParse({ people: ['Noor'] }).success).toBe(false);
  });

  it('asks the map for one person’s day and gets each pin with its stops', () => {
    const q = FindMyTimelineMapQuery.parse({
      person: '0123456789ab',
      date: '2026-11-23',
      tz: 'Europe/Amsterdam',
      w: '400',
      h: '300',
      dark: 'true',
    });
    expect(q).toEqual({
      person: '0123456789ab',
      date: '2026-11-23',
      tz: 'Europe/Amsterdam',
      w: 400,
      h: 300,
      dark: true,
    });
    const map = {
      connectionId: 'con_findmy01',
      person: '0123456789ab',
      date: '2026-11-23',
      imageB64: 'iVBORw0KGgo=',
      format: 'png',
      w: 800,
      h: 600,
      points: [{ stops: [2, 4], x: 120, y: 80 }],
      lat: 52.1,
      lon: 5.1,
      spanM: 4000,
    };
    expect(FindMyTimelineMap.parse(map)).toEqual(map);
    expect(FindMyTimelineMap.safeParse({ ...map, points: [{ stops: [], x: 1, y: 1 }] }).success).toBe(false);
  });

  it('gives the assistant a person and a date, nothing else', () => {
    expect(FindMyTimelineArgs.parse({})).toEqual({});
    expect(FindMyTimelineArgs.parse({ person: ' Ruben ', date: '2026-11-22' })).toEqual({
      person: 'Ruben',
      date: '2026-11-22',
    });
    expect(FindMyTimelineArgs.safeParse({ date: 'yesterday' }).success).toBe(false);
    expect(FindMyTimelineArgs.safeParse({ person: 'Ruben', lat: 52 }).success).toBe(false);
  });
});
