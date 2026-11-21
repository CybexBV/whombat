/** A page from a recipe (connection-looks.md): paths, formats, the slots, warnings and what is said to the assistant. */
import { ConnectionPage, pageRecipeProblems } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../kinds/slots';
import type { RawPoint } from '../series';
import { buildRecipe, pointKey, type ReadAnswer, recipePoints, TREND_KEY } from './build';
import { holds, MISSING, valueAt, words } from './values';

const now = new Date('2026-11-05T12:00:00Z');
const tz = 'Europe/Amsterdam';

describe('a value at a path', () => {
  const json = { data: { items: [{ name: 'a' }, { name: 'b' }] }, 'temp.c': 21.5, on: false };
  it('walks keys and list positions, and finds a key holding dots whole', () => {
    expect(valueAt(json, 'data.items.1.name')).toBe('b');
    expect(valueAt(json, 'data.items.length')).toBe(2);
    expect(valueAt(json, 'temp.c')).toBe(21.5);
    expect(valueAt(json, '$')).toBe(json);
    expect(valueAt(json, 'data.nope')).toBe(MISSING);
    expect(valueAt(json, 'on')).toBe(false);
  });

  it('writes each format in Whombat’s words', () => {
    expect(words(1284, { format: 'number' }, now, tz)).toBe('1,284');
    expect(words(0.645, { format: 'percent', scale: 100 }, now, tz)).toBe('64.5 %');
    expect(words(1.8e9, { format: 'bytes' }, now, tz)).toBe('1.8 GB');
    expect(words(7500, { format: 'duration' }, now, tz)).toBe('2 h 5 min');
    expect(words('2026-11-05T11:55:00Z', { format: 'ago' }, now, tz)).toBe('5 min ago');
    expect(words([1, 2, 3], { format: 'count', unit: 'jobs' }, now, tz)).toBe('3 jobs');
    expect(words(true, { format: 'yesno' }, now, tz)).toBe('Yes');
    expect(words(21.5, { unit: '°C' }, now, tz)).toBe('21.5 °C');
    expect(words({ a: 1 }, {}, now, tz)).toBeNull();
    expect(words(MISSING, {}, now, tz)).toBeNull();
  });

  it('tells when a warning holds', () => {
    expect(holds(10, { below: 15 })).toBe(true);
    expect(holds(20, { below: 15 })).toBe(false);
    expect(holds(0.9, { above: 80 }, 100)).toBe(true);
    expect(holds(false, { equals: false })).toBe(true);
    expect(holds('ONLINE', { not: 'online' })).toBe(false);
    expect(holds([], { present: true })).toBe(false);
    expect(holds(['x'], { present: true })).toBe(true);
    expect(holds(MISSING, { equals: 1 })).toBe(false);
  });
});

const recipe = ConnectionPage.parse({
  reads: [
    { id: 'status', tool: 'get_status' },
    { id: 'queue', path: '/api/queue' },
  ],
  live: {
    title: 'Downloading now',
    read: 'queue',
    items: 'items',
    name: { at: 'title' },
    right: { at: 'pct', format: 'percent' },
    tone: { at: 'state', bad: ['failed'] },
  },
  counts: {
    title: 'In the house',
    lines: [
      { id: 'lights', title: 'Lights on', value: { read: 'status', at: 'lights.on' }, change: true },
      { id: 'temp', title: 'Living room', value: { read: 'status', at: 'temp', unit: '°C' } },
    ],
  },
  trend: { title: 'Energy', label: 'Energy', value: { read: 'status', at: 'kwh', unit: 'kWh' }, how: 'max' },
  facts: [{ label: 'Firmware', value: { read: 'status', at: 'version' } }],
  warnings: [
    {
      id: 'offline',
      title: 'The hub is offline',
      value: { read: 'status', at: 'online' },
      equals: false,
      important: true,
    },
    {
      id: 'battery',
      title: 'A battery is low',
      value: { read: 'status', at: 'battery' },
      below: 15,
      important: false,
    },
  ],
});

