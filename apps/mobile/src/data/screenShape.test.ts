import { describe, expect, it } from 'vitest';
import { foldInfoOf } from '../../modules/whombat-fold/parse';
import {
  dividerAt,
  FOLD_SNAP,
  listWidthFor,
  PAGE_MIN_WIDTH,
  pageFrame,
  parseShare,
  type ShapeInput,
  SIDE_BAR_WIDTH,
  sameShape,
  screenShape,
  shareOf,
  TOAST_GAP,
  toastPlacement,
} from './screenShape';

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** As iOS 27.1 reports the open Duo: the bar's inset, the clock, the crease without its margins. */
const DUO_OPEN: ShapeInput = {
  width: 951,
  height: 669,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  barSide: 'right',
  folds: [{ x: 475.5, y: 0, width: 0, height: 669 }],
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }],
};

/** The iPhone Duo's clock: a pill in the top-right corner (as the simulator draws it). */
const clock = (width: number) => ({ x: width - 62, y: 12, width: 50, height: 86 });

function input(over: Partial<ShapeInput>): ShapeInput {
  return {
    width: 402,
    height: 874,
    insets: { top: 62, right: 0, bottom: 34, left: 0 },
    barSide: null,
    folds: [],
    occlusions: [],
    ...over,
  };
}

describe('the window’s shape', () => {
  it('keeps a phone as it is: the bottom bar, one page, nothing reserved', () => {
    const shape = screenShape(input({}));
    expect(shape).toMatchObject({ tabs: 'bottom', barWidth: 0, pages: 1, reserve: null });
    expect(shape.content).toEqual({ left: 0, right: 402 });
  });

  it('puts the tabs in the Duo’s strip when closed, leaving a phone’s width for the page', () => {
    const shape = screenShape(
      input({
        width: 466,
        height: 678,
        insets: { top: 0, right: 0, bottom: 20, left: 0 },
        barSide: 'right',
        occlusions: [clock(466)],
      }),
    );
    expect(shape.tabs).toBe('right');
    expect(shape.barWidth).toBe(SIDE_BAR_WIDTH);
    expect(shape.pages).toBe(1);
    expect(shape.content).toEqual({ left: 0, right: 466 - SIDE_BAR_WIDTH });
    // The tabs start below the clock, and screens before the tabs keep clear of it.
    expect(shape.barTop).toBe(98);
    expect(shape.reserve).toEqual({ side: 'right', width: 62 });
  });

  it('puts the wider page on the right when the Duo is open, the crease inside it', () => {
    const shape = screenShape(DUO_OPEN);
    expect(shape).toMatchObject({
      tabs: 'right',
      barWidth: 84,
      barTop: 124,
      pages: 2,
      listWidth: 867 - 475.5,
      fold: 475.5,
    });
    expect(shape.content).toEqual({ left: 0, right: 867 });
  });

  it('shows one page on the open Duo held upright, and in Split View', () => {
    const upright = input({ width: 669, height: 951, barSide: 'right', insets: NO_INSETS });
    expect(screenShape(upright)).toMatchObject({ tabs: 'right', pages: 1 });
    const half = input({ width: 470, height: 669, barSide: 'right', insets: NO_INSETS });
    expect(screenShape(half)).toMatchObject({ tabs: 'right', pages: 1 });
  });

  it('gives an unfolded Android foldable a rail on the left and two pages split at its fold', () => {
    const shape = screenShape(
      input({
        width: 851,
        height: 880,
        insets: { top: 32, right: 0, bottom: 24, left: 0 },
        folds: [{ x: 425, y: 0, width: 0, height: 880 }],
      }),
    );
    // The side left of the fold is the narrower one, so the list ends on it.
    expect(shape).toMatchObject({
      tabs: 'left',
      pages: 2,
      listWidth: 425 - SIDE_BAR_WIDTH,
      fold: 425 - SIDE_BAR_WIDTH,
      reserve: null,
    });
    expect(shape.content).toEqual({ left: SIDE_BAR_WIDTH, right: 851 });
  });

  it('puts the tabs down the side of a medium window, one page', () => {
    expect(screenShape(input({ width: 673, height: 841, insets: NO_INSETS }))).toMatchObject({
      tabs: 'left',
      pages: 1,
    });
  });

  it('splits a wide window without a fold at about 45%, neither page under the minimum', () => {
    const shape = screenShape(input({ width: 1024, height: 768, insets: NO_INSETS }));
    expect(shape.pages).toBe(2);
    expect(shape.listWidth).toBe(Math.round((1024 - SIDE_BAR_WIDTH) * 0.45));
  });

  it('ignores a fold that would leave a page too narrow', () => {
    const shape = screenShape(
      input({ width: 900, height: 700, insets: NO_INSETS, folds: [{ x: 120, y: 0, width: 0, height: 700 }] }),
    );
    expect(shape.listWidth).toBeGreaterThanOrEqual(PAGE_MIN_WIDTH);
    expect(shape.fold).toBeNull();
  });

  it('does not take a bar along the bottom for the clock’s strip', () => {
    const bottomBar = { x: 0, y: 650, width: 466, height: 28 };
    const shape = screenShape(input({ width: 466, height: 678, barSide: 'right', occlusions: [bottomBar] }));
    expect(shape.reserve).toBeNull();
    expect(shape.barWidth).toBe(SIDE_BAR_WIDTH);
  });
});

