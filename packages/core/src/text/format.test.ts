import { describe, expect, it } from 'vitest';
import { formatEuro } from './format.js';

describe('formatEuro', () => {
  it('writes euros in Dutch notation', () => {
    expect(formatEuro(1)).toBe('€0,01');
    expect(formatEuro(123456)).toBe('€1.234,56');
    expect(formatEuro(123456, { space: true })).toBe('€ 1.234,56');
    expect(formatEuro(-2400)).toBe('-€24,00');
  });

  it('takes the sign from the rounded cents, so less than half a cent below zero is no minus', () => {
    expect(formatEuro(-0.4)).toBe('€0,00');
    expect(formatEuro(-0.6)).toBe('-€0,01');
  });
});
