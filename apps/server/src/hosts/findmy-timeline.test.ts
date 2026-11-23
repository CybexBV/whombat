/**
 * A Find My timeline's pure parts (docs/decisions/findmy-timeline.md): what a read says of a kept person, when it
 * extends their last row or starts a new one, the rows a day needs, everyone as the timeline lists them and the signed
 * words. Made-up names only (Noor, Ruben and Ilse, towns Rietveen and Wilgendam).
 */
import type { FindMyTimelineRow, HostFindMyPerson } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { findMyPersonId } from './findmy';
import {
  type LastStop,
  rowsForDay,
  sameStop,
  saysOf,
  type TimelineSays,
  timelineDay,
  timelineDroppedText,
  timelinePaceMinutes,
  timelinePeople,
  timelineSetText,
  timelineWrites,
} from './findmy-timeline';

const NOOR = findMyPersonId('Noor Visser');
const RUBEN = findMyPersonId('Ruben Visser');
const ILSE = findMyPersonId('Ilse Visser');
const MIN = 60_000;
const T0 = Date.parse('2026-11-23T08:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * MIN);
/** A 15-minute pace: twice it plus 5 minutes. */
const TOLERANCE = 35 * MIN;

const person = (name: string, over: Partial<HostFindMyPerson> = {}): HostFindMyPerson => ({
  id: findMyPersonId(name),
  name,
  place: 'Home',
  address: 'Kerkstraat 4, Rietveen',
  when: 'Now',
  nearby: false,
  location: { lat: 52.1, lon: 5.2, accuracyM: 100 },
  ...over,
});

const last = (over: Partial<LastStop> = {}): LastStop => ({
  id: 7,
  person: NOOR,
  kind: 'place',
  place: 'Home',
  address: 'Kerkstraat 4, Rietveen',
  code: null,
  lastAt: at(0),
  ...over,
});

const home: TimelineSays = { kind: 'place', place: 'Home', address: 'Kerkstraat 4, Rietveen', spot: null };

describe('what a read says of a person', () => {
  it('is Find My’s place with its street and spot, never the “seen” words', () => {
    const says = saysOf(person('Noor Visser'));
    expect(says).toEqual({
      kind: 'place',
      place: 'Home',
      address: 'Kerkstraat 4, Rietveen',
      spot: { lat: 52.1, lon: 5.2, accuracyM: 100 },
    });
    expect(JSON.stringify(says)).not.toContain('Now');
  });

  it('takes the street as the place when Find My gave only that, and no location without either', () => {
    expect(saysOf(person('Noor Visser', { place: null }))).toMatchObject({
      kind: 'place',
      place: 'Kerkstraat 4, Rietveen',
    });
    expect(saysOf(person('Noor Visser', { place: null, address: null }))).toEqual({ kind: 'none' });
    expect(saysOf(undefined)).toEqual({ kind: 'none' });
  });
});

describe('a read on the timeline', () => {
  const says = (map: Record<string, TimelineSays>) => (p: string) => map[p] ?? { kind: 'none' as const };

  it('extends the last row when it says the same within the tolerance', () => {
    const writes = timelineWrites(
      [NOOR],
      new Map([[NOOR, last()]]),
      says({ [NOOR]: home }),
      at(15),
      TOLERANCE,
    );
    expect(writes).toEqual([{ kind: 'extend', id: 7, person: NOOR, at: at(15), says: home }]);
  });

  it('starts a new row for another place, after a pause longer than the tolerance, or for the first read', () => {
    const school: TimelineSays = {
      kind: 'place',
      place: 'School',
      address: 'Dorpsweg 2, Wilgendam',
      spot: null,
    };
    expect(
      timelineWrites([NOOR], new Map([[NOOR, last()]]), says({ [NOOR]: school }), at(15), TOLERANCE)[0],
    ).toMatchObject({ kind: 'start', person: NOOR });
    expect(
      timelineWrites([NOOR], new Map([[NOOR, last()]]), says({ [NOOR]: home }), at(36), TOLERANCE)[0],
    ).toMatchObject({ kind: 'start' });
    expect(timelineWrites([NOOR], new Map(), says({ [NOOR]: home }), at(0), TOLERANCE)[0]).toMatchObject({
      kind: 'start',
    });
  });

  it('compares the street, else the place words, without case or spaces', () => {
    expect(sameStop(last(), { ...home, place: 'Thuis' })).toBe(true);
    expect(
      sameStop(last({ address: null, place: 'Wilgendam' }), { ...home, address: null, place: 'wilgendam ' }),
    ).toBe(true);
    expect(sameStop(last(), { kind: 'none' })).toBe(false);
  });

  it('gives a kept person missing from the read no location, and leaves people not kept alone', () => {
    const writes = timelineWrites([NOOR, RUBEN], new Map(), says({ [ILSE]: home }), at(0), TOLERANCE);
    expect(writes.map((w) => [w.person, w.says.kind])).toEqual([
      [NOOR, 'none'],
      [RUBEN, 'none'],
    ]);
  });

  it('keeps a background read that didn’t work with its problem, one row per problem', () => {
    const unread = (code: 'in_use' | 'timeout') => () => ({ kind: 'unread' as const, code });
    const row = last({ kind: 'unread', place: null, address: null, code: 'in_use' });
    expect(
      timelineWrites([NOOR], new Map([[NOOR, row]]), unread('in_use'), at(2), TOLERANCE)[0],
    ).toMatchObject({
      kind: 'extend',
    });
    expect(
      timelineWrites([NOOR], new Map([[NOOR, row]]), unread('timeout'), at(2), TOLERANCE)[0],
    ).toMatchObject({
      kind: 'start',
      says: { kind: 'unread', code: 'timeout' },
    });
  });

  it('writes nothing for a read no newer than the last row (the same read noted twice)', () => {
    expect(
      timelineWrites([NOOR], new Map([[NOOR, last()]]), says({ [NOOR]: home }), at(0), TOLERANCE),
    ).toEqual([]);
  });

  it('reads every 15 minutes at least, or sooner when the person chose so', () => {
    expect(timelinePaceMinutes('off')).toBe(15);
    expect(timelinePaceMinutes('60')).toBe(15);
    expect(timelinePaceMinutes('5')).toBe(5);
  });
});

describe('a day from the rows', () => {
  const row = (place: string, from: number, to: number): FindMyTimelineRow => ({
    kind: 'place',
    place,
    address: null,
    spot: null,
    firstAt: at(from),
    lastAt: at(to),
  });

  it('takes the rows that touch the day, the last one before it and the first one after it', () => {
    const rows = [
      row('A', -300, -200),
      row('B', -100, -10),
      row('C', 0, 60),
      row('D', 200, 300),
      row('E', 400, 500),
    ];
    const picked = rowsForDay(rows, at(0), at(120)).map((r) => (r.kind === 'place' ? r.place : r.kind));
    expect(picked).toEqual(['B', 'C', 'D']);
  });

  it('is cut at the day’s bounds', () => {
    const segments = timelineDay([row('Home', -120, 60)], {
      from: at(0),
      to: at(24 * 60),
      now: at(30 * 60),
      toleranceMs: TOLERANCE,
    });
    expect(segments[0]).toMatchObject({ kind: 'stay', from: at(0).toISOString(), place: 'Home' });
  });
});

describe('everyone on the timeline', () => {
  it('lists the last read in its order with what it says now, then those kept who weren’t on it', () => {
    const kept = [
      { person: RUBEN, name: 'Ruben Visser', keptSince: at(0) },
      { person: ILSE, name: 'Ilse Visser', keptSince: at(5) },
    ];
    const people = timelinePeople(
      [person('Noor Visser'), person('Ruben Visser', { place: 'Wilgendam' })],
      kept,
    );
    expect(people.map((p) => [p.name, p.kept])).toEqual([
      ['Noor Visser', false],
      ['Ruben Visser', true],
      ['Ilse Visser', true],
    ]);
    expect(people[1]).toMatchObject({
      keptSince: at(0).toISOString(),
      now: { place: 'Wilgendam', when: 'Now' },
    });
    expect(people[2]?.now).toBeNull();
  });
});

describe('the signed words', () => {
  it('name the people kept, or say it stopped, and whose days went', () => {
    expect(timelineSetText(['Noor Visser', 'Ruben Visser'])).toBe(
      'Kept a Find My timeline for Noor Visser and Ruben Visser',
    );
    expect(timelineSetText([])).toContain('Stopped');
    expect(timelineDroppedText(['Ilse Visser'])).toContain('Ilse Visser');
    expect(timelineDroppedText([])).toBeNull();
    // Too many names for a line: a count.
    expect(timelineSetText(Array.from({ length: 30 }, (_, i) => `Person Number ${i}`))).toContain(
      '30 people',
    );
  });
});
