import { describe, expect, it } from 'vitest';
import { pulseRange } from './pulse';

describe('pulseRange', () => {
  const linear = (t: number) => t;

  it('starts and ends at `from` and peaks at `to` halfway', () => {
    const { inputRange, outputRange } = pulseRange(0.35, 0.9, linear, 4);
    expect(inputRange[0]).toBe(0);
    expect(inputRange.at(-1)).toBe(1);
    expect(outputRange[0]).toBe(0.35);
    expect(outputRange.at(-1)).toBe(0.35);
    expect(outputRange[inputRange.indexOf(0.5)]).toBe(0.9);
  });

  it('runs the other way for the middle dot', () => {
    const { outputRange } = pulseRange(0.9, 0.35, linear, 4);
    expect(outputRange[0]).toBe(0.9);
    expect(Math.min(...outputRange)).toBe(0.35);
  });

  it('is an input range interpolate accepts (strictly increasing) with one output per input', () => {
    const { inputRange, outputRange } = pulseRange(0, 1, (t) => t * t);
    expect(outputRange).toHaveLength(inputRange.length);
    for (let i = 1; i < inputRange.length; i++)
      expect(inputRange[i] as number).toBeGreaterThan(inputRange[i - 1] as number);
  });

  it('eases each half', () => {
    const { outputRange } = pulseRange(0, 1, (t) => t * t, 2);
    // A quarter of the way: half of the rise in time, a quarter of it in value.
    expect(outputRange[1]).toBe(0.25);
  });
});
