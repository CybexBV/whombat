import { formatScreenSignInLetters } from '@whombat/protocol/claim';
import { describe, expect, it } from 'vitest';
import { ConsoleSignIn, ConsoleState, consoleStateValid } from './index.js';

const signIn = { code: 'KXQMTR', name: 'Mara Jansen', device: 'Pixel 9', expiresAt: '2026-10-20T12:05:00Z' };
const claimed = { v: 1, state: 'claimed', url: 'https://app.whombat.com/claim' } as const;

describe('the console file’s screen sign-in (CT-626)', () => {
  it('is only in claimed', () => {
    expect(consoleStateValid(ConsoleState.parse({ ...claimed, signIn }))).toBe(true);
    expect(consoleStateValid({ ...claimed, burrows: { first: 'Banjo', more: 0 }, signIn })).toBe(true);
    expect(consoleStateValid({ ...claimed, state: 'claimable', code: 'KXQM', signIn })).toBe(false);
    expect(consoleStateValid({ ...claimed, state: 'backoff', retryAt: '2026-10-20T12:04:00Z', signIn })).toBe(
      false,
    );
    for (const state of ['starting', 'waiting'] as const)
      expect(consoleStateValid({ ...claimed, state, signIn }), state).toBe(false);
  });

  it('carries six letters the console groups 3 + 3, and the requester’s name and device as display text', () => {
    expect(formatScreenSignInLetters(ConsoleSignIn.parse(signIn).code)).toBe('KXQ MTR');
    expect(ConsoleSignIn.safeParse({ ...signIn, code: 'KXQM' }).success).toBe(false);
    expect(ConsoleSignIn.safeParse({ ...signIn, name: `Mara${String.fromCodePoint(0x1b)}[2J` }).success).toBe(
      false,
    );
    expect(ConsoleSignIn.safeParse({ ...signIn, device: ' Pixel 9' }).success).toBe(false);
    expect(ConsoleSignIn.safeParse({ ...signIn, name: 'mara@example.com' }).success).toBe(true);
  });

  it('an older console strips it and reads the rest; a bad one refuses only with the member', () => {
    const older = ConsoleState.omit({ signIn: true });
    const parsed = older.parse({ ...claimed, signIn });
    expect(parsed).toEqual(claimed);
    expect(consoleStateValid(parsed)).toBe(true);
    const bad = { ...claimed, signIn: { ...signIn, code: 'kxqmtr' } };
    expect(ConsoleState.safeParse(bad).success).toBe(false);
    const { signIn: _dropped, ...rest } = bad;
    expect(ConsoleState.safeParse(rest).success).toBe(true);
  });
});
