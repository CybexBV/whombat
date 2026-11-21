import { describe, expect, it } from 'vitest';
import { atPointer, decodeRegisters, encodeRegisters, registersFor, ValueError, withPointer } from './values';

describe('register values', () => {
  it('decodes each type, scaled', () => {
    expect(decodeRegisters([215], 'u16', { scale: 0.1 })).toBe(21.5);
    expect(decodeRegisters([0xffec], 's16', { scale: 0.1 })).toBe(-2);
    expect(decodeRegisters([0x0001, 0x0002], 'u32')).toBe(65538);
    expect(decodeRegisters([0x0002, 0x0001], 'u32', { wordOrder: 'little' })).toBe(65538);
    expect(decodeRegisters([0xffff, 0xfffe], 's32')).toBe(-2);
    expect(decodeRegisters([0x3f99, 0x999a], 'f32')).toBeCloseTo(1.2, 6);
    expect(decodeRegisters([1], 'bool')).toBe(true);
    expect(decodeRegisters([0], 'bool')).toBe(false);
  });

  it('encodes back, refusing what doesn’t fit', () => {
    expect(encodeRegisters(21.5, 's16', { scale: 0.1 })).toEqual([215]);
    expect(encodeRegisters(-2, 's16', { scale: 0.1 })).toEqual([0xffec]);
    expect(encodeRegisters(65538, 'u32')).toEqual([1, 2]);
    expect(encodeRegisters(65538, 'u32', { wordOrder: 'little' })).toEqual([2, 1]);
    expect(encodeRegisters(true, 'bool')).toEqual([1]);
    const f = encodeRegisters(1.2, 'f32');
    expect(decodeRegisters(f, 'f32')).toBeCloseTo(1.2, 6);
    expect(() => encodeRegisters(21.25, 's16', { scale: 0.1 })).toThrow(ValueError);
    expect(() => encodeRegisters(-1, 'u16')).toThrow('outside what the device can hold');
    expect(() => encodeRegisters('21' as unknown as number, 'u16')).toThrow('a number');
    expect(() => encodeRegisters(1, 'bool')).toThrow('on or off');
  });

  it('knows how many registers a type takes', () => {
    expect(registersFor('f32')).toBe(2);
    expect(registersFor('s16')).toBe(1);
    expect(registersFor('bool')).toBe(1);
  });

  it('reads and writes JSON pointers', () => {
    const doc = { a: { 'b/c': [1, { d: 2 }] }, 'x~y': 3 };
    expect(atPointer(doc, '/a/b~1c/1/d')).toBe(2);
    expect(atPointer(doc, '/x~0y')).toBe(3);
    expect(atPointer(doc, '/a/missing')).toBeUndefined();
    expect(atPointer(doc, '')).toBe(doc);
    expect(atPointer(doc, '/a/b~1c/01')).toBeUndefined();
    expect(withPointer({ mode: 'eco' }, '/settings/temp', 21)).toEqual({
      mode: 'eco',
      settings: { temp: 21 },
    });
    expect(withPointer(null, '/value', true)).toEqual({ value: true });
  });
});
