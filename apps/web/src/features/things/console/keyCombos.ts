/**
 * The keys a console can send that the browser, the desktop or a phone keyboard would otherwise keep (ported from
 * Rackoon's `features/console/keyCombos.ts`; AP-1475, AP-1476): **Send keys** for a VM's screen (X keysyms and
 * `KeyboardEvent.code`s for noVNC: pressed in order, let go in reverse) and for a shell (the bytes a terminal sends),
 * and the **key row** for narrow screens, whose Ctrl and Alt stay down for the next key (sticky). Pure, so the
 * combinations are unit-tested.
 */

export interface ComboKey {
  /** X11 keysym (noVNC's `sendKey`). */
  keysym: number;
  /** `KeyboardEvent.code`, so the guest sees the physical key. */
  code: string;
}

export const CTRL: ComboKey = { keysym: 0xffe3, code: 'ControlLeft' };
export const ALT: ComboKey = { keysym: 0xffe9, code: 'AltLeft' };
const SUPER: ComboKey = { keysym: 0xffeb, code: 'MetaLeft' };
const DELETE: ComboKey = { keysym: 0xffff, code: 'Delete' };
const BACKSPACE: ComboKey = { keysym: 0xff08, code: 'Backspace' };
const TAB: ComboKey = { keysym: 0xff09, code: 'Tab' };
const ESC: ComboKey = { keysym: 0xff1b, code: 'Escape' };
const PRINT: ComboKey = { keysym: 0xff61, code: 'PrintScreen' };
const UP: ComboKey = { keysym: 0xff52, code: 'ArrowUp' };
const DOWN: ComboKey = { keysym: 0xff54, code: 'ArrowDown' };
const LEFT: ComboKey = { keysym: 0xff51, code: 'ArrowLeft' };
const RIGHT: ComboKey = { keysym: 0xff53, code: 'ArrowRight' };

/** F1…F12: keysyms 0xffbe…0xffc9. */
export function fkey(n: number): ComboKey {
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new RangeError(`no F${n} key`);
  return { keysym: 0xffbe + n - 1, code: `F${n}` };
}

export interface KeyCombo {
  id: string;
  /** What the menu shows and the notice says (“Sent Ctrl+Alt+Del.”). */
  label: string;
  keys: ComboKey[];
}

/** Send keys on a VM's screen (the function keys are their own row, `SCREEN_FKEYS`). */
export const SCREEN_KEYS: readonly KeyCombo[] = [
  { id: 'ctrl-alt-del', label: 'Ctrl+Alt+Del', keys: [CTRL, ALT, DELETE] },
  { id: 'ctrl-alt-backspace', label: 'Ctrl+Alt+Backspace', keys: [CTRL, ALT, BACKSPACE] },
  { id: 'alt-tab', label: 'Alt+Tab', keys: [ALT, TAB] },
  { id: 'super', label: 'Windows key', keys: [SUPER] },
  { id: 'print', label: 'PrtSc', keys: [PRINT] },
  { id: 'esc', label: 'Esc', keys: [ESC] },
  { id: 'tab', label: 'Tab', keys: [TAB] },
];

/** Ctrl+Alt+F1…F12 (a Linux guest's text consoles). */
export const SCREEN_FKEYS: readonly KeyCombo[] = Array.from({ length: 12 }, (_, i) => ({
  id: `ctrl-alt-f${i + 1}`,
  label: `Ctrl+Alt+F${i + 1}`,
  keys: [CTRL, ALT, fkey(i + 1)],
}));

export interface KeyEventStep {
  keysym: number;
  code: string;
  down: boolean;
}

/** The key events of a combination: every key down in order, then up in reverse (as a person presses them). */
export function comboEvents(keys: readonly ComboKey[]): KeyEventStep[] {
  return [
    ...keys.map((k) => ({ keysym: k.keysym, code: k.code, down: true })),
    ...[...keys].reverse().map((k) => ({ keysym: k.keysym, code: k.code, down: false })),
  ];
}

export interface ShellKey {
  id: string;
  label: string;
  /** The bytes the terminal sends. */
  data: string;
}

