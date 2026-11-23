/**
 * The timeline's words and numbers: a day's name, durations and the week's whole hours, a colour per place that keeps
 * Home first and stays from day to day, where the axis's ticks and now sit (a clock change moves them), the list's
 * rows and the person's line, and the map's markers and lines.
 */
import type { FindMyTimelineDay, FindMyTimelineSegment } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  findMyAxis,
  findMyDayMeta,
  findMyDayTitle,
  findMyDistance,
  findMyDuration,
  findMyEveryoneMeta,
  findMyKeptSince,
  findMyLegend,
  findMyListRows,
  findMyMinutes,
  findMyNowMark,
  findMyPickedPerson,
  findMyPlaceOrder,
  findMyPlaceTone,
  findMyStrip,
  findMyTimelineLines,
  findMyTimelineMarks,
  findMyTimelinePace,
  findMyWeekDay,
  findMyWeekRange,
  findMyWeekTotals,
  findMyWhoseAfter,
} from './findmy-timeline';

const TZ = 'Europe/Amsterdam';
/** Monday 23 November 2026 in Amsterdam: 00:00 local is 23:00 UTC the day before. */
const DAY = { from: '2026-11-22T23:00:00.000Z', to: '2026-11-23T23:00:00.000Z' };
const at = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return new Date(Date.parse(DAY.from) + (h * 60 + m) * 60_000).toISOString();
};
const HOME = { lat: 52.86, lon: 5.06, accuracyM: 100 };
const STATION = { lat: 52.6968, lon: 5.4066, accuracyM: 100 };
const KADE = { lat: 52.7185, lon: 5.4392, accuracyM: 100 };

const stay = (
  from: string,
  to: string,
  place: string,
  address: string | null,
  spot: typeof HOME | null,
  more: Partial<Extract<FindMyTimelineSegment, { kind: 'stay' }>> = {},
): FindMyTimelineSegment => ({
  kind: 'stay',
  from: at(from),
  to: at(to),
  place,
  address,
  spot,
  ongoing: false,
  holes: [],
  ...more,
});

/** Ruben's Monday as the mockup has it, now at 15:20. */
const RUBEN: FindMyTimelineSegment[] = [
  stay('00:00', '07:50', 'Home', 'Lindenlaan 8, Rietveen', HOME),
  { kind: 'trip', from: at('07:50'), to: at('08:30') },
  stay('08:30', '12:15', 'Wilgendam', 'Stationsplein 2, Wilgendam', STATION),
  { kind: 'trip', from: at('12:15'), to: at('12:30') },
  stay('12:30', '13:05', 'Wilgendam', 'Kade 14, Wilgendam', KADE),
  { kind: 'gap', from: at('13:05'), to: at('13:45'), why: 'in_use' },
  stay('13:45', '15:20', 'Wilgendam', 'Stationsplein 2, Wilgendam', STATION, { ongoing: true }),
];

const dayOf = (people: { person: string; segments: FindMyTimelineSegment[] }[]): FindMyTimelineDay => ({
  date: '2026-11-23',
  ...DAY,
  people,
});

describe('a day’s words', () => {
  it('names today, yesterday and an earlier day', () => {
    expect(findMyDayTitle('2026-11-23', '2026-11-23')).toEqual({
      title: 'Today',
      date: 'Monday 23 November',
    });
    expect(findMyDayTitle('2026-11-22', '2026-11-23')).toEqual({
      title: 'Yesterday',
      date: 'Sunday 22 November',
    });
    expect(findMyDayTitle('2026-11-21', '2026-11-23')).toEqual({ title: 'Saturday', date: '21 November' });
    expect(findMyDayTitle('2026-12-30', '2027-01-02').date).toBe('30 December 2026');
    expect(findMyWeekDay('2026-11-17')).toBe('Tue 17');
    expect(findMyWeekRange('2026-11-17', '2026-11-23')).toBe('17 – 23 November');
    expect(findMyWeekRange('2026-10-28', '2026-11-03')).toBe('28 October – 3 November');
    expect(findMyKeptSince('2026-11-23T08:00:00Z', TZ)).toBe('kept since 23 Nov');
  });

  it('says durations in hours and minutes, and the week in whole hours', () => {
    expect(findMyDuration(470 * 60_000)).toBe('7 h 50 min');
    expect(findMyDuration(40 * 60_000)).toBe('40 min');
    expect(findMyDuration(120 * 60_000)).toBe('2 h');
    expect(findMyMinutes(5)).toBe('5 minutes');
    expect(findMyMinutes(60)).toBe('an hour');
    // A timeline reads at least every 15 minutes.
    expect(findMyTimelinePace(5)).toBe(5);
    expect(findMyTimelinePace(60)).toBe(15);
    expect(findMyTimelinePace(null)).toBe(15);
    expect(findMyDistance(0.04)).toBe('100 m');
    expect(findMyDistance(3.72)).toBe('3.7 km');
    expect(findMyDistance(30.6)).toBe('31 km');
  });

  it('says how often it reads and when it last did, today only', () => {
    const t = { paceMinutes: 5, readAt: at('15:18') };
    expect(findMyEveryoneMeta(t, true, TZ)).toBe('Reads every 5 minutes · last read 15:18');
    expect(findMyEveryoneMeta(t, false, TZ)).toBe('Read every 5 minutes');
    expect(findMyEveryoneMeta({ paceMinutes: null, readAt: at('15:18') }, true, TZ)).toBe('Last read 15:18');
  });
});

