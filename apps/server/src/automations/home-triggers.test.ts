/**
 * What Whombat follows of Home Assistant for automations that start on it (docs/decisions/direct-automations.md): only
 * the entities and states live automations name, and only changes into or out of those states are signed.
 */
import { describe, expect, it } from 'vitest';
import { clockAheadOf } from '../things/kinds/ha-socket';
import {
  forgetUnwatched,
  HOME_CHANGE_FRESH_MS,
  homeChangesOf,
  homeGoneOf,
  type KnownEntity,
  listenedOf,
} from './home-triggers';

const HA = 'con_homeassist1';
const PROTECT = 'con_protect0001';

describe('listenedOf', () => {
  it('collects the entities, states and Protect events that live definitions name', () => {
    const listened = listenedOf([
      {
        triggers: [
          { kind: 'home_state', connectionId: HA, entity: 'binary_sensor.water_leak', to: 'On' },
          { kind: 'home_state', connectionId: HA, entity: 'binary_sensor.water_leak', to: 'unavailable' },
          { kind: 'protect', connectionId: PROTECT, event: 'ring' },
        ],
      },
      { triggers: [{ kind: 'protect', connectionId: PROTECT, event: 'smoke' }] },
      { triggers: [{ kind: 'manual' }] },
      null,
    ]);
    expect([...(listened.home.get(HA)?.get('binary_sensor.water_leak') ?? [])]).toEqual([
      'on',
      'unavailable',
    ]);
    expect([...(listened.protect.get(PROTECT) ?? [])]).toEqual(['ring', 'smoke']);
    expect(listened.home.size).toBe(1);
  });
});

describe('homeChangesOf', () => {
  const watched = new Map([['binary_sensor.water_leak', new Set(['on'])]]);

  it('invents no change for the first sight, and signs one into or out of a named state', () => {
    const known = new Map<string, { state: string; name: string | null }>();
    const first = { a: { 'binary_sensor.water_leak': { s: 'off', a: { friendly_name: 'Water leak' } } } };
    expect(homeChangesOf(known, watched, first)).toEqual([]);
    const wet = { c: { 'binary_sensor.water_leak': { '+': { s: 'on' } } } };
    expect(homeChangesOf(known, watched, wet)).toEqual([
      { entity: 'binary_sensor.water_leak', name: 'Water leak', from: 'off', to: 'on' },
    ]);
    const dry = { c: { 'binary_sensor.water_leak': { '+': { s: 'off' } } } };
    expect(homeChangesOf(known, watched, dry)).toMatchObject([{ from: 'on', to: 'off' }]);
  });

  it('ignores entities nobody names, attributes alone, and moves between states nobody names', () => {
    const known = new Map([['binary_sensor.water_leak', { state: 'off', name: 'Water leak' }]]);
    expect(homeChangesOf(known, watched, { c: { 'light.porch': { '+': { s: 'on' } } } })).toEqual([]);
    expect(
      homeChangesOf(known, watched, { c: { 'binary_sensor.water_leak': { '+': { a: { battery: 80 } } } } }),
    ).toEqual([]);
    expect(
      homeChangesOf(known, watched, { c: { 'binary_sensor.water_leak': { '+': { s: 'unavailable' } } } }),
    ).toEqual([]);
    expect(known.get('binary_sensor.water_leak')?.state).toBe('unavailable');
  });

  const NOW = Date.parse('2026-11-28T21:00:00Z');
  const secondsAgo = (ms: number) => (NOW - ms) / 1000;

  it('signs a change that happened just before the socket came back, with Home Assistant’s time', () => {
    const known = new Map<string, KnownEntity>([
      ['binary_sensor.water_leak', { state: 'off', name: 'Water leak' }],
    ]);
    const lc = secondsAgo(30_000);
    const again = { a: { 'binary_sensor.water_leak': { s: 'on', lc } } };
    expect(homeChangesOf(known, watched, again, NOW)).toMatchObject([
      { from: 'off', to: 'on', name: 'Water leak', changedAt: lc },
    ]);
  });

  it('signs nothing for a change older than two minutes heard only when the socket came back', () => {
    const known = new Map<string, KnownEntity>([
      ['binary_sensor.water_leak', { state: 'off', name: 'Water leak' }],
    ]);
    const stale = {
      a: { 'binary_sensor.water_leak': { s: 'on', lc: secondsAgo(HOME_CHANGE_FRESH_MS + 1000) } },
    };
    expect(homeChangesOf(known, watched, stale, NOW)).toEqual([]);
    // It is known now, so the next live change is from it.
    expect(known.get('binary_sensor.water_leak')?.state).toBe('on');
    // A snapshot that doesn't say when can't be told fresh either.
    const unsaid = new Map<string, KnownEntity>([['binary_sensor.water_leak', { state: 'off', name: null }]]);
    expect(homeChangesOf(unsaid, watched, { a: { 'binary_sensor.water_leak': { s: 'on' } } }, NOW)).toEqual(
      [],
    );
    // A live change is news whenever it comes.
    const live = {
      c: { 'binary_sensor.water_leak': { '+': { s: 'off', lc: secondsAgo(HOME_CHANGE_FRESH_MS * 5) } } },
    };
    expect(homeChangesOf(known, watched, live, NOW)).toMatchObject([{ from: 'on', to: 'off' }]);
  });

  it('keeps Home Assistant’s time of the last change, also when the state came back meanwhile', () => {
    const known = new Map<string, KnownEntity>([
      ['binary_sensor.water_leak', { state: 'on', name: 'Water leak', changedAt: secondsAgo(600_000) }],
    ]);
    const back = secondsAgo(60_000);
    expect(
      homeChangesOf(known, watched, { a: { 'binary_sensor.water_leak': { s: 'on', lc: back } } }, NOW),
    ).toEqual([]);
    expect(known.get('binary_sensor.water_leak')?.changedAt).toBe(back);
  });
});

