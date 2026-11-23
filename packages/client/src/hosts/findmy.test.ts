/** Find My on a Mac's page: when the tab reads, its one line, the people's lines, the map's size, zoom and pins. */
import {
  findMyProblemText,
  HOST_FIND_MY_FRESH_MS,
  HOST_SCREEN_LIMITS,
  type HostFindMy,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  FIND_MY_SPAN,
  FIND_MY_WORDS,
  findMyAgo,
  findMyAtHome,
  findMyBackgroundLine,
  findMyCanZoom,
  findMyConnectionOf,
  findMyEvery,
  findMyExactView,
  findMyFirstName,
  findMyMacs,
  findMyMapAsk,
  findMyMapQuery,
  findMyPersonLine,
  findMyPins,
  findMyPolls,
  findMyStale,
  findMyTones,
  findMyView,
  findMyZoom,
} from './findmy';
import { FIND_MY_PEOPLE } from './fixtures-findmy';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const can = { can: true, why: null } as const;

function state(more: Partial<HostFindMy> = {}): HostFindMy {
  return {
    server: 'studio',
    reading: false,
    readAt: iso(30_000),
    problem: null,
    people: FIND_MY_PEOPLE.map((p) => ({ ...p })),
    exact: null,
    ...more,
  };
}

describe('when the Find My tab reads', () => {
  it('reads on an old read or none, never while one runs', () => {
    expect(findMyStale(state({ readAt: null }), NOW)).toBe(true);
    expect(findMyStale(state({ readAt: iso(HOST_FIND_MY_FRESH_MS) }), NOW)).toBe(true);
    expect(findMyStale(state({ readAt: iso(HOST_FIND_MY_FRESH_MS - 1000) }), NOW)).toBe(false);
    expect(findMyStale(state({ readAt: null, reading: true }), NOW)).toBe(false);
  });

  it('asks again shortly while a read or a picture is under way', () => {
    expect(findMyPolls(undefined)).toBe(false);
    expect(findMyPolls(state())).toBe(false);
    expect(findMyPolls(state({ reading: true }))).toBe(true);
    const taking = { person: 'db6613615969', state: 'taking' as const, takenAt: null, problem: null };
    expect(findMyPolls(state({ exact: taking }))).toBe(true);
    expect(findMyPolls(state({ exact: { ...taking, state: 'ready', takenAt: iso(0) } }))).toBe(false);
  });
});

describe('the Find My tab in words', () => {
  const view = (s: HostFindMy | undefined, screen: Parameters<typeof findMyView>[1]['screen'] = can) =>
    findMyView(s, { name: 'studio', now: NOW, screen });

  it('says the screen’s own reason first, and doesn’t read then', () => {
    const v = view(state({ reading: true }), { can: false, why: 'Screen Sharing is off on the Mac.' });
    expect(v.status).toEqual({ tone: 'warn', text: 'Screen Sharing is off on the Mac.' });
    expect(v.canRead).toBe(false);
    expect(v.reading).toBe(false);
  });

  it('says it reads while a read runs, and before the first one starts', () => {
    expect(view(undefined).status?.text).toBe(FIND_MY_WORDS.reading('studio'));
    expect(view(state({ readAt: null, people: [] })).reading).toBe(true);
    const v = view(state({ reading: true }));
    expect(v.status).toMatchObject({ tone: 'mut', text: 'Reading Find My on studio…' });
    expect(v.canRead).toBe(false);
  });

  it('words why the last read didn’t work in one line', () => {
    const v = view(state({ problem: { code: 'in_use' } }));
    expect(v.status).toEqual({ tone: 'warn', text: findMyProblemText('in_use', 'studio') });
    expect(v.status?.text).toContain('studio');
    expect(v.canRead).toBe(true);
  });

  it('lists the people in Find My’s words, with when it read them', () => {
    const v = view(state());
    expect(v.readLine).toBe('Read just now');
    expect(view(state({ readAt: iso(5 * 60_000) })).readLine).toContain('5');
    expect(v.people.map((p) => p.line)).toEqual([
      'Home · Now',
      'Wilgendam · 5 min ago',
      'Oosterhaven · 18 min ago',
      FIND_MY_WORDS.noPlace,
    ]);
    expect(v.people.map((p) => p.firstName)).toEqual(['Noor', 'Ruben', 'Ilse', 'Sem']);
    expect(v.people.map((p) => p.placed)).toEqual([true, true, true, false]);
    expect(v.people[0]?.nearby).toBe(true);
    expect(v.anyLocated).toBe(true);
    expect(v.empty).toBeNull();
  });

  it('says so when nobody shares their location', () => {
    const v = view(state({ people: [] }));
    expect(v.empty).toBe('Nobody shares their location with Find My on studio.');
    expect(v.anyLocated).toBe(false);
    expect(view(state({ people: [], readAt: null, problem: { code: 'no_find_my' } })).empty).toBeNull();
  });

  it('keeps short words for a person', () => {
    expect(findMyPersonLine({ place: 'Home', when: null })).toBe('Home');
    expect(findMyFirstName('  Ilse de Wit ')).toBe('Ilse');
    expect(findMyAgo(iso(59_000), NOW)).toBe('just now');
  });

  it('gives each person a tone of their own while there are tones left, the same each time', () => {
    const ids = FIND_MY_PEOPLE.map((p) => p.id);
    const tones = findMyTones(ids);
    expect(new Set(tones).size).toBe(ids.length);
    expect(findMyTones(ids)).toEqual(tones);
    const many = findMyTones([
      '000000000000',
      '000000000005',
      '00000000000a',
      '00000000000f',
      '000000000014',
    ]);
    expect(new Set(many).size).toBe(5);
    expect(tones.every((t) => t >= 0 && t < 5)).toBe(true);
  });
});

