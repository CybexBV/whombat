/** A swipe on a list's row (ios-native.md): when it runs the edge's action, stays open or closes. */
import { describe, expect, it } from 'vitest';
import { fullSwipeAt, SWIPE_ACTION_WIDTH, swipeEnd } from './swipe';

const W = SWIPE_ACTION_WIDTH;

describe('a swipe on a row', () => {
  it('runs the edge’s action only past most of the row, and always past its panels', () => {
    expect(fullSwipeAt(W, 400)).toBe(240);
    expect(fullSwipeAt(2 * W, 200)).toBe(2 * W + W * 0.75);
    expect(swipeEnd(250, 0, W, 400, true)).toBe('run');
    expect(swipeEnd(230, 0, W, 400, true)).toBe('open');
  });

  it('runs on a flick outwards past the panels', () => {
    expect(swipeEnd(W + 10, 1, W, 400, true)).toBe('run');
    expect(swipeEnd(W - 10, 1, W, 400, true)).toBe('open');
  });

  it('stays open past half the panels unless flicked back, else closes', () => {
    expect(swipeEnd(W / 2 + 1, 0, W, 400, true)).toBe('open');
    expect(swipeEnd(W / 2 + 1, -1, W, 400, true)).toBe('close');
    expect(swipeEnd(W / 2 - 1, 0, W, 400, true)).toBe('close');
    expect(swipeEnd(0, 0, W, 400, true)).toBe('close');
  });

  it('only opens a panel that opens a menu, however far it is pulled', () => {
    expect(swipeEnd(390, 2, W, 400, false)).toBe('open');
  });
});
