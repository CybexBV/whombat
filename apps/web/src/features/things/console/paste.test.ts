import { formatBytes } from '@whombat/core/text';
import { describe, expect, it } from 'vitest';
import {
  analyzePaste,
  keysymFor,
  needsShift,
  PASTE_LIMIT_BYTES,
  planPaste,
  SHELL_ASK_CHARS,
  typeText,
  utf8Length,
} from './paste';

describe('paste sanitising (AP-1477)', () => {
  it('keeps text, newlines and tabs; CRLF and CR become LF', () => {
    const a = analyzePaste('ls -la\r\n\tcd /srv\r');
    expect(a.sanitized).toBe('ls -la\n\tcd /srv\n');
    expect(a.controlCount).toBe(0);
    expect(a.lines).toBe(2);
  });

  it('leaves out control characters and names a few', () => {
    const a = analyzePaste('echo hi\x1b[201~; rm -rf /tmp/x\x00\x7f\x9b\x03');
    expect(a.sanitized).toBe('echo hi[201~; rm -rf /tmp/x');
    expect(a.controlCount).toBe(5);
    expect(a.controlNames).toEqual(['Esc', 'NUL', 'DEL', 'U+009B']);
    expect(a.normalized).toContain('\x1b');
  });

  it('caps a paste at 64 KB of UTF-8', () => {
    expect(analyzePaste('x'.repeat(PASTE_LIMIT_BYTES)).tooLarge).toBe(false);
    expect(analyzePaste('x'.repeat(PASTE_LIMIT_BYTES + 1)).tooLarge).toBe(true);
    expect(analyzePaste('é'.repeat(PASTE_LIMIT_BYTES / 2 + 1)).tooLarge).toBe(true);
    // The limit reads as it is: 64 KB in the thousands the app writes sizes in.
    expect(formatBytes(PASTE_LIMIT_BYTES)).toBe('64\u00a0KB');
    expect(formatBytes(PASTE_LIMIT_BYTES + 1_000)).toBe('65\u00a0KB');
  });

  it('measures UTF-8 like TextEncoder', () => {
    for (const s of ['', 'abc', 'é', '€', '😀', 'a😀b€'])
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  });
});

describe('what a paste does', () => {
  it('sends a short line to a shell straight away (one trailing newline is still one line)', () => {
    expect(planPaste('uptime', 'shell')).toEqual({ kind: 'send', text: 'uptime', chars: 6 });
    expect(planPaste('uptime\n', 'shell')).toMatchObject({ kind: 'send', text: 'uptime\n' });
  });

  it('asks before more than one line, a long paste or control characters go into a shell', () => {
    expect(planPaste('apt update\napt upgrade -y', 'shell')).toMatchObject({
      kind: 'ask',
      analysis: { lines: 2 },
    });
    expect(planPaste('x'.repeat(SHELL_ASK_CHARS), 'shell').kind).toBe('send');
    expect(planPaste('x'.repeat(SHELL_ASK_CHARS + 1), 'shell').kind).toBe('ask');
    expect(planPaste('ls\x1b[A', 'shell')).toMatchObject({ kind: 'ask', analysis: { controlCount: 1 } });
  });

  it('types into a screen without asking; control characters have no key and are left out', () => {
    expect(planPaste('first\nsecond\n', 'screen')).toEqual({
      kind: 'send',
      text: 'first\nsecond\n',
      chars: 13,
    });
    expect(planPaste('pa\x03ss', 'screen')).toEqual({ kind: 'send', text: 'pass', chars: 4 });
  });

  it('refuses nothing and too much', () => {
    expect(planPaste('', 'shell')).toEqual({ kind: 'empty' });
    expect(planPaste('  \n ', 'screen')).toEqual({ kind: 'empty' });
    expect(planPaste('y'.repeat(PASTE_LIMIT_BYTES + 1), 'screen')).toMatchObject({ kind: 'too_large' });
  });
});

describe('typing into a VM’s screen', () => {
  it('maps characters to keysyms and knows which need Shift', () => {
    expect(keysymFor('a')).toBe(0x61);
    expect(keysymFor('é')).toBe(0xe9);
    expect(keysymFor('\n')).toBe(0xff0d);
    expect(keysymFor('\t')).toBe(0xff09);
    expect(keysymFor('€')).toBe(0x010020ac);
    expect(keysymFor('\x1b')).toBeNull();
    expect([...'Az_:"?~1;-'].map(needsShift)).toEqual([
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('types a few characters per tick, waits between ticks and holds Shift where needed', async () => {
    const sent: string[] = [];
    const sleeps: number[] = [];
    const progress: number[] = [];
    const typed = await typeText(
      (ks, code, down) =>
        sent.push(`${ks.toString(16)}${down === undefined ? '' : down ? '↓' : '↑'}${code ? `:${code}` : ''}`),
      'aB c\nd',
      {
        perTick: 2,
        tickMs: 20,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        onProgress: (n) => progress.push(n),
      },
    );
    expect(typed).toBe(6);
    expect(sleeps).toEqual([20, 20]);
    expect(progress).toEqual([2, 4, 6]);
    expect(sent).toEqual(['61', 'ffe1↓:ShiftLeft', '42', 'ffe1↑:ShiftLeft', '20', '63', 'ff0d', '64']);
  });

  it('stops when the console closes or Stop is pressed', async () => {
    let ticks = 0;
    const typed = await typeText(() => undefined, 'abcdefghij', {
      perTick: 3,
      alive: () => ticks++ < 2,
      sleep: async () => undefined,
    });
    expect(typed).toBe(6);
  });
});
