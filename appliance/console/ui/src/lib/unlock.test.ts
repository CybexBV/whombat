import { describe, expect, it } from 'vitest';
import type { DeskLock } from './desk';
import { backoffUntil, padMessage, parsePhoneAnswer, parseUnlockAnswer, pinLength, pressKey } from './unlock';

const locked: DeskLock = { state: 'locked', until: null, retryAt: null, expiresAt: null };
const now = Date.parse('2026-10-20T12:34:00Z');

describe('pressKey', () => {
  it('takes as many digits as the PIN has and deletes one at a time', () => {
    expect(pressKey('', '1', 6)).toBe('1');
    expect(pressKey('123456', '7', 6)).toBe('123456');
    expect(pressKey('258', '0', 4)).toBe('2580');
    expect(pressKey('2580', '3', 4)).toBe('2580');
    expect(pressKey('12', 'delete', 4)).toBe('1');
    expect(pressKey('', 'delete', 6)).toBe('');
    expect(pressKey('1', 'x', 6)).toBe('1');
  });

  it('knows the PIN’s length from Whombat, six from a runtime that doesn’t say (DK-26, DK-34)', () => {
    expect(pinLength({ pinDigits: 4 })).toBe(4);
    expect(pinLength({ pinDigits: 5 })).toBe(5);
    expect(pinLength({})).toBe(6);
  });
});

describe('parseUnlockAnswer', () => {
  it('reads Whombat’s answers', () => {
    expect(parseUnlockAnswer(200, { v: 1, result: 'unlocked' })).toEqual({ result: 'unlocked' });
    expect(parseUnlockAnswer(200, { v: 1, result: 'wrong', triesLeft: 3 })).toEqual({
      result: 'wrong',
      triesLeft: 3,
    });
    expect(
      parseUnlockAnswer(200, { v: 1, result: 'backoff', retryAt: '2026-10-20T12:35:00Z' }),
    ).toMatchObject({
      result: 'backoff',
    });
  });

  it('knows a screen without a PIN by Whombat’s refusal (DK-18)', () => {
    expect(parseUnlockAnswer(409, { message: 'no_pin' })).toEqual({ result: 'noPin' });
    expect(parseUnlockAnswer(409, { message: 'locked' })).toEqual({ result: 'failed' });
  });

  it('is failed for anything else (type it again)', () => {
    expect(parseUnlockAnswer(500, null)).toEqual({ result: 'failed' });
    expect(parseUnlockAnswer(200, { result: 'maybe' })).toEqual({ result: 'failed' });
  });
});

describe('padMessage', () => {
  it('says the tries left after a wrong PIN', () => {
    expect(padMessage(locked, { result: 'wrong', triesLeft: 4 }, now)).toBe('Wrong PIN. 4 tries left.');
    expect(padMessage(locked, { result: 'wrong', triesLeft: 1 }, now)).toContain('1 try left');
  });

  it('says how long to wait, from Whombat’s lock or the last answer, rounded up', () => {
    const backoff: DeskLock = { ...locked, state: 'backoff', retryAt: '2026-10-20T12:35:30Z' };
    expect(padMessage(backoff, null, now)).toBe('Too many wrong PINs. Try again in 2 min.');
    expect(padMessage(locked, { result: 'backoff', retryAt: '2026-10-20T12:34:20Z' }, now)).toContain(
      'in 1 min',
    );
  });

  it('forgets a wait that is over', () => {
    expect(backoffUntil(locked, { result: 'backoff', retryAt: '2026-10-20T12:33:00Z' }, now)).toBeNull();
    expect(padMessage(locked, null, now)).toBeNull();
  });
});

describe('parsePhoneAnswer', () => {
  it('reads until when the phone can say yes', () => {
    expect(parsePhoneAnswer(200, { v: 1, expiresAt: '2026-10-20T12:36:00Z' })).toBe('2026-10-20T12:36:00Z');
    expect(parsePhoneAnswer(409, { code: 'locked' })).toBeNull();
  });
});
