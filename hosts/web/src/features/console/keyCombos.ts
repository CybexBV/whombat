// Key combinations the console can send to a graphical guest (VNC, SPICE):
// the ones a browser or the desktop would otherwise catch. Each key has its
// X keysym (VNC) and its PC set-1 scancode (SPICE).

import { t } from '../../lib/i18n';

export interface ComboKey {
  keysym: number;
  scancode: number;
  /** KeyboardEvent.code, for noVNC. */
  code: string;
}

const CTRL: ComboKey = { keysym: 0xffe3, scancode: 0x1d, code: 'ControlLeft' };
const ALT: ComboKey = { keysym: 0xffe9, scancode: 0x38, code: 'AltLeft' };
const fkey = (n: number): ComboKey => ({ keysym: 0xffbe + n - 1, scancode: n <= 10 ? 0x3b + n - 1 : 0x57 + n - 11, code: `F${n}` });

export interface KeyCombo {
  id: string;
  label: string;
  keys: ComboKey[];
}

export const KEY_COMBOS: KeyCombo[] = [
  { id: 'ctrl-alt-del', label: 'Ctrl+Alt+Del', keys: [CTRL, ALT, { keysym: 0xffff, scancode: 0x53, code: 'Delete' }] },
  { id: 'ctrl-alt-backspace', label: 'Ctrl+Alt+Backspace', keys: [CTRL, ALT, { keysym: 0xff08, scancode: 0x0e, code: 'Backspace' }] },
  ...[1, 2, 3, 7].map((n) => ({ id: `ctrl-alt-f${n}`, label: `Ctrl+Alt+F${n}`, keys: [CTRL, ALT, fkey(n)] })),
  { id: 'alt-tab', label: 'Alt+Tab', keys: [ALT, { keysym: 0xff09, scancode: 0x0f, code: 'Tab' }] },
  { id: 'print', label: 'Print Screen', keys: [{ keysym: 0xff61, scancode: 0xe037, code: 'PrintScreen' }] },
];

/** Byte sequences of the terminal key row (phones have no Esc, Tab, Ctrl or arrows). */
export const TERMINAL_KEYS: { label: string; title: string; data: string }[] = [
  { label: 'Esc', title: 'Escape', data: '\x1b' },
  { label: 'Tab', title: 'Tab', data: '\t' },
  { label: '^C', title: 'Ctrl+C', data: '\x03' },
  { label: '^D', title: 'Ctrl+D', data: '\x04' },
  { label: '^Z', title: 'Ctrl+Z', data: '\x1a' },
  { label: '↑', title: t('Up|key'), data: '\x1b[A' },
  { label: '↓', title: t('Down|key'), data: '\x1b[B' },
  { label: '←', title: t('Left|key'), data: '\x1b[D' },
  { label: '→', title: t('Right|key'), data: '\x1b[C' },
];
