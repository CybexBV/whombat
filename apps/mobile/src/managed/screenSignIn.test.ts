import { COPY, type ScreenSignInStep } from '@whombat/client/managed';
import { describe, expect, it } from 'vitest';
import { backFrom, lettersAfter } from './screenSignIn';

const start: ScreenSignInStep = { kind: 'start', error: null };
const letters = (signinId: string, error: string | null = null): ScreenSignInStep => ({
  kind: 'letters',
  signinId,
  expiresAt: '2026-10-20T12:05:00.000Z',
  error,
});

describe('the letters field on the phone (AP-3531)', () => {
  it('empties when the box shows other letters: a first code, a new code, a wrong guess', () => {
    expect(lettersAfter(start, letters('sig_one_1'), 'KXQ')).toBe('');
    expect(lettersAfter(letters('sig_one_1'), letters('sig_two_2'), 'KXQ MTR')).toBe('');
    expect(
      lettersAfter(
        letters('sig_one_1'),
        letters('sig_one_1', COPY.screen.errors.screen_code_invalid),
        'KXQ MTR',
      ),
    ).toBe('');
  });

  it('keeps what was typed when the letters on the box are still the same', () => {
    expect(
      lettersAfter(letters('sig_one_1'), letters('sig_one_1', COPY.screen.errors.letters), 'KXQ MTI'),
    ).toBe('KXQ MTI');
    expect(
      lettersAfter(letters('sig_one_1'), letters('sig_one_1', COPY.claim.errors.failed), 'KXQ MTR'),
    ).toBe('KXQ MTR');
    expect(lettersAfter(letters('sig_one_1'), { kind: 'stopped', error: 'x' }, 'KXQ MTR')).toBe('KXQ MTR');
  });
});

describe('Android back in the screen flow (AP-3530)', () => {
  it('goes from the letters to “Show a code”, and from there out', () => {
    expect(backFrom(letters('sig_one_1', 'x'))).toEqual(start);
    expect(backFrom(start)).toBeNull();
    expect(backFrom({ kind: 'stopped', error: 'x' })).toBeNull();
  });
});