describe('the exact picture', () => {
  const person = 'b6b64347cde5';
  it('is being taken until the server says it is ready, then names the Mac and when', () => {
    expect(findMyExactView(state(), person, 'studio', NOW)).toEqual({
      kind: 'taking',
      text: 'Taking the picture on studio…',
    });
    const exact = { person, state: 'ready' as const, takenAt: iso(12_000), problem: null };
    expect(findMyExactView(state({ exact }), person, 'studio', NOW)).toMatchObject({
      kind: 'ready',
      text: 'Find My on studio · just now',
    });
    // Another person's picture isn't this one's.
    expect(findMyExactView(state({ exact }), 'db6613615969', 'studio', NOW).kind).toBe('taking');
  });

  it('says why it failed', () => {
    const exact = { person, state: 'failed' as const, takenAt: null, problem: { code: 'locked' as const } };
    expect(findMyExactView(state({ exact }), person, 'studio', NOW)).toMatchObject({ kind: 'failed' });
  });
});

describe('the map', () => {
  it('zooms by halves and doubles within the spans the Mac draws', () => {
    const r = { lat: 52.7, lon: 5.4, spanM: 1500 };
    expect(findMyZoom(r, 'in')).toEqual({ lat: 52.7, lon: 5.4, spanM: 750 });
    expect(findMyZoom(r, 'out').spanM).toBe(3000);
    expect(findMyZoom({ ...r, spanM: 60 }, 'in').spanM).toBe(FIND_MY_SPAN.min);
    expect(findMyZoom({ ...r, spanM: 15_000_000 }, 'out').spanM).toBe(FIND_MY_SPAN.max);
    expect(findMyCanZoom({ spanM: FIND_MY_SPAN.min }, 'in')).toBe(false);
    expect(findMyCanZoom({ spanM: FIND_MY_SPAN.min }, 'out')).toBe(true);
    expect(findMyCanZoom(null, 'in')).toBe(true);
  });

  it('asks for the box’s size in steps, within the sides the Mac draws', () => {
    expect(findMyMapAsk({ w: 0, h: 360 })).toBeNull();
    expect(findMyMapAsk({ w: 1103, h: 360 })).toEqual({ w: 1120, h: 384 });
    expect(findMyMapAsk({ w: 1104, h: 384 })).toEqual({ w: 1120, h: 384 });
    expect(findMyMapAsk({ w: 9000, h: 10 })).toEqual({ w: HOST_SCREEN_LIMITS.mapSide, h: 64 });
  });

  it('asks in the app’s theme, around a region only once someone zoomed', () => {
    expect(findMyMapQuery({ w: 640, h: 384 }, true, null)).toEqual({ w: 640, h: 384, dark: 'true' });
    expect(findMyMapQuery({ w: 640, h: 384 }, false, { lat: 1, lon: 2, spanM: 800 })).toEqual({
      w: 640,
      h: 384,
      dark: 'false',
      lat: 1,
      lon: 2,
      spanM: 800,
    });
  });

  it('carries the Mac’s points to the box as the picture covers it', () => {
    // A 1000 × 400 picture in a 500 × 400 box: scaled by 1, cut 250 points on each side.
    const pins = findMyPins(
      [
        { person: 'a', x: 500, y: 200 },
        { person: 'b', x: 100, y: 200 },
        { person: 'c', x: 700, y: 390 },
      ],
      { w: 1000, h: 400 },
      { w: 500, h: 400 },
    );
    expect(pins).toEqual([
      { person: 'a', x: 250, y: 200, above: false },
      { person: 'c', x: 450, y: 390, above: true },
    ]);
    // A larger box scales the points with the picture.
    expect(
      findMyPins([{ person: 'a', x: 50, y: 50 }], { w: 100, h: 100 }, { w: 200, h: 200 })[0],
    ).toMatchObject({
      x: 100,
      y: 100,
    });
    expect(findMyPins([{ person: 'a', x: 1, y: 1 }], { w: 0, h: 0 }, { w: 10, h: 10 })).toEqual([]);
  });

  it('moves avatars apart that would cover each other', () => {
    const pins = findMyPins(
      [
        { person: 'a', x: 100, y: 100 },
        { person: 'b', x: 105, y: 100 },
        { person: 'c', x: 100, y: 102 },
      ],
      { w: 400, h: 400 },
      { w: 400, h: 400 },
    );
    for (const [i, p] of pins.entries())
      for (const q of pins.slice(i + 1)) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(34);
  });
});

