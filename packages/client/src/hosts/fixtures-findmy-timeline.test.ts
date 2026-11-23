/**
 * The fixture worlds' timeline answers as the box does: days cut at their bounds and at now (today's last stay going
 * on), only for the people kept, whose days go when unticked, everything when deleted or stopped, and a map with a
 * point per distinct spot, or 409 `find_my_no_places` on a day without one.
 */
import { FindMyTimeline, FindMyTimelineChanged, FindMyTimelineMap } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  createFindMyTimelineFixture,
  FIND_MY_TIMELINE_FIXTURE_PEOPLE as P,
} from './fixtures-findmy-timeline';

const TZ = 'Europe/Amsterdam';
/** Monday 23 November 2026, 15:20 in Amsterdam. */
const NOW = Date.parse('2026-11-23T14:20:00Z');

function world() {
  let now = NOW;
  let reads = true;
  const fx = createFindMyTimelineFixture({ clock: () => now, assistantReads: () => reads });
  const read = (date: string, days = 1) =>
    FindMyTimeline.parse(fx.timeline({ date, tz: TZ, days: String(days) }).body);
  return {
    fx,
    read,
    later: (ms: number) => {
      now += ms;
    },
    stopReading: () => {
      reads = false;
    },
  };
}

describe('the fixture’s timeline', () => {
  it('answers today as the mockup draws it, cut at now, for the people kept', () => {
    const { read } = world();
    const t = read('2026-11-23');
    expect(t.paceMinutes).toBe(15);
    expect(t.assistantReads).toBe(true);
    expect(t.people.map((p) => [p.name, p.kept])).toEqual([
      ['Noor Visser', true],
      ['Ruben Visser', true],
      ['Ilse de Wit', false],
      ['Sem Visser', false],
    ]);
    const day = t.days[0];
    expect(day?.from).toBe('2026-11-22T23:00:00.000Z');
    const ruben = day?.people.find((p) => p.person === P.ruben)?.segments ?? [];
    expect(ruben.map((s) => s.kind)).toEqual(['stay', 'trip', 'stay', 'trip', 'stay', 'gap', 'stay']);
    expect(ruben.at(-1)).toMatchObject({
      kind: 'stay',
      place: 'Wilgendam',
      ongoing: true,
      to: new Date(NOW).toISOString(),
    });
    expect(day?.people.some((p) => p.person === P.ilse)).toBe(false);
  });

  it('answers the last seven days, oldest first, none of them going on but today', () => {
    const { read } = world();
    const week = read('2026-11-23', 7);
    expect(week.days.map((d) => d.date)).toEqual([
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
      '2026-11-23',
    ]);
    const ongoing = week.days.flatMap((d) =>
      d.people.flatMap((p) => p.segments.filter((s) => s.kind === 'stay' && s.ongoing)),
    );
    expect(ongoing).toHaveLength(2);
    // Saturday: Ruben goes to Oosterhaven.
    const saturday = week.days[4]?.people.find((p) => p.person === P.ruben)?.segments ?? [];
    expect(saturday.some((s) => s.kind === 'stay' && s.place === 'Oosterhaven')).toBe(true);
  });

  it('keeps someone ticked from now, deletes the days of someone unticked, and everything when stopped', () => {
    const { fx, read, later } = world();
    const set = (people: string[]) => FindMyTimelineChanged.parse(fx.set({ people }).body);
    const ticked = set([P.noor, P.ruben, P.ilse]);
    expect(ticked.eventId).not.toBeNull();
    expect(ticked.people.find((p) => p.id === P.ilse)?.kept).toBe(true);
    later(30 * 60_000);
    const ilse = read('2026-11-23').days[0]?.people.find((p) => p.person === P.ilse)?.segments ?? [];
    expect(ilse).toEqual([expect.objectContaining({ kind: 'stay', place: 'Oosterhaven', ongoing: true })]);
    expect(Date.parse(ilse[0]?.from ?? '')).toBe(NOW);

    set([P.ruben, P.ilse]);
    expect(read('2026-11-23').days[0]?.people.map((p) => p.person)).toEqual([P.ruben, P.ilse]);
    expect(set([P.ruben, P.ilse]).eventId).toBeNull();

    // Deleted: whose stays, the days before go.
    expect(FindMyTimelineChanged.parse(fx.remove({}).body).people.filter((p) => p.kept)).toHaveLength(2);
    expect(read('2026-11-22').days[0]?.people.every((p) => p.segments.length === 0)).toBe(true);

    set([]);
    const off = read('2026-11-23');
    expect(off.people.some((p) => p.kept)).toBe(false);
    expect(off.days[0]?.people).toEqual([]);
    expect(fx.set({ people: ['000000000000'] }).status).toBe(400);
  });

  it('draws a day’s map with a point per spot, and none for a day without one', () => {
    const { fx, stopReading, read } = world();
    const ask = { person: P.ruben, date: '2026-11-23', tz: TZ, w: '640', h: '256', dark: 'true' };
    const map = FindMyTimelineMap.parse(fx.map(ask).body);
    // Home, the station (2 and 4) and the quay.
    expect(map.points.map((p) => p.stops)).toEqual([[1], [2, 4], [3]]);
    for (const p of map.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(640);
    }
    const none = fx.map({ ...ask, person: P.ilse });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: { details: { code: 'find_my_no_places' } } });
    stopReading();
    expect(read('2026-11-23').assistantReads).toBe(false);
  });
});
