import { describe, expect, it } from 'vitest';
import { canSaveBoxLocale } from './locale';

describe('the box language picker', () => {
  it('is hidden on 5.20 and available on 5.21', () => {
    expect(canSaveBoxLocale(true, { major: 5, minor: 20 })).toBe(false);
    expect(canSaveBoxLocale(true, { major: 5, minor: 21 })).toBe(true);
  });

  it('waits for a connected box with a negotiated protocol', () => {
    expect(canSaveBoxLocale(true, null)).toBe(false);
    expect(canSaveBoxLocale(false, { major: 5, minor: 21 })).toBe(false);
  });
});