/** Send keys in a shell. */
export const SHELL_KEYS: readonly ShellKey[] = [
  { id: 'ctrl-c', label: 'Ctrl+C', data: '\x03' },
  { id: 'ctrl-d', label: 'Ctrl+D', data: '\x04' },
  { id: 'ctrl-z', label: 'Ctrl+Z', data: '\x1a' },
  { id: 'esc', label: 'Esc', data: '\x1b' },
  { id: 'tab', label: 'Tab', data: '\t' },
  { id: 'up', label: 'Up arrow', data: '\x1b[A' },
  { id: 'down', label: 'Down arrow', data: '\x1b[B' },
  { id: 'right', label: 'Right arrow', data: '\x1b[C' },
  { id: 'left', label: 'Left arrow', data: '\x1b[D' },
];

/* The key row ---------------------------------------------------------------------------------------- */

export type RowKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right';

export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

/** The row in order: Esc, Tab, Ctrl, Alt, then the arrows. */
export const KEY_ROW: readonly (
  | { key: RowKey; label: string; name: string }
  | { mod: keyof Modifiers; label: string; name: string }
)[] = [
  { key: 'esc', label: 'Esc', name: 'Esc' },
  { key: 'tab', label: 'Tab', name: 'Tab' },
  { mod: 'ctrl', label: 'Ctrl', name: 'Ctrl' },
  { mod: 'alt', label: 'Alt', name: 'Alt' },
  { key: 'up', label: '↑', name: 'Up arrow' },
  { key: 'down', label: '↓', name: 'Down arrow' },
  { key: 'left', label: '←', name: 'Left arrow' },
  { key: 'right', label: '→', name: 'Right arrow' },
];

const ARROW_FINAL: Record<'up' | 'down' | 'left' | 'right', string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
};

/**
 * The bytes a row key sends to a shell with the sticky modifiers: arrows as xterm does (`ESC [ 1 ; m X`, m = 1 + 2 for
 * Alt + 4 for Ctrl), Alt as an ESC in front of Esc and Tab.
 */
export function shellRowBytes(key: RowKey, mods: Modifiers = NO_MODIFIERS): string {
  if (key === 'esc') return mods.alt ? '\x1b\x1b' : '\x1b';
  if (key === 'tab') return mods.alt ? '\x1b\t' : '\t';
  const m = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  return m === 1 ? `\x1b[${ARROW_FINAL[key]}` : `\x1b[1;${m}${ARROW_FINAL[key]}`;
}

const CTRL_SYMBOLS: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
  '?': '\x7f',
};

/**
 * What a shell receives for typed text while Ctrl or Alt is held from the key row: Ctrl turns one letter (or `@ [ \ ] ^
 * _ ?` and space) into its control character (c → ^C), Alt puts an ESC in front (as a terminal's “meta sends escape”).
 * Longer text (a phone keyboard's word) is left alone apart from Alt.
 */
export function withShellModifiers(data: string, mods: Modifiers): string {
  if (!mods.ctrl && !mods.alt) return data;
  let out = data;
  if (mods.ctrl && [...data].length === 1) {
    const c = data.toLowerCase();
    if (c >= 'a' && c <= 'z') out = String.fromCharCode(c.charCodeAt(0) - 96);
    else if (CTRL_SYMBOLS[data] !== undefined) out = CTRL_SYMBOLS[data] as string;
  }
  return mods.alt ? `\x1b${out}` : out;
}

const ROW_SCREEN_KEY: Record<RowKey, ComboKey> = {
  esc: ESC,
  tab: TAB,
  up: UP,
  down: DOWN,
  left: LEFT,
  right: RIGHT,
};

/** A row key on a VM's screen: the held modifiers, then the key (Ctrl+Alt+→ switches a desktop's workspace). */
export function screenRowKeys(key: RowKey, mods: Modifiers = NO_MODIFIERS): ComboKey[] {
  return [...(mods.ctrl ? [CTRL] : []), ...(mods.alt ? [ALT] : []), ROW_SCREEN_KEY[key]];
}

/** The modifiers as keys, for holding them down on a VM's screen until the next key is let go. */
export function modifierKeys(mods: Modifiers): ComboKey[] {
  return [...(mods.ctrl ? [CTRL] : []), ...(mods.alt ? [ALT] : [])];
}

/** “Ctrl+Alt+” for the notice. */
export function modifierWords(mods: Modifiers): string {
  return `${mods.ctrl ? 'Ctrl+' : ''}${mods.alt ? 'Alt+' : ''}`;
}
