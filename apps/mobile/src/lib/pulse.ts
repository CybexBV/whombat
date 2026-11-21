/**
 * A there-and-back pulse as one animation from 0 to 1, for the native driver. Pure (no React Native imports) so it is
 * unit-tested in Node.
 *
 * React Native runs a looping animation on the display thread only when the loop holds a single timing: a loop of a
 * sequence (up, then down) is restarted from JavaScript at every step, so three dots “thinking” kept the JavaScript
 * thread busy while nothing else moved. One timing from 0 to 1 drives an interpolation that goes up and comes back
 * down, each half with the easing the two timings had.
 */

/** Points on each half of the cycle: enough that the eased curve reads smooth at a 1.2 s cycle. */
const STEPS = 8;

/**
 * `inputRange` and `outputRange` for `interpolate`: `from` at 0 and 1, `to` at 0.5, each half eased by `ease` (0 → 1),
 * as `Animated.sequence([timing(to), timing(from)])` with that easing drew it.
 */
export function pulseRange(
  from: number,
  to: number,
  ease: (t: number) => number,
  steps: number = STEPS,
): { inputRange: number[]; outputRange: number[] } {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let i = 0; i <= 2 * steps; i++) {
    const t = i / (2 * steps);
    const up = i <= steps;
    const local = up ? i / steps : (i - steps) / steps;
    const eased = ease(local);
    const value = up ? from + (to - from) * eased : to + (from - to) * eased;
    inputRange.push(t);
    outputRange.push(Math.round(value * 1000) / 1000);
  }
  return { inputRange, outputRange };
}
