import { describe, expect, it } from 'vitest';
import {
  comboEvents,
  fkey,
  KEY_ROW,
  modifierKeys,
  modifierWords,
  SCREEN_FKEYS,
  SCREEN_KEYS,
  SHELL_KEYS,
  screenRowKeys,
  shellRowBytes,
  withShellModifiers,
} from './keyCombos';

const combo = (id: string) => [...SCREEN_KEYS, ...SCREEN_FKEYS].find((c) => c.id === id);

describe('Send keys for a VM’s screen (AP-1475)', () => {
  it('has the combinations a browser keeps, with their keysyms', () => {
    expect(SCREEN_KEYS.map((c) => c.label)).toEqual([
      'Ctrl+Alt+Del',
      'Ctrl+Alt+Backspace',
      'Alt+Tab',
      'Windows key',
      'PrtSc',
      'Esc',
      'Tab',
    ]);
    expect(combo('ctrl-alt-del')?.keys.map((k) => k.keysym)).toEqual([0xffe3, 0xffe9, 0xffff]);
    expect(combo('super')?.keys).toEqual([{ keysym: 0xffeb, code: 'MetaLeft' }]);
    expect(combo('print')?.keys).toEqual([{ keysym: 0xff61, code: 'PrintScreen' }]);
  });

  it('has Ctrl+Alt+F1 to F12', () => {
    expect(SCREEN_FKEYS).toHaveLength(12);
    expect(SCREEN_FKEYS[0]).toMatchObject({ id: 'ctrl-alt-f1', label: 'Ctrl+Alt+F1' });
    expect(combo('ctrl-alt-f12')?.keys[2]).toEqual({ keysym: 0xffc9, code: 'F12' });
    expect(fkey(7)).toEqual({ keysym: 0xffc4, code: 'F7' });
    expect(() => fkey(13)).toThrow(RangeError);
  });

  it('presses the keys in order and lets go in reverse', () => {
    const keys = combo('ctrl-alt-del')?.keys ?? [];
    expect(comboEvents(keys).map((e) => `${e.code}${e.down ? '↓' : '↑'}`)).toEqual([
      'ControlLeft↓',
      'AltLeft↓',
      'Delete↓',
      'Delete↑',
      'AltLeft↑',
      'ControlLeft↑',
    ]);
  });
});

describe('Send keys in a shell', () => {
  it('sends the bytes a terminal sends', () => {
    const bytes = Object.fromEntries(SHELL_KEYS.map((k) => [k.label, k.data]));
    expect(bytes).toEqual({
      'Ctrl+C': '\x03',
      'Ctrl+D': '\x04',
      'Ctrl+Z': '\x1a',
      Esc: '\x1b',
      Tab: '\t',
      'Up arrow': '\x1b[A',
      'Down arrow': '\x1b[B',
      'Right arrow': '\x1b[C',
      'Left arrow': '\x1b[D',
    });
  });
});

describe('the key row (AP-1476)', () => {
  it('is Esc, Tab, Ctrl, Alt and the arrows', () => {
    expect(KEY_ROW.map((k) => k.label)).toEqual(['Esc', 'Tab', 'Ctrl', 'Alt', '↑', '↓', '←', '→']);
  });

  it('sends row keys to a shell with the held modifiers, as xterm does', () => {
    expect(shellRowBytes('esc')).toBe('\x1b');
    expect(shellRowBytes('tab', { ctrl: false, alt: true })).toBe('\x1b\t');
    expect(shellRowBytes('up')).toBe('\x1b[A');
    expect(shellRowBytes('left', { ctrl: true, alt: false })).toBe('\x1b[1;5D');
    expect(shellRowBytes('right', { ctrl: false, alt: true })).toBe('\x1b[1;3C');
    expect(shellRowBytes('down', { ctrl: true, alt: true })).toBe('\x1b[1;7B');
  });

  it('turns the next typed key into a control character while Ctrl is held', () => {
    const ctrl = { ctrl: true, alt: false };
    expect(withShellModifiers('c', ctrl)).toBe('\x03');
    expect(withShellModifiers('D', ctrl)).toBe('\x04');
    expect(withShellModifiers('[', ctrl)).toBe('\x1b');
    expect(withShellModifiers(' ', ctrl)).toBe('\x00');
    expect(withShellModifiers('?', ctrl)).toBe('\x7f');
    expect(withShellModifiers('1', ctrl)).toBe('1');
    // A phone keyboard's whole word is left alone.
    expect(withShellModifiers('hello', ctrl)).toBe('hello');
    expect(withShellModifiers('x', { ctrl: false, alt: true })).toBe('\x1bx');
    expect(withShellModifiers('b', { ctrl: true, alt: true })).toBe('\x1b\x02');
    expect(withShellModifiers('x', { ctrl: false, alt: false })).toBe('x');
  });

  it('holds the modifiers before a row key on a VM’s screen', () => {
    expect(screenRowKeys('esc').map((k) => k.code)).toEqual(['Escape']);
    expect(screenRowKeys('right', { ctrl: true, alt: true }).map((k) => k.code)).toEqual([
      'ControlLeft',
      'AltLeft',
      'ArrowRight',
    ]);
    expect(modifierKeys({ ctrl: false, alt: true }).map((k) => k.code)).toEqual(['AltLeft']);
    expect(modifierWords({ ctrl: true, alt: true })).toBe('Ctrl+Alt+');
  });
});