describe('reading in the background', () => {
  it('says how often, and for which automation', () => {
    expect(findMyBackgroundLine(null)).toBe(FIND_MY_WORDS.readsWhileLooking);
    expect(findMyBackgroundLine(undefined)).toBe(FIND_MY_WORDS.readsWhileLooking);
    expect(findMyBackgroundLine({ everyMinutes: 15, automation: null })).toBe('Reads every 15 minutes');
    expect(findMyBackgroundLine({ everyMinutes: 15, automation: 'Tell me when Mara gets home' })).toContain(
      'Tell me when Mara gets home',
    );
    expect(findMyBackgroundLine({ everyMinutes: 15, automation: null, timeline: true })).toContain('timeline');
    // An automation's name wins over the timeline: it is the one the person made.
    expect(
      findMyBackgroundLine({ everyMinutes: 15, automation: 'Tell me when Mara gets home', timeline: true }),
    ).not.toContain('timeline');
  });

  it('names hours as hours', () => {
    expect(findMyEvery(5)).toBe('every 5 minutes');
    expect(findMyEvery(60)).toBe('every hour');
    expect(findMyEvery(120)).toBe('every 2 hours');
    expect(findMyEvery(90)).toBe('every 90 minutes');
    expect(findMyEvery(1)).toBe('every minute');
  });
});

describe('the Find My connection a Mac reads for', () => {
  const findMy = { id: 'con_findmy', catalogId: 'findmy', label: 'Find My', fields: { mac: 'studio' } };
  const other = {
    id: 'con_ha',
    catalogId: 'homeassistant',
    label: 'Home Assistant',
    fields: { mac: 'studio' },
  };

  it('is the Find My connection whose mac is that server', () => {
    expect(findMyConnectionOf([other, findMy], 'studio')).toEqual({
      connectionId: 'con_findmy',
      label: 'Find My',
      href: '/things/connection%3Acon_findmy',
    });
    expect(findMyConnectionOf([other, findMy], 'pve-02')).toBeNull();
    expect(findMyConnectionOf(undefined, 'studio')).toBeNull();
  });

  it('lists each Find My connection with its Mac', () => {
    expect(findMyMacs([other, findMy, { ...findMy, id: 'con_none', fields: {} }])).toEqual([
      { connectionId: 'con_findmy', serverId: 'studio' },
    ]);
  });

  it('knows Home in Find My’s own words', () => {
    expect(findMyAtHome({ place: 'Home' })).toBe(true);
    expect(findMyAtHome({ place: ' home ' })).toBe(true);
    expect(findMyAtHome({ place: 'Wilgendam' })).toBe(false);
    expect(findMyAtHome({ place: null })).toBe(false);
  });
});
