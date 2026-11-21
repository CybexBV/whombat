import { describe, expect, it } from 'vitest';
import { analyzePaste, formatBytes, keysymFor, needsShift, PASTE_LIMIT_BYTES, utf8Length } from './paste';

describe('paste sanitization (REMOTE-CONSOLE 6.6)', () => {
  it('keeps plain text, newlines and tabs', () => {
    const a = analyzePaste('ls -la\n\tcd /srv\n');
    expect(a.controlCount).toBe(0);
    expect(a.sanitized).toBe('ls -la\n\tcd /srv\n');
    expect(a.tooLarge).toBe(false);
  });

  it('normalizes CRLF and CR without counting them as control characters', () => {
    const a = analyzePaste('a\r\nb\rc');
    expect(a.normalized).toBe('a\nb\nc');
    expect(a.sanitized).toBe('a\nb\nc');
    expect(a.controlCount).toBe(0);
  });

  it('strips escape sequences, NUL, DEL and C1 controls and names them', () => {
    const a = analyzePaste('echo hi\x1b[201~; rm -rf /tmp/x\x00\x7f\x9b\x03');
    expect(a.sanitized).toBe('echo hi[201~; rm -rf /tmp/x');
    expect(a.controlCount).toBe(5);
    expect(a.controlNames).toEqual(['ESC', 'NUL', 'DEL', 'U+009B']);
    expect(a.normalized).toContain('\x1b');
  });

  it('enforces the 64 KB cap on the UTF-8 size', () => {
    expect(analyzePaste('x'.repeat(PASTE_LIMIT_BYTES)).tooLarge).toBe(false);
    expect(analyzePaste('x'.repeat(PASTE_LIMIT_BYTES + 1)).tooLarge).toBe(true);
    // 1 MB string (ACCEPTANCE: "Pasting a 1 MB string is rejected with a message")
    const big = analyzePaste('y'.repeat(1024 * 1024));
    expect(big.tooLarge).toBe(true);
    expect(formatBytes(big.bytes)).toBe('1.0 MB');
    // Multi-byte characters count by their encoded size.
    expect(analyzePaste('é'.repeat(PASTE_LIMIT_BYTES / 2 + 1)).tooLarge).toBe(true);
  });

  it('measures UTF-8 lengths like TextEncoder', () => {
    for (const s of ['', 'abc', 'é', '€', '😀', 'a😀b€']) expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  });

  it('maps characters to X11 keysyms for VNC typing', () => {
    expect(keysymFor('a')).toBe(0x61);
    expect(keysymFor('A')).toBe(0x41);
    expect(keysymFor('é')).toBe(0xe9);
    expect(keysymFor('\n')).toBe(0xff0d);
    expect(keysymFor('\t')).toBe(0xff09);
    expect(keysymFor('€')).toBe(0x010020ac);
    expect(keysymFor('\x1b')).toBeNull();
  });

  it('knows which characters need Shift on a US layout', () => {
    expect([...'Az_:"?~1;-'].map(needsShift)).toEqual([true, false, true, true, true, true, true, false, false, false]);
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(PASTE_LIMIT_BYTES)).toBe('64 KB');
  });
});
