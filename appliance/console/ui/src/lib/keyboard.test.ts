import { describe, expect, it } from 'vitest';
import { allChars, KEYBOARD_START, type Key, keyRows, press } from './keyboard';

const key = (rows: Key[][], id: string): Key => {
  const k = rows.flat().find((x) => x.id === id || x.char === id);
  if (!k) throw new Error(`no key ${id}`);
  return k;
};

describe('the screen’s keyboard (HD-09)', () => {
  it('types every printable ASCII character a Wi-Fi password may have', () => {
    const all = allChars();
    for (let c = 0x20; c <= 0x7e; c++) expect(all.has(String.fromCharCode(c))).toBe(true);
  });

  it('has rows of ten key widths at most', () => {
    for (const page of ['letters', 'symbols'] as const) {
      for (const row of keyRows(page, 'off')) {
        expect(row.reduce((n, k) => n + k.width, 0)).toBeLessThanOrEqual(10);
      }
    }
  });

  it('shifts one letter, locks on a second press, and switches pages', () => {
    let kb = KEYBOARD_START;
    let field = { value: '', start: 0, end: 0 };
    const tap = (id: string) => {
      ({ kb, field } = press(kb, field, key(keyRows(kb.page, kb.shift), id), 64));
    };
    tap('shift');
    tap('H');
    tap('o');
    expect(field.value).toBe('Ho');
    tap('shift');
    tap('shift');
    expect(kb.shift).toBe('lock');
    tap('M');
    tap('E');
    expect(field.value).toBe('HoME');
    tap('shift');
    expect(kb.shift).toBe('off');
    tap('symbols');
    tap('!');
    tap('1');
    expect(kb.page).toBe('symbols');
    tap('letters');
    tap('space');
    expect(field.value).toBe('HoME!1 ');
    tap('backspace');
    expect(field.value).toBe('HoME!1');
  });

  it('inserts at the caret, replaces a selection, and stops at the limit', () => {
    const rows = keyRows('letters', 'off');
    const x = key(rows, 'x');
    expect(press(KEYBOARD_START, { value: 'abcd', start: 2, end: 2 }, x, 64).field).toEqual({
      value: 'abxcd',
      start: 3,
      end: 3,
    });
    expect(press(KEYBOARD_START, { value: 'abcd', start: 1, end: 3 }, x, 64).field.value).toBe('axd');
    expect(
      press(KEYBOARD_START, { value: 'abcd', start: 1, end: 3 }, key(rows, 'backspace'), 64).field.value,
    ).toBe('ad');
    expect(
      press(KEYBOARD_START, { value: 'abc', start: 0, end: 0 }, key(rows, 'backspace'), 64).field.value,
    ).toBe('abc');
    expect(press(KEYBOARD_START, { value: 'abcd', start: 4, end: 4 }, x, 4).field.value).toBe('abcd');
  });
});