const answers = new Map<string, ReadAnswer>([
  [
    'status',
    {
      ok: true,
      value: { lights: { on: 4 }, temp: 21.5, kwh: 3.2, version: '2.4.1', online: false, battery: 60 },
    },
  ],
  [
    'queue',
    {
      ok: true,
      value: {
        items: [
          { title: 'Ubuntu 24.04', pct: 45, state: 'downloading' },
          { title: 'Broken.iso', pct: 3, state: 'failed' },
        ],
      },
    },
  ],
]);

const day = 86_400_000;
const at = (msAgo: number, value: number): RawPoint => ({ at: new Date(now.getTime() - msAgo), value });

describe('the page a recipe builds', () => {
  it('fills the slots in their places with the values read', () => {
    const points = new Map([
      [pointKey('lights'), [at(7 * day, 1)]],
      [TREND_KEY, [at(2 * day, 2.5), at(day, 4), at(0, 3.2)]],
    ]);
    const built = buildRecipe(recipe, answers, { now, timeZone: tz, name: 'Hub', points });
    expect(built.problems).toEqual([]);
    expect(slotProblems({ ...built.view, slots: built.view.slots })).toEqual([]);
    const live = built.view.panels.find((p) => p.id === 'live');
    expect(live?.kind === 'list' && live.items.map((i) => [i.title, i.right, i.tone])).toEqual([
      ['Ubuntu 24.04', '45 %', undefined],
      ['Broken.iso', '3 %', 'bad'],
    ]);
    const counts = built.view.panels.find((p) => p.id === 'counts');
    expect(
      counts?.kind === 'list' && counts.items.map((i) => [i.title, i.figure?.value, i.figure?.note]),
    ).toEqual([
      ['Lights on', '4', '+3 on last week'],
      ['Living room', '21.5 °C', undefined],
    ]);
    const trend = built.view.panels.find((p) => p.id === 'trend');
    expect(trend?.kind === 'chart' && trend.series[0]?.values.filter((v) => v !== null)).toEqual([
      2.5, 4, 3.2,
    ]);
    expect(
      built.view.facts
        .flat()
        .map((p) => p.text)
        .join(''),
    ).toContain('2.4.1');
    expect(built.view.notices.map((n) => [n.check, n.tone])).toEqual([['page.broken', 'bad']]);
    expect(built.shows.join('\n')).toContain('Ubuntu 24.04');
  });

  it('says what is wrong instead of drawing it', () => {
    const broken = new Map<string, ReadAnswer>([
      ['status', { ok: true, value: { lights: {} } }],
      ['queue', { ok: false, problem: 'Hub answered with an error.' }],
    ]);
    const built = buildRecipe(recipe, broken, { now, timeZone: tz, name: 'Hub', points: new Map() });
    const all = built.problems.join('\n');
    expect(all).toContain('queue');
    expect(all).toContain('lights.on');
    expect(built.view.panels.find((p) => p.id === 'live')).toBeUndefined();
    // No trend before two days of readings, said in words.
    expect(built.shows.join('\n')).toContain('two days');
  });

  it('keeps the numbers a trend and a count’s change need', () => {
    expect(recipePoints(recipe, answers)).toEqual({ [pointKey('lights')]: 4, [TREND_KEY]: 3.2 });
  });
});

describe('a recipe’s own mistakes', () => {
  it('names a read nobody defined and an empty page', () => {
    const bad = ConnectionPage.parse({
      reads: [{ id: 'a', path: '/x' }],
      counts: { title: 'X', lines: [{ id: 'n', title: 'N', value: { read: 'b', at: 'n' } }] },
    });
    expect(pageRecipeProblems(bad).join(' ')).toContain('“b”');
    expect(
      pageRecipeProblems(ConnectionPage.parse({ reads: [{ id: 'a', path: '/x' }] })).join(' '),
    ).toContain('nothing');
  });

  it('refuses a read with both a tool and a path, and a warning without one condition', () => {
    expect(ConnectionPage.safeParse({ reads: [{ id: 'a', path: '/x', tool: 't' }] }).success).toBe(false);
    expect(
      ConnectionPage.safeParse({
        reads: [{ id: 'a', path: '/x' }],
        warnings: [{ id: 'w', title: 'W', value: { read: 'a', at: 'x' }, important: false }],
      }).success,
    ).toBe(false);
  });
});
