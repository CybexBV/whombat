import { describe, expect, it } from 'vitest';
import { actionValueProblem, modbusSpans, readingText } from './driver';
import type { DeviceAction, DeviceReading } from './types';

const reading = (
  key: string,
  address: number,
  extra: Partial<DeviceReading['modbus']> = {},
): DeviceReading => ({
  key,
  label: key,
  modbus: { table: 'input', address, type: 's16', ...extra },
});

describe('device driver words and plans', () => {
  it('reads registers close together in one request, bridging small gaps', () => {
    const spans = modbusSpans([
      reading('room', 0),
      reading('water', 1),
      reading('power', 4, { type: 'f32' }),
      reading('far', 40),
      { key: 'boost', label: 'boost', modbus: { table: 'coil', address: 0, type: 'bool' } },
    ]);
    expect(spans.map((s) => [s.table, s.start, s.count, s.readings.length])).toEqual([
      ['coil', 0, 1, 1],
      ['input', 0, 6, 3],
      ['input', 40, 1, 1],
    ]);
  });

  it('says a value the way a person reads it', () => {
    expect(
      readingText({ unit: '°C', modbus: { table: 'input', address: 0, type: 's16', scale: 0.1 } }, 21),
    ).toBe('21.0 °C');
    expect(readingText({ unit: '°C', modbus: { table: 'input', address: 0, type: 's16' } }, -3)).toBe(
      '−3 °C',
    );
    expect(readingText({ unit: 'kW', modbus: { table: 'input', address: 4, type: 'f32' } }, 1.2)).toBe(
      '1.2 kW',
    );
    expect(readingText({ choices: [{ value: 1, label: 'Heating' }] }, 1)).toBe('Heating');
    expect(readingText({}, true)).toBe('On');
    expect(readingText({ unit: '%' }, 'x')).toBe('x%');
    expect(readingText({}, null)).toBe('—');
  });

  it('keeps an action to the profile’s own range', () => {
    const room: DeviceAction = {
      key: 'room_setpoint',
      label: 'Room temperature',
      description: 'The temperature the room is heated to.',
      valueType: 'number',
      min: 12,
      max: 28,
      step: 0.5,
      modbus: { table: 'holding', address: 100, type: 's16', scale: 0.1 },
    };
    expect(actionValueProblem(room, 21.5)).toBeNull();
    expect(actionValueProblem(room, 30)).toBe('Room temperature goes from 12 to 28 on this device.');
    expect(actionValueProblem(room, 21.2)).toBe('Room temperature goes in steps of 0.5.');
    expect(actionValueProblem(room, '21')).toBe('Room temperature is a number.');
    const boost: DeviceAction = {
      key: 'boost',
      label: 'Hot water boost',
      description: 'Heats the water once now.',
      valueType: 'boolean',
      modbus: { table: 'coil', address: 0, type: 'bool' },
    };
    expect(actionValueProblem(boost, true)).toBeNull();
    expect(actionValueProblem(boost, 1)).toBe('Hot water boost is on or off.');
    const mode: DeviceAction = {
      key: 'mode',
      label: 'Mode',
      description: 'What it does.',
      valueType: 'choice',
      choices: [
        { value: 1, label: 'Heating' },
        { value: 2, label: 'Cooling' },
      ],
      modbus: { table: 'holding', address: 102, type: 'u16' },
    };
    expect(actionValueProblem(mode, 2)).toBeNull();
    expect(actionValueProblem(mode, 3)).toBe('Mode is one of: Heating, Cooling.');
  });
});
