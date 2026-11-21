/**
 * The 44dp minimum touch target (README "Accessibility": 44px touch targets on mobile). Interactive
 * elements smaller than this on screen must grow their hit area with `hitSlop` instead of changing how
 * they look (the mocks win on visuals). `touch-targets.test.ts` statically audits every `Touchable` /
 * `Pressable` call site against this constant.
 */
export const MIN_TOUCH_TARGET = 44;

/** Symmetric `hitSlop` that pads a `size`dp control up to `MIN_TOUCH_TARGET` on every edge. */
export function hitSlopFor(size: number): { top: number; bottom: number; left: number; right: number } {
  const pad = Math.max(0, Math.ceil((MIN_TOUCH_TARGET - size) / 2));
  return { top: pad, bottom: pad, left: pad, right: pad };
}

/** Whether a control of `size`dp with the given (possibly asymmetric) `hitSlop` reaches 44dp on both axes. */
export function meetsMinTouchTarget(
  size: { width: number; height: number },
  hitSlop?: { top?: number; bottom?: number; left?: number; right?: number } | number,
): boolean {
  const slop =
    typeof hitSlop === 'number'
      ? { top: hitSlop, bottom: hitSlop, left: hitSlop, right: hitSlop }
      : { top: 0, bottom: 0, left: 0, right: 0, ...hitSlop };
  const width = size.width + slop.left + slop.right;
  const height = size.height + slop.top + slop.bottom;
  return width >= MIN_TOUCH_TARGET && height >= MIN_TOUCH_TARGET;
}
