import { jsonPointerGet } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { readOutput } from './run';

describe('a device read as a widget reads it', () => {
  it('answers the values by key at /values/<key>, with words for the agent', () => {
    const out = readOutput(
      [
        { key: 'room', label: 'Room', unit: '°C', value: 21, text: '21.0 °C', raw: '210' },
        { key: 'mode', label: 'Mode', value: 1, text: 'Heating' },
        {
          key: 'gone',
          label: 'Gone',
          value: null,
          text: '—',
          error: 'The device refused: that address doesn’t exist on it.',
        },
      ],
      new Date('2026-10-17T13:41:00Z'),
    );
    expect(jsonPointerGet(out.structured, '/values/room')).toBe(21);
    expect(jsonPointerGet(out.structured, '/units/room')).toBe('°C');
    expect(jsonPointerGet(out.structured, '/values/gone')).toBeNull();
    expect(out.content.split('\n').slice(0, 3)).toEqual([
      'Room: 21.0 °C',
      'Mode: Heating',
      'Gone: couldn’t read (The device refused: that address doesn’t exist on it.)',
    ]);
    expect(out.isError).toBe(false);
  });
});
