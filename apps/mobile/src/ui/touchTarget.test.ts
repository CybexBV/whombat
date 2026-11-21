import { describe, expect, it } from 'vitest';
import { hitSlopFor, MIN_TOUCH_TARGET, meetsMinTouchTarget } from './touchTarget';

describe('touchTarget', () => {
  it('is 44dp (README "Accessibility": 44px touch targets on mobile)', () => {
    expect(MIN_TOUCH_TARGET).toBe(44);
  });

  it('pads a small control up to 44dp on every edge', () => {
    expect(hitSlopFor(32)).toEqual({ top: 6, bottom: 6, left: 6, right: 6 });
    expect(hitSlopFor(34)).toEqual({ top: 5, bottom: 5, left: 5, right: 5 });
    expect(hitSlopFor(36)).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
    expect(hitSlopFor(38)).toEqual({ top: 3, bottom: 3, left: 3, right: 3 });
  });

  it('adds no padding once the control already meets the minimum', () => {
    expect(hitSlopFor(44)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(hitSlopFor(52)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('judges a control by its effective (size + hitSlop) extent', () => {
    expect(meetsMinTouchTarget({ width: 44, height: 44 })).toBe(true);
    expect(meetsMinTouchTarget({ width: 32, height: 32 })).toBe(false);
    expect(meetsMinTouchTarget({ width: 32, height: 32 }, hitSlopFor(32))).toBe(true);
    expect(meetsMinTouchTarget({ width: 32, height: 32 }, 6)).toBe(true);
    // Asymmetric hitSlop: only the padded edges count.
    expect(meetsMinTouchTarget({ width: 32, height: 44 }, { left: 6, right: 6 })).toBe(true);
    expect(meetsMinTouchTarget({ width: 32, height: 44 }, { left: 6 })).toBe(false);
  });
});
