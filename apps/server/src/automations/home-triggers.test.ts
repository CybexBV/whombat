/**
 * What Whombat follows of Home Assistant for automations that start on it (docs/decisions/direct-automations.md): only
 * the entities and states live automations name, and only changes into or out of those states are signed.
 */
import { describe, expect, it } from 'vitest';
import { homeChangesOf, listenedOf } from './home-triggers';

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

  it('signs a change that happened while the socket was away', () => {
    const known = new Map([['binary_sensor.water_leak', { state: 'off', name: 'Water leak' }]]);
    const again = { a: { 'binary_sensor.water_leak': { s: 'on' } } };
    expect(homeChangesOf(known, watched, again)).toMatchObject([
      { from: 'off', to: 'on', name: 'Water leak' },
    ]);
  });
});