describe('a colour per place', () => {
  it('gives Home the first, the others in the order first reached, and keeps them from day to day', () => {
    const noor = [
      stay('00:00', '08:20', 'Home', null, HOME),
      stay('08:35', '14:30', 'School', null, null),
      stay('14:45', '15:00', 'Rietveen', null, null),
    ];
    const order = findMyPlaceOrder(
      [],
      [
        dayOf([
          { person: 'n', segments: noor },
          { person: 'r', segments: RUBEN },
        ]),
      ],
    );
    // Wilgendam (08:30) was reached before School (08:35); both of its streets are one place.
    expect(order).toEqual(['home', 'wilgendam', 'school', 'rietveen']);
    expect(['Home', 'Wilgendam', 'School', 'Rietveen'].map((p) => findMyPlaceTone(order, p))).toEqual([
      0, 1, 2, 3,
    ]);
    // Another day without Home or Wilgendam: the places known keep their colours, a new one takes the next.
    const later = findMyPlaceOrder(order, [
      dayOf([{ person: 'r', segments: [stay('10:00', '16:00', 'Oosterhaven', null, null)] }]),
    ]);
    expect(later).toEqual([...order, 'oosterhaven']);
    expect(findMyPlaceTone(later, 'Oosterhaven')).toBe(4);
    // Past the fifth, the colours after Home come round again; Home's stays its own.
    expect(findMyPlaceTone([...later, 'kade'], 'Kade')).toBe(1);
    expect(findMyPlaceTone([], 'Home')).toBe(0);
    expect(findMyLegend(order, [RUBEN]).map((l) => [l.label, l.tone])).toEqual([
      ['Home', 0],
      ['Wilgendam', 1],
    ]);
  });
});

