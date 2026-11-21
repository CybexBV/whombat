import { describe, expect, it } from 'vitest';
import { assertOutsideLock, holdsBurrowLock, underBurrowLock } from './lock-scope';

describe('outside calls and the burrow lock', () => {
  it('refuses a call under the lock in development, only logs it in production, and allows it outside', async () => {
    const warned: string[] = [];
    const dev = { production: false, warn: (m: string) => warned.push(m) };
    const prod = { production: true, warn: (m: string) => warned.push(m) };
    assertOutsideLock('Google', dev);
    await underBurrowLock(async () => {
      expect(holdsBurrowLock()).toBe(true);
      expect(() => assertOutsideLock('Google', dev)).toThrow(/Google/);
      assertOutsideLock('Google', prod);
    });
    expect(holdsBurrowLock()).toBe(false);
    expect(warned).toHaveLength(1);
  });
});
