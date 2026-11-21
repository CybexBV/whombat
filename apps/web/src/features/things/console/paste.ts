/**
 * Safe paste (ported from Rackoon's `features/console/paste.ts` and `VncScreen`'s `typeKeys`; AP-1477): text only, at
 * most 64 KB, line endings as `\n`, control characters (escape sequences, Ctrl+C, NUL …) left out unless the person
 * keeps them. A shell asks first before more than a few hundred characters or more than one line arrive (each line
 * runs as it lands); a VM's screen gets the text typed as key presses a few at a time, so the guest keeps up. Pure:
 * the dialog and the screens use it, the tests pin it.
 */

/** 64,000 bytes, so the limit reads “64 KB” as the app writes sizes everywhere (thousands, `formatBytes`). */
export const PASTE_LIMIT_BYTES = 64_000;
/** A shell asks before a paste longer than this (or with more than one line). */
export const SHELL_ASK_CHARS = 400;
/** Typing into a VM's screen: this many characters per tick … */
export const TYPE_PER_TICK = 8;
/** … every this many milliseconds (≈ 400 characters a second, slow enough for a BIOS or an installer). */
export const TYPE_TICK_MS = 20;

// C0 controls except \t (09) and \n (0A), DEL, and the C1 range; \r is handled by the line-ending normalisation first.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const NAMES: Record<number, string> = {
  0: 'NUL',
  3: 'Ctrl+C',
  4: 'Ctrl+D',
  7: 'BEL',
  8: 'Backspace',
  26: 'Ctrl+Z',
  27: 'Esc',
  127: 'DEL',
};

function nameOf(code: number): string {
  const known = NAMES[code];
  if (known) return known;
  if (code < 0x20) return `Ctrl+${String.fromCharCode(code + 0x40)}`;
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export interface PasteAnalysis {
  /** The text with CRLF and CR as LF. */
  normalized: string;
  /** `normalized` without control characters (what a safe paste sends). */
  sanitized: string;
  /** UTF-8 size of the original text. */
  bytes: number;
  tooLarge: boolean;
  /** How many control characters sanitising leaves out. */
  controlCount: number;
  /** Up to four of their names (“Esc”, “Ctrl+C”). */
  controlNames: string[];
  /** Characters (code points) of `sanitized`. */
  chars: number;
  /** Lines of `sanitized`, one trailing newline not counted. */
  lines: number;
}

export function analyzePaste(text: string): PasteAnalysis {
  const bytes = utf8Length(text);
  const normalized = text.replace(/\r\n?/g, '\n');
  const names = new Set<string>();
  let controlCount = 0;
  const sanitized = normalized.replace(CONTROL, (m) => {
    controlCount++;
    if (names.size < 4) names.add(nameOf(m.charCodeAt(0)));
    return '';
  });
  const body = sanitized.endsWith('\n') ? sanitized.slice(0, -1) : sanitized;
  return {
    normalized,
    sanitized,
    bytes,
    tooLarge: bytes > PASTE_LIMIT_BYTES,
    controlCount,
    controlNames: [...names],
    chars: Array.from(sanitized).length,
    lines: body ? body.split('\n').length : 0,
  };
}

export type PastePlan =
  | { kind: 'empty' }
  | { kind: 'too_large'; bytes: number }
  /** Ask first: a long or many-line paste into a shell, or one with control characters. */
  | { kind: 'ask'; analysis: PasteAnalysis }
  | { kind: 'send'; text: string; chars: number };

/** What pasting this text does: nothing, refuse, ask, or send (sanitised). */
export function planPaste(text: string, target: 'shell' | 'screen'): PastePlan {
  const a = analyzePaste(text);
  if (!a.sanitized.trim() && !a.controlCount) return { kind: 'empty' };
  if (a.tooLarge) return { kind: 'too_large', bytes: a.bytes };
  // A screen types only what has a key; control characters have none, so they are simply left out there.
  if (target === 'shell' && (a.controlCount > 0 || a.lines > 1 || a.chars > SHELL_ASK_CHARS))
    return { kind: 'ask', analysis: a };
  if (!a.sanitized) return { kind: 'empty' };
  return { kind: 'send', text: a.sanitized, chars: a.chars };
}

/** “1,240” */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/* Typing into a VM's screen -------------------------------------------------------------------------- */

/** X11 keysym for a character: Latin-1 is itself, newline and tab are Return and Tab, the rest Unicode keysyms. */
export function keysymFor(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if (ch === '\n') return 0xff0d;
  if (ch === '\t') return 0xff09;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return null;
  if (cp <= 0xff) return cp;
  return 0x01000000 | cp;
}

const US_SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?');

/**
 * Whether a character needs Shift on a US keyboard. QEMU's VNC server maps a keysym to its key without adding Shift,
 * so typed text holds Shift around these, as a person would.
 */
export function needsShift(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || US_SHIFTED.has(ch);
}

const XK_SHIFT_L = 0xffe1;

export type SendKey = (keysym: number, code: string | null, down?: boolean) => void;

export interface TypeOptions {
  perTick?: number;
  tickMs?: number;
  /** False stops the typing (the console closed, or Stop was pressed). */
  alive?: () => boolean;
  /** Characters typed so far. */
  onProgress?: (typed: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Types text as key presses, `perTick` characters at a time; resolves with how many characters were typed. */
export async function typeText(send: SendKey, text: string, opts: TypeOptions = {}): Promise<number> {
  const perTick = opts.perTick ?? TYPE_PER_TICK;
  const tickMs = opts.tickMs ?? TYPE_TICK_MS;
  const alive = opts.alive ?? (() => true);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const chars = Array.from(text);
  let typed = 0;
  for (let i = 0; i < chars.length; i += perTick) {
    if (!alive()) return typed;
    for (const ch of chars.slice(i, i + perTick)) {
      typed++;
      const ks = keysymFor(ch);
      if (ks === null) continue;
      const shift = needsShift(ch);
      if (shift) send(XK_SHIFT_L, 'ShiftLeft', true);
      send(ks, null);
      if (shift) send(XK_SHIFT_L, 'ShiftLeft', false);
    }
    opts.onProgress?.(typed, chars.length);
    if (i + perTick < chars.length) await sleep(tickMs);
  }
  return typed;
}
