/**
 * A Home Assistant state that must hold for some minutes (docs/decisions/direct-automations.md): at its time it starts
 * a run only when the entity is still in the state and still from the change that started the wait.
 */
import type { HomeStateFacts } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { heldAtItsTime } from './home-waits';

const HA = 'con_homeassist1';
const definition = {
  triggers: [
    {
      kind: 'home_state' as const,
      connectionId: HA,
      entity: 'binary_sensor.water_leak',
      to: 'on',
      forMinutes: 10,
    },
  ],
};
const wet = 1_795_000_000.123456;
const facts: HomeStateFacts = {
  kind: 'home_state',
  connectionId: HA,
  entity: 'binary_sensor.water_leak',
  from: 'off',
  to: 'on',
  changedAt: wet,
};

describe('heldAtItsTime', () => {
  it('holds when the entity is still in the state from the same change', () => {
    expect(heldAtItsTime(definition, facts, { state: 'on', changedAt: wet })).toBe(true);
    expect(heldAtItsTime(definition, facts, { state: 'On', changedAt: wet })).toBe(true);
  });

  it('doesn’t hold when it is in another state now', () => {
    expect(heldAtItsTime(definition, facts, { state: 'off', changedAt: wet + 30 })).toBe(false);
  });

  it('doesn’t hold when it changed and came back in between, unseen', () => {
    expect(heldAtItsTime(definition, facts, { state: 'on', changedAt: wet + 240 })).toBe(false);
  });

  it('lets the state alone decide when either side has no time of change', () => {
    expect(
      heldAtItsTime(definition, { ...facts, changedAt: null }, { state: 'on', changedAt: wet + 240 }),
    ).toBe(true);
    expect(heldAtItsTime(definition, facts, { state: 'on', changedAt: null })).toBe(true);
  });
});
