/**
 * The screen's own keyboard (Whombat hardware-support.md HD-09; CG-111): touch-only machines, and a Z13 without its
 * cover, have no keys, and Chromium in the kiosk brings no keyboard of its own. Two pages cover every printable ASCII
 * character a Wi-Fi password may have (`WifiPassphrase`): letters with the digits above them and a shift, and the 32
 * symbols; space and backspace on both. The keys insert at the field's caret (a real keyboard works on the same field).
 */

export type KeyPage = 'letters' | 'symbols';
/** Shift: off, for the next letter only, or locked (a second press). */
export type Shift = 'off' | 'once' | 'lock';

export interface Key {
  /** What it types (a character), or what it does. */
  id: string;
  kind: 'char' | 'shift' | 'backspace' | 'page' | 'space';
  /** The character it types now (shift applied). */
  char?: string;
  /** In key widths (a row is 10). */
  width: number;
}

const chars = (s: string): Key[] => [...s].map((c) => ({ id: c, kind: 'char', char: c, width: 1 }));
const DIGITS = chars('1234567890');
const SHIFT: Key = { id: 'shift', kind: 'shift', width: 1.5 };
const BACK: Key = { id: 'backspace', kind: 'backspace', width: 1.5 };
const SPACE: Key = { id: 'space', kind: 'space', char: ' ', width: 6 };

/** The rows of a page. On `letters` the letters are upper case while shift is on. */
export function keyRows(page: KeyPage, shift: Shift): Key[][] {
  if (page === 'symbols') {
    return [
      DIGITS,
      chars('!@#$%^&*()'),
      chars('-_=+[]{}\\|'),
      [...chars(';:\'",./?'), { ...BACK, width: 2 }],
      [{ id: 'letters', kind: 'page', width: 2 }, ...chars('`~'), { ...SPACE, width: 4 }, ...chars('<>')],
    ];
  }
  const up = shift !== 'off';
  const letters = (s: string) => chars(up ? s.toUpperCase() : s);
  return [
    DIGITS,
    letters('qwertyuiop'),
    letters('asdfghjkl'),
    [SHIFT, ...letters('zxcvbnm'), BACK],
    [{ id: 'symbols', kind: 'page', width: 2 }, SPACE, ...chars('.-')],
  ];
}

/** Every character the keyboard can type. */
export function allChars(): Set<string> {
  const out = new Set<string>();
  for (const page of ['letters', 'symbols'] as const) {
    for (const shift of ['off', 'once'] as const) {
      for (const row of keyRows(page, shift)) for (const k of row) if (k.char) out.add(k.char);
    }
  }
  return out;
}

export interface KeyboardState {
  page: KeyPage;
  shift: Shift;
}

export const KEYBOARD_START: KeyboardState = { page: 'letters', shift: 'off' };

export interface Field {
  value: string;
  /** The selection (caret when start === end). */
  start: number;
  end: number;
}

/**
 * A key pressed: the keyboard's next state and the field's (text inserted at the caret or replacing the selection,
 * cut at `max` characters; backspace removes the selection or the character before the caret).
 */
export function press(
  kb: KeyboardState,
  field: Field,
  key: Key,
  max: number,
): { kb: KeyboardState; field: Field } {
  const start = Math.max(0, Math.min(field.start, field.value.length));
  const end = Math.max(start, Math.min(field.end, field.value.length));
  switch (key.kind) {
    case 'shift':
      return {
        kb: { ...kb, shift: kb.shift === 'off' ? 'once' : kb.shift === 'once' ? 'lock' : 'off' },
        field,
      };
    case 'page':
      return { kb: { page: key.id === 'symbols' ? 'symbols' : 'letters', shift: 'off' }, field };
    case 'backspace': {
      if (start !== end) {
        return {
          kb,
          field: { value: field.value.slice(0, start) + field.value.slice(end), start, end: start },
        };
      }
      if (start === 0) return { kb, field };
      // A character before the caret, whole (a surrogate pair counts as one).
      const before = [...field.value.slice(0, start)];
      before.pop();
      const head = before.join('');
      return { kb, field: { value: head + field.value.slice(end), start: head.length, end: head.length } };
    }
    default: {
      const c = key.char ?? '';
      const value = field.value.slice(0, start) + c + field.value.slice(end);
      if ([...value].length > max) return { kb, field };
      const at = start + c.length;
      const letter = /^[A-Za-z]$/.test(c);
      return {
        kb: letter && kb.shift === 'once' ? { ...kb, shift: 'off' } : kb,
        field: { value, start: at, end: at },
      };
    }
  }
}
