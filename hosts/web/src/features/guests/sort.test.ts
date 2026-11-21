import { describe, expect, it } from 'vitest';
import { nextSort, parseSort } from './GuestsPage';

describe('guest list sorting', () => {
  it('reads the hub sort parameter', () => {
    expect(parseSort('cpu')).toEqual({ key: 'cpu', desc: true });
    expect(parseSort('+cpu')).toEqual({ key: 'cpu', desc: false });
    expect(parseSort('name')).toEqual({ key: 'name', desc: false });
    expect(parseSort('-name')).toEqual({ key: 'name', desc: true });
  });
  it('flips the same column and starts others in their natural direction', () => {
    expect(nextSort('cpu', 'cpu')).toBe('+cpu');
    expect(nextSort('+cpu', 'cpu')).toBe('cpu');
    expect(nextSort('cpu', 'name')).toBe('name');
    expect(nextSort('name', 'name')).toBe('-name');
    expect(nextSort('-name', 'server')).toBe('server');
  });
});
