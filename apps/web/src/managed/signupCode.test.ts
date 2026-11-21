import { afterEach, describe, expect, it, vi } from 'vitest';
import { heldSignupCode, holdSignupCode, SIGNUP_CODE_HELD_MS } from './ManagedRoot';

const KEY = 'whombat:signup-code';

describe('the held invite code (AP-161)', () => {
  afterEach(() => vi.useRealTimers());

  it('is kept in localStorage, so the magic link’s new tab still has it', () => {
    holdSignupCode('7KQ2-M4XD');
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({ value: { code: '7KQ2-M4XD' } });
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(heldSignupCode()).toBe('7KQ2-M4XD');
  });

  it('lasts at most an hour, and an older one is dropped', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 27, 12));
    holdSignupCode('7KQ2-M4XD');
    vi.setSystemTime(Date.UTC(2026, 8, 27, 12) + SIGNUP_CODE_HELD_MS - 1);
    expect(heldSignupCode()).toBe('7KQ2-M4XD');
    vi.setSystemTime(Date.UTC(2026, 8, 27, 12) + SIGNUP_CODE_HELD_MS);
    expect(heldSignupCode()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(SIGNUP_CODE_HELD_MS).toBe(3_600_000);
  });

  it('drops one from before this rule (seven days) or from the future', () => {
    const now = Date.UTC(2026, 8, 27, 12);
    localStorage.setItem(KEY, JSON.stringify({ code: 'OLD1-OLD1', at: now - 2 * 86_400_000 }));
    expect(heldSignupCode(now)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ code: 'NEXT-WEEK', at: now + 7 * 86_400_000 }));
    expect(heldSignupCode(now)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ code: 42, at: now }));
    expect(heldSignupCode(now)).toBeNull();
    localStorage.setItem(KEY, 'not json');
    expect(heldSignupCode(now)).toBeNull();
  });

  it('is cleared', () => {
    holdSignupCode('7KQ2-M4XD');
    holdSignupCode(null);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(heldSignupCode()).toBeNull();
  });

  describe('when storage throws (AP-590)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a full or disabled storage: holding doesn’t throw, and no code is held', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      });
      expect(() => holdSignupCode('7KQ2-M4XD')).not.toThrow();
      expect(heldSignupCode()).toBeNull();
    });

    it('a code that can’t be removed is still gone for this page', () => {
      holdSignupCode('7KQ2-M4XD');
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });
      expect(() => holdSignupCode(null)).not.toThrow();
      expect(localStorage.getItem(KEY)).not.toBeNull();
      expect(heldSignupCode()).toBeNull();
    });
  });
});