describe('Home Assistant’s own clock', () => {
  const watched = new Map([['binary_sensor.water_leak', new Set(['on'])]]);
  const BOX = Date.parse('2026-11-28T21:00:00Z');
  const AHEAD = 10 * 60_000;

  it('reads how far Home Assistant’s clock is ahead from the time its answer says', () => {
    expect(clockAheadOf(new Date(BOX + AHEAD).toUTCString(), BOX)).toBe(AHEAD);
    expect(clockAheadOf(new Date(BOX - AHEAD).toUTCString(), BOX)).toBe(-AHEAD);
    expect(clockAheadOf(undefined, BOX)).toBeNull();
    expect(clockAheadOf('soon', BOX)).toBeNull();
  });

  it('judges a change heard at a reconnect by Home Assistant’s time, not the box’s', () => {
    // Home Assistant's clock runs ten minutes ahead; the door opened five minutes ago by its own clock.
    const lc = (BOX + AHEAD - 5 * 60_000) / 1000;
    const known = () =>
      new Map<string, KnownEntity>([['binary_sensor.water_leak', { state: 'off', name: 'Water leak' }]]);
    const again = { a: { 'binary_sensor.water_leak': { s: 'on', lc } } };
    // By the box's clock it would look like news (it seems to be from the future).
    expect(homeChangesOf(known(), watched, again, BOX)).toHaveLength(1);
    expect(homeChangesOf(known(), watched, again, BOX + AHEAD)).toEqual([]);
    // When Home Assistant didn't say its time, a change heard only at a reconnect starts nothing.
    expect(homeChangesOf(known(), watched, again, null)).toEqual([]);
    // A live change is still news.
    const live = { c: { 'binary_sensor.water_leak': { '+': { s: 'on', lc } } } };
    expect(homeChangesOf(known(), watched, live, null)).toHaveLength(1);
  });
});

describe('homeGoneOf', () => {
  const watched = new Map([
    ['binary_sensor.water_leak', new Set(['on'])],
    ['binary_sensor.front_door', new Set(['on'])],
  ]);

  it('forgets an entity Home Assistant removed, so one that comes back is a first sight', () => {
    const known = new Map<string, KnownEntity>([
      ['binary_sensor.water_leak', { state: 'on', name: 'Water leak' }],
      ['binary_sensor.front_door', { state: 'off', name: 'Front door' }],
    ]);
    expect(homeGoneOf(known, watched, { r: ['binary_sensor.water_leak', 'light.porch'] }, false)).toEqual([
      'binary_sensor.water_leak',
    ]);
    expect([...known.keys()]).toEqual(['binary_sensor.front_door']);
    const back = { a: { 'binary_sensor.water_leak': { s: 'off', lc: Date.now() / 1000 } } };
    expect(homeChangesOf(known, watched, back)).toEqual([]);
  });

  it('counts an entity the first list after subscribing leaves out as gone', () => {
    const known = new Map<string, KnownEntity>([
      ['binary_sensor.water_leak', { state: 'on', name: 'Water leak' }],
      ['binary_sensor.front_door', { state: 'off', name: 'Front door' }],
    ]);
    const first = { a: { 'binary_sensor.front_door': { s: 'off' } } };
    expect(homeGoneOf(known, watched, first, true)).toEqual(['binary_sensor.water_leak']);
    expect(known.has('binary_sensor.water_leak')).toBe(false);
    // Only the first list says what is there: a later addition says nothing about the others.
    expect(homeGoneOf(known, watched, first, false)).toEqual([]);
    expect(known.has('binary_sensor.front_door')).toBe(true);
  });
});

describe('forgetUnwatched', () => {
  it('forgets an entity no longer followed, so following it again makes no change from long ago', () => {
    const watched = new Map([['binary_sensor.water_leak', new Set(['on'])]]);
    const known = new Map<string, KnownEntity>([
      ['binary_sensor.water_leak', { state: 'off', name: 'Water leak' }],
      ['binary_sensor.front_door', { state: 'off', name: 'Front door' }],
    ]);
    forgetUnwatched(known, watched);
    expect([...known.keys()]).toEqual(['binary_sensor.water_leak']);
    // Followed again: its first state is a first sight.
    const again = new Map([...watched, ['binary_sensor.front_door', new Set(['on'])]]);
    const NOW = Date.now();
    const first = { a: { 'binary_sensor.front_door': { s: 'on', lc: NOW / 1000 } } };
    expect(homeChangesOf(known, again, first, NOW)).toEqual([]);
  });
});
