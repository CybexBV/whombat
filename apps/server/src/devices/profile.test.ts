import { type DeviceAction, DeviceProfile, type DeviceProfileInput } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  actionUnit,
  deviceHandleBase,
  deviceNoun,
  deviceProfileProblems,
  deviceSlug,
  deviceToolDefinitions,
  profileHash,
  proposedChoice,
  toolLimitsOf,
} from './profile';
import { choiceProblem, shortDeviceName } from './skills';

const input: DeviceProfileInput = {
  name: 'Daikin Altherma heat pump',
  vendor: 'Daikin',
  model: 'Altherma',
  driver: 'modbus_tcp',
  readings: [
    {
      key: 'room',
      label: 'Room',
      unit: '°C',
      modbus: { table: 'input', address: 0, type: 's16', scale: 0.1 },
    },
    {
      key: 'set_to',
      label: 'Set to',
      unit: '°C',
      modbus: { table: 'holding', address: 100, type: 's16', scale: 0.1 },
    },
  ],
  actions: [
    {
      key: 'room_setpoint',
      label: 'Room temperature',
      description: 'The temperature the room is heated to.',
      modbus: { table: 'holding', address: 100, type: 's16', scale: 0.1 },
      valueType: 'number',
      min: 12,
      max: 28,
      step: 0.5,
    },
    {
      key: 'boost',
      label: 'Hot water boost',
      description: 'Heats the water once.',
      modbus: { table: 'coil', address: 0, type: 'bool' },
      valueType: 'boolean',
      sensitive: true,
    },
  ],
};
const profile = DeviceProfile.parse(input);

describe('device profiles', () => {
  it('accepts a sound profile', () => {
    expect(deviceProfileProblems(profile)).toEqual([]);
  });

  it('says what to fix, in sentences', () => {
    const bad = DeviceProfile.parse({
      ...input,
      readings: [
        ...(input.readings ?? []),
        { key: 'room', label: 'Again', modbus: { table: 'coil', address: 1, type: 'u16' } },
        { key: 'web', label: 'Web', http: { method: 'GET', path: '/x', pointer: '/a' } },
      ],
      actions: [
        {
          key: 'read',
          label: 'Read',
          description: 'No.',
          modbus: { table: 'holding', address: 1, type: 'u16' },
          valueType: 'number',
        },
        {
          key: 'pick',
          label: 'Pick',
          description: 'A choice.',
          modbus: { table: 'holding', address: 2, type: 'u16' },
          valueType: 'choice',
        },
        {
          key: 'coil',
          label: 'Coil',
          description: 'A coil.',
          modbus: { table: 'coil', address: 3, type: 'bool' },
          valueType: 'number',
          min: 0,
          max: 1,
        },
      ],
    });
    expect(deviceProfileProblems(bad)).toEqual([
      'Two readings are called “room”.',
      'Reading “room”: a coil is a bool.',
      'Reading “web” needs its Modbus register.',
      'An action can’t be called “read”.',
      'Action “read”: give the range the manual allows (min and max).',
      'Action “pick” is a choice: list its choices.',
      'Action “coil”: a coil is on or off, not a number.',
    ]);
  });

  it('names the device, its handle and its tools', () => {
    expect(deviceSlug('Daikin Altherma heat pump')).toBe('daikin_altherma_heat');
    expect(deviceSlug('Heat pump')).toBe('heat_pump');
    expect(deviceSlug('3D printer')).toBe('d_3d_printer');
    expect(deviceHandleBase('Heat pump')).toBe('heat-pump');
    expect(shortDeviceName(profile)).toBe('Heat pump');
    expect(deviceNoun('Heat pump')).toBe('the heat pump');
    expect(deviceNoun('SolarEdge inverter')).toBe('the SolarEdge inverter');
    const tools = deviceToolDefinitions(profile, 'heat_pump');
    expect(tools.map((x) => [x.name, x.access, x.origin, x.actionKey])).toEqual([
      ['heat_pump_read', 'read', 'device', null],
      ['heat_pump_room_setpoint', 'write', 'device', 'room_setpoint'],
      ['heat_pump_boost', 'write', 'device-sensitive', 'boost'],
    ]);
    expect(tools[1]?.inputSchema).toMatchObject({
      required: ['value'],
      properties: { value: { type: 'number', minimum: 12, maximum: 28, multipleOf: 0.5 } },
    });
  });

  it('takes an action’s unit from the reading of the same register', () => {
    expect(actionUnit(profile, profile.actions[0] as never)).toBe('°C');
    expect(actionUnit(profile, profile.actions[1] as never)).toBeUndefined();
  });

  it('prefers an action’s own unit and checks a reading’s words for its codes (contracts 0.80.1)', () => {
    expect(actionUnit(profile, { ...(profile.actions[0] as DeviceAction), unit: 'K' })).toBe('K');
    const doubled = DeviceProfile.parse({
      ...input,
      readings: [
        ...(input.readings ?? []),
        {
          key: 'mode',
          label: 'Mode',
          modbus: { table: 'holding', address: 40, type: 'u16' },
          choices: [
            { value: 1, label: 'Heating' },
            { value: 1, label: 'Cooling' },
          ],
        },
      ],
    });
    expect(deviceProfileProblems(doubled).some((p) => p.startsWith('Reading “mode”'))).toBe(true);
  });

  it('proposes Ask with the manual’s range, Off for a sensitive action', () => {
    expect(proposedChoice(profile.actions[0] as never)).toEqual({
      tier: 'ask',
      limits: { min: 12, max: 28, step: 0.5 },
    });
    expect(proposedChoice(profile.actions[1] as never)).toEqual({ tier: 'off' });
    expect(toolLimitsOf({ min: 16, max: 24 })).toEqual({ args: { '/value': { min: 16, max: 24 } } });
    expect(toolLimitsOf(undefined)).toBeNull();
  });

  it('checks the person’s limits against the action', () => {
    const room = profile.actions[0] as never;
    const boost = profile.actions[1] as never;
    expect(choiceProblem(room, { tier: 'can', limits: { min: 16, max: 24 } })).toBeNull();
    expect(choiceProblem(room, { tier: 'can', limits: { min: 30 } })).toBe(
      'Room temperature can’t go above 28.',
    );
    expect(choiceProblem(room, { tier: 'can', limits: { choices: [1] } })).toBe(
      'Room temperature is a number: give a range, not choices.',
    );
    expect(choiceProblem(boost, { tier: 'can', limits: { choices: [true] } })).toBeNull();
    expect(choiceProblem(boost, { tier: 'can', limits: { max: 1 } })).toBe(
      'Hot water boost has no range; pick from its choices.',
    );
  });

  it('hashes the profile: a rewrite is a new hash', () => {
    const again = DeviceProfile.parse({ ...input, model: 'Altherma 3' });
    expect(profileHash(profile)).toMatch(/^[0-9a-f]{64}$/);
    expect(profileHash(DeviceProfile.parse(input))).toBe(profileHash(profile));
    expect(profileHash(again)).not.toBe(profileHash(profile));
  });
});
