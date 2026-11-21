/**
 * What a swipe on a list's row does (ui/swipeRow.tsx; ios-native.md), pure: past most of the row, or flicked there past
 * its panels, the edge's action runs; past half its panels, still moving that way or held, they stay open to tap;
 * otherwise the row is whole again. The functions are worklets: the swipe asks them on the display thread.
 */

/** An action's panel: the mock's 96px. */
export const SWIPE_ACTION_WIDTH = 96;
/** A flick this fast (dp per ms) past the open panels runs the edge's action. */
export const SWIPE_FLICK = 0.6;
/** Let go past this share of the row's width and the edge's action runs. */
const FULL_SHARE = 0.6;

/** How far a row is pulled before letting go runs the edge's action: most of the row, and always past its panels. */
export function fullSwipeAt(panels: number, rowWidth: number): number {
  'worklet';
  return Math.max(panels + SWIPE_ACTION_WIDTH * 0.75, rowWidth * FULL_SHARE);
}

export type SwipeEnd = 'run' | 'open' | 'close';

/**
 * Where a row goes when the finger lifts: `pulled` how far it is out (either way), `speed` how fast it moved outwards
 * (negative: back), `panels` the width of that side's panels, `runs` whether the edge's action may run by itself (one
 * that opens a menu can't).
 */
export function swipeEnd(
  pulled: number,
  speed: number,
  panels: number,
  rowWidth: number,
  runs: boolean,
): SwipeEnd {
  'worklet';
  if (pulled <= 0 || panels <= 0) return 'close';
  if (runs && (pulled >= fullSwipeAt(panels, rowWidth) || (speed > SWIPE_FLICK && pulled > panels)))
    return 'run';
  return pulled >= panels / 2 && speed > -SWIPE_FLICK ? 'open' : 'close';
}
