// Paste safety (REMOTE-CONSOLE.md 6.6): text only, capped at 64 KB, control
// characters other than newline and tab stripped unless the user explicitly
// chooses a raw paste. Line endings are normalized to "\n" first (CRLF and CR
// are not "control characters" for this purpose; each client maps "\n" to
// Enter itself).

export const PASTE_LIMIT_BYTES = 64 * 1024;

// C0 controls except \t (09) and \n (0A), DEL, and the C1 range. \r is
// handled by the line-ending normalization before this runs.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export interface PasteAnalysis {
  /** Text with CRLF / CR normalized to LF. */
  normalized: string;
  /** normalized without control characters (what a safe paste sends). */
  sanitized: string;
  /** UTF-8 size of the original text. */
  bytes: number;
  tooLarge: boolean;
  /** Number of control characters that sanitizing removes. */
  controlCount: number;
  /** A few visible names of the removed characters ("ESC", "NUL"...). */
  controlNames: string[];
}

const NAMES: Record<number, string> = {
  0x00: 'NUL',
  0x03: 'Ctrl+C',
  0x04: 'Ctrl+D',
  0x07: 'BEL',
  0x08: 'Backspace',
  0x1a: 'Ctrl+Z',
  0x1b: 'ESC',
  0x7f: 'DEL',
};

function nameOf(code: number): string {
  if (NAMES[code]) return NAMES[code];
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
  return { normalized, sanitized, bytes, tooLarge: bytes > PASTE_LIMIT_BYTES, controlCount, controlNames: [...names] };
}

/** "64 KB", "1.0 MB" for messages. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * X11 keysym for a character (noVNC typing): Latin-1 maps to itself, newline
 * and tab to Return and Tab, everything else to the Unicode keysym range.
 */
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
 * Whether a character needs Shift on a US keyboard. QEMU's VNC server maps a
 * keysym to the key's scancode without adding Shift itself, so typed text
 * holds Shift around these (as a person typing would).
 */
export function needsShift(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || US_SHIFTED.has(ch);
}
