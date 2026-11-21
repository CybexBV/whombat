import { describe, expect, it } from 'vitest';
import { isJsonPointer, limitsProblem, limitsSetProblems, limitText, narrower, pointerLabel } from './limits';

describe('connection tool limits', () => {
  const room = { args: { '/value': { min: 16, max: 24 } } };
  const words = () => ({ label: 'Room temperature', unit: '°C' });

  it('passes values within the limits and left-out arguments', () => {
    expect(limitsProblem(room, { value: 21 }, words)).toBeNull();
    expect(limitsProblem(room, { value: 16 }, words)).toBeNull();
    expect(limitsProblem(room, { value: 24 }, words)).toBeNull();
    expect(limitsProblem(room, {}, words)).toBeNull();
    expect(limitsProblem(null, { value: 99 })).toBeNull();
  });

  it('refuses values outside, in a sentence to pass on', () => {
    expect(limitsProblem(room, { value: 30 }, words)).toBe(
      'Room temperature is limited to 16–24 °C, so 30 °C wasn’t sent.',
    );
    expect(limitsProblem(room, { value: -5 }, words)).toBe(
      'Room temperature is limited to 16–24 °C, so −5 °C wasn’t sent.',
    );
    expect(limitsProblem({ args: { '/value': { max: 60 } } }, { value: 70 }, () => ({ unit: '%' }))).toBe(
      'Value is limited to 60% or less, so 70% wasn’t sent.',
    );
  });

  it('checks a numeric string as the number a service would read', () => {
    expect(limitsProblem(room, { value: '30' }, words)).toMatch(/so 30 °C wasn’t sent/);
    expect(limitsProblem(room, { value: '21' }, words)).toBeNull();
    expect(limitsProblem(room, { value: 'warm' }, words)).toBe(
      'Room temperature has to be a number, so “warm” wasn’t sent.',
    );
    expect(limitsProblem(room, { value: true }, words)).toBe(
      'Room temperature has to be a number, so true wasn’t sent.',
    );
  });

  it('checks steps from the minimum', () => {
    const half = { args: { '/value': { min: 16, max: 24, step: 0.5 } } };
    expect(limitsProblem(half, { value: 21.5 }, words)).toBeNull();
    expect(limitsProblem(half, { value: 21.3 }, words)).toBe(
      'Room temperature goes in steps of 0.5 °C, so 21.3 °C wasn’t sent.',
    );
  });

  it('checks choices, with their labels', () => {
    const mode = { args: { '/mode': { choices: [1, 2] } } };
    const labels = (v: unknown) => ({ 1: 'Heating', 2: 'Cooling' })[v as 1 | 2];
    expect(limitsProblem(mode, { mode: 1 }, () => ({ label: 'Mode', choiceLabel: labels }))).toBeNull();
    expect(limitsProblem(mode, { mode: 0 }, () => ({ label: 'Mode', choiceLabel: labels }))).toBe(
      'Mode may only be Heating or Cooling, so 0 wasn’t sent.',
    );
    expect(
      limitsProblem({ args: { '/hvac_mode': { choices: ['heat', 'off'] } } }, { hvac_mode: 'cool' }),
    ).toBe('Hvac mode may only be “heat” or “off”, so “cool” wasn’t sent.');
  });

  it('reads nested pointers', () => {
    const l = { args: { '/data/brightness': { max: 50 } } };
    expect(limitsProblem(l, { data: { brightness: 80 } })).toBe(
      'Brightness is limited to 50 or less, so 80 wasn’t sent.',
    );
  });

  it('says a limit the way the card does', () => {
    expect(limitText({ min: 16, max: 24 }, { unit: '°C' })).toBe('Only between 16 and 24 °C');
    expect(limitText({ min: 16 }, { unit: '°C' })).toBe('Only 16 °C or more');
    expect(limitText({ max: 24 }, { unit: '°C' })).toBe('Only up to 24 °C');
    expect(limitText({ min: 16, max: 24, step: 0.5 }, { unit: '°C' })).toBe(
      'Only between 16 and 24 °C, in steps of 0.5 °C',
    );
    expect(limitText({ choices: [true, false] }, { choiceLabel: (v) => (v ? 'On' : 'Off') })).toBe(
      'Only On or Off',
    );
    expect(limitText({})).toBeNull();
  });

  it('checks limits a person sets', () => {
    expect(limitsSetProblems({ args: { '/value': { min: 16, max: 24 } } })).toBeNull();
    expect(limitsSetProblems({ args: { value: { min: 1 } } })).toEqual({
      'args.value': 'Name the argument as a JSON pointer, like /value.',
    });
    expect(limitsSetProblems({ args: { '/v': { min: 5, max: 1 } } })).toEqual({
      'args./v': 'The lowest value is above the highest.',
    });
    expect(limitsSetProblems({ args: { '/v': { choices: [1], min: 0 } } })).toEqual({
      'args./v': 'Use choices or a range, not both.',
    });
    expect(limitsSetProblems({ args: { '/v': {} } })).toEqual({ 'args./v': 'This limit says nothing.' });
  });

  it('knows pointers and names them', () => {
    expect(isJsonPointer('/a/b~1c')).toBe(true);
    expect(isJsonPointer('/a~2')).toBe(false);
    expect(isJsonPointer('a')).toBe(false);
    expect(pointerLabel('/data/targetTemp')).toBe('target temp');
  });

  it('takes the narrower of two limits', () => {
    expect(narrower({ min: 10, max: 30 }, { min: 16, max: 24 })).toEqual({ min: 16, max: 24 });
    expect(narrower(undefined, { max: 1 })).toEqual({ max: 1 });
  });
});