describe('the line between the pages', () => {
  const duo = screenShape(DUO_OPEN);

  it('keeps both pages at least a phone’s width', () => {
    expect(dividerAt(duo, 100)).toBe(PAGE_MIN_WIDTH);
    expect(dividerAt(duo, 800)).toBe(867 - PAGE_MIN_WIDTH);
    expect(dividerAt(duo, 420)).toBe(420);
  });

  it('snaps onto the crease when it is left near it', () => {
    expect(dividerAt(duo, 475.5 - FOLD_SNAP)).toBe(475.5);
    expect(dividerAt(duo, 481)).toBe(475.5);
    expect(dividerAt(duo, 475.5 + FOLD_SNAP + 1)).toBe(475.5 + FOLD_SNAP + 1);
    const noFold = screenShape(input({ width: 1024, height: 768, insets: NO_INSETS }));
    expect(dividerAt(noFold, 480)).toBe(480);
  });

  it('comes back where the person left it, as a share of the window', () => {
    expect(listWidthFor(duo, null)).toBe(duo.listWidth);
    const share = shareOf(duo, 520);
    expect(listWidthFor(duo, share)).toBeCloseTo(520, 0);
    // Left on the crease, it comes back on the crease.
    expect(listWidthFor(duo, shareOf(duo, 475.5))).toBe(475.5);
    // In a narrower window it still leaves the right page its minimum.
    const narrow = screenShape(input({ width: 860, height: 700, insets: NO_INSETS }));
    expect(listWidthFor(narrow, 0.9)).toBe(860 - SIDE_BAR_WIDTH - PAGE_MIN_WIDTH);
    // One page has no line.
    const phone = screenShape(input({}));
    expect(listWidthFor(phone, 0.3)).toBe(phone.listWidth);
  });

  it('reads back only a share it could have kept', () => {
    expect(parseShare('0.4516')).toBe(0.4516);
    expect(parseShare(null)).toBeNull();
    expect(parseShare('wide')).toBeNull();
    expect(parseShare('1.2')).toBeNull();
    expect(parseShare('0')).toBeNull();
  });
});

describe('the fold module’s payload', () => {
  it('keeps what is well formed and drops the rest', () => {
    expect(
      foldInfoOf({
        barEdge: 'trailing',
        folds: [{ x: 1, y: 2, width: 3, height: 4 }, { x: 'no' }],
        occlusions: null,
        posture: 'half',
      }),
    ).toEqual({
      barEdge: 'trailing',
      folds: [{ x: 1, y: 2, width: 3, height: 4 }],
      occlusions: [],
      posture: 'half',
    });
    expect(foldInfoOf({ barEdge: 'top', posture: 'open' })).toEqual({
      barEdge: null,
      folds: [],
      occlusions: [],
      posture: null,
    });
    expect(foldInfoOf(null)).toBeNull();
  });
});

const DUO_CLOSED: ShapeInput = {
  width: 466,
  height: 678,
  insets: { top: 0, right: 84, bottom: 20, left: 0 },
  barSide: 'right',
  folds: [],
  occlusions: [clock(466)],
};

describe('the same shape again', () => {
  it('counts as the same when every field matches, so a repeated report draws nothing anew', () => {
    expect(sameShape(screenShape(DUO_OPEN), screenShape({ ...DUO_OPEN, folds: [...DUO_OPEN.folds] }))).toBe(
      true,
    );
  });

  it('differs when the window, the fold or the bar change', () => {
    const open = screenShape(DUO_OPEN);
    expect(sameShape(open, screenShape(DUO_CLOSED))).toBe(false);
    expect(sameShape(open, screenShape({ ...DUO_OPEN, folds: [] }))).toBe(false);
  });
});

describe('a page’s edges', () => {
  it('are the content’s with one page, never under the side bar', () => {
    const closed = screenShape(DUO_CLOSED);
    expect(pageFrame(closed, closed.listWidth, 'only')).toEqual(closed.content);
    expect(pageFrame(closed, closed.listWidth, 'list')).toEqual(closed.content);
  });

  it('meet on the line with two pages, wherever the person left it', () => {
    const open = screenShape(DUO_OPEN);
    expect(pageFrame(open, 400, 'list')).toEqual({ left: 0, right: 400 });
    expect(pageFrame(open, 400, 'beside')).toEqual({ left: 400, right: open.content.right });
  });
});

describe('where the toast floats', () => {
  const base = { window: { width: 951 }, bottomInset: 20, aboveTabs: 0, keyboard: 0 };

  it('sits over the page beside the list on the open Duo, clear of the crease and the side bar', () => {
    const open = screenShape(DUO_OPEN);
    const at = toastPlacement({ ...base, shape: open, listWidth: 391.5 });
    expect(at.left).toBe(391.5);
    expect(951 - at.right).toBe(open.content.right);
    expect(at.bottom).toBe(20 + TOAST_GAP);
  });

  it('keeps off the side tabs on the closed Duo', () => {
    const closed = screenShape(DUO_CLOSED);
    const at = toastPlacement({
      ...base,
      window: { width: 466 },
      shape: closed,
      listWidth: closed.listWidth,
    });
    expect(at.left).toBe(0);
    expect(466 - at.right).toBe(closed.content.right);
  });

  it('rests above a bottom tab bar on a phone and above the keyboard while it is up', () => {
    const phone = screenShape(input({}));
    const resting = toastPlacement({
      ...base,
      window: { width: 402 },
      shape: phone,
      listWidth: 402,
      aboveTabs: 98,
    });
    expect(resting).toEqual({ left: 0, right: 0, bottom: 98 });
    const typing = toastPlacement({ ...base, shape: phone, listWidth: 402, aboveTabs: 98, keyboard: 300 });
    expect(typing.bottom).toBe(300 + TOAST_GAP);
  });
});
