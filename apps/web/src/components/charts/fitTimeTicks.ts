/**
 * The time axis's words that fit (Whombat less-is-more.md LM-06; app less-is-more.md AP-1867): the first and the last
 * always, the ones between only where they keep a gap to their neighbours, so a narrow chart shows fewer words instead
 * of words on top of each other. A word's width is estimated from its length: the axis is 11px DM Mono (0.6em a
 * letter). The first word is anchored at its start, the last at its end, the rest in their middle, as the charts draw
 * them.
 */
export const AXIS_CHAR_WIDTH = 6.6;
const GAP = 10;
// Before the last word (“Now”), which the eye reads as the end of the axis, a little more room (dashboards-web.md).
const LAST_GAP = 18;

export function fitTimeTicks<T extends { index: number; label: string }>(
  ticks: readonly T[],
  x: (index: number) => number,
  charWidth = AXIS_CHAR_WIDTH,
): T[] {
  if (ticks.length <= 2) return [...ticks];
  const width = (t: T) => t.label.length * charWidth;
  const first = ticks[0] as T;
  const last = ticks[ticks.length - 1] as T;
  const lastLeft = x(last.index) - width(last);
  const kept: T[] = [first];
  let right = x(first.index) + width(first);
  for (const t of ticks.slice(1, -1)) {
    const w = width(t);
    const left = x(t.index) - w / 2;
    if (left >= right + GAP && left + w + LAST_GAP <= lastLeft) {
      kept.push(t);
      right = left + w;
    }
  }
  kept.push(last);
  return kept;
}