describe('the strips and their axis', () => {
  it('places each part on the day and titles it', () => {
    const order = ['home', 'wilgendam'];
    const parts = findMyStrip(RUBEN, DAY, order, TZ);
    expect(parts[0]).toMatchObject({ kind: 'stay', at: 0, tone: 0, title: 'Home · 00:00–07:50' });
    expect(parts[0]?.width).toBeCloseTo(470 / 1440);
    expect(parts[1]).toMatchObject({ kind: 'trip', title: 'On the way · 07:50–08:30' });
    expect(parts[5]).toMatchObject({ kind: 'gap', title: 'Not read · 13:05–13:45' });
    const holes = findMyStrip(
      [
        stay('00:00', '24:00', 'Home', null, HOME, {
          holes: [{ from: at('02:10'), to: at('06:30'), why: 'no_location' }],
        }),
      ],
      DAY,
      order,
      TZ,
    );
    expect(holes.map((p) => p.title)).toEqual(['Home · 00:00–24:00', 'No location · 02:10–06:30']);
  });

  it('puts the ticks and now where the clock shows them', () => {
    const axis = findMyAxis(DAY, TZ, Date.parse(at('15:20')));
    expect(axis.ticks.map((t) => [t.label, t.at])).toEqual([
      ['00:00', 0],
      ['06:00', 0.25],
      ['12:00', 0.5],
      ['18:00', 0.75],
      ['24:00', 1],
    ]);
    expect(axis.now?.label).toBe('15:20');
    expect(axis.now?.at).toBeCloseTo(920 / 1440);
    // 18:00 is near now and gives way to it on a narrow screen.
    expect(axis.ticks.filter((t) => t.near).map((t) => t.label)).toEqual(['18:00']);
    expect(findMyAxis(DAY, TZ, null).now).toBeNull();
    expect(findMyAxis(DAY, TZ, Date.parse(DAY.to) + 1).now).toBeNull();
  });

  it('moves the middle ticks on a day of 25 hours', () => {
    // Sunday 25 October 2026: the clocks go back at 03:00, so 06:00 comes seven hours after midnight.
    const day = { from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z' };
    const axis = findMyAxis(day, TZ, null);
    expect(axis.ticks[1]?.at).toBeCloseTo(7 / 25);
    expect(axis.ticks[4]?.at).toBe(1);
  });
});

describe('one person’s day', () => {
  const person = { name: 'Ruben Visser', now: { place: 'Wilgendam', when: '4 min ago', nearby: false } };
  const order = ['home', 'wilgendam'];

  it('lists the stops numbered in their colours, the way between and the gaps in plain words', () => {
    const rows = findMyListRows(RUBEN, { tz: TZ, day: DAY, person, mac: 'Studio', order });
    expect(rows.map((r) => [r.kind, r.time, r.duration])).toEqual([
      ['stay', '00:00', '7 h 50 min'],
      ['trip', '07:50', '40 min'],
      ['stay', '08:30', '3 h 45 min'],
      ['trip', '12:15', '15 min'],
      ['stay', '12:30', '35 min'],
      ['gap', '13:05', '40 min'],
      ['stay', '13:45', '1 h 35 min so far'],
    ]);
    expect(rows[0]).toMatchObject({ n: 1, tone: 0, place: 'Home', sub: 'Lindenlaan 8, Rietveen' });
    expect(rows[1]).toMatchObject({ title: 'On the way' });
    expect(rows[1]?.kind === 'trip' && rows[1].sub).toMatch(
      /^Home → Wilgendam · about \d+ km in a straight line$/,
    );
    expect(rows[3]?.kind === 'trip' && rows[3].sub).toMatch(/^Within Wilgendam · about 3\.\d km/);
    expect(rows[5]).toMatchObject({ title: 'Not read', sub: 'Studio was in use, so Whombat left it alone.' });
    expect(rows[6]).toMatchObject({
      n: 4,
      ongoing: true,
      sub: 'Stationsplein 2, Wilgendam · seen 4 min ago',
    });
  });

  it('says a hole inside a stay under it, and no location in the person’s name', () => {
    const rows = findMyListRows(
      [
        stay('00:00', '08:20', 'Home', null, HOME, {
          holes: [{ from: at('02:10'), to: at('06:30'), why: 'no_location' }],
        }),
        { kind: 'gap', from: at('08:20'), to: at('09:00'), why: 'no_location' },
      ],
      { tz: TZ, day: DAY, person: { name: 'Noor Visser', now: null }, mac: 'Studio', order },
    );
    expect(rows[0]?.kind === 'stay' && rows[0].holes).toEqual(['No location 02:10–06:30']);
    expect(rows[1]).toMatchObject({ title: 'No location', sub: 'Find My had no location for Noor.' });
  });

  it('says where they are now, else how many stops and how far apart', () => {
    expect(findMyDayMeta(RUBEN, person)).toBe('Now in Wilgendam · seen 4 min ago');
    const done = RUBEN.slice(0, 5);
    expect(findMyDayMeta(done, person)).toMatch(/^3 stops · about \d+ km between them$/);
    expect(findMyDayMeta([], person)).toBe('No stops');
    expect(findMyDayMeta([stay('00:00', '24:00', 'Home', null, null)], person)).toBe('1 stop');
  });
});

describe('the map', () => {
  // The Mac's points at 640 × 260, for the pins Home (1), the station (2, 4) and the quay (3).
  const points = [
    { stops: [1], x: 100, y: 200 },
    { stops: [2, 4], x: 500, y: 100 },
    { stops: [3], x: 560, y: 60 },
  ];

  it('carries the Mac’s points to the box and joins the stops in order, dotted across a gap', () => {
    const tones = new Map([
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
    const marks = findMyTimelineMarks(points, { w: 640, h: 260 }, { w: 640, h: 260 }, tones);
    expect(marks.map((m) => [m.label, m.tone, m.x, m.y])).toEqual([
      ['1', 0, 100, 200],
      ['2, 4', 1, 500, 100],
      ['3', 1, 560, 60],
    ]);
    const lines = findMyTimelineLines(RUBEN, marks);
    expect(lines.map((l) => [l.x1, l.x2, l.dotted])).toEqual([
      [100, 500, false],
      [500, 560, false],
      [560, 500, true],
    ]);
    expect(findMyNowMark(RUBEN, marks)?.label).toBe('2, 4');
    expect(findMyNowMark(RUBEN.slice(0, 5), marks)).toBeNull();
    // A box half as wide shows the middle of the picture: the outer points fall off it.
    expect(findMyTimelineMarks(points, { w: 640, h: 260 }, { w: 320, h: 260 }, tones)).toHaveLength(0);
  });
});

describe('the week', () => {
  it('adds each place, the way and what wasn’t read up in whole hours', () => {
    const order = ['home', 'wilgendam'];
    const totals = findMyWeekTotals([RUBEN, RUBEN.slice(0, 2)], order);
    expect(totals.map((t) => [t.label, t.value])).toEqual([
      ['Home', '16 h'],
      ['Wilgendam', '6 h'],
      ['On the way', '2 h'],
      ['Not read', '1 h'],
    ]);
    const short = findMyWeekTotals(
      [[{ kind: 'gap', from: at('10:00'), to: at('10:10'), why: 'not_read' }]],
      order,
    );
    expect(short).toEqual([{ key: 'gap', label: 'Not read', tone: 'gap', value: 'under 1 h' }]);
  });
});

describe('whose', () => {
  const people = [
    { id: 'a', kept: true },
    { id: 'b', kept: true },
    { id: 'c', kept: false },
  ];
  it('picks the person shown and works out whose days to keep after a tick', () => {
    expect(findMyPickedPerson(people, 'b')).toBe('b');
    expect(findMyPickedPerson(people, 'c')).toBe('a');
    expect(findMyPickedPerson([], null)).toBeNull();
    expect(findMyWhoseAfter(people, 'c', true)).toEqual(['a', 'b', 'c']);
    expect(findMyWhoseAfter(people, 'a', false)).toEqual(['b']);
  });
});
