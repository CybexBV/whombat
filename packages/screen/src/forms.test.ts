import { describe, expect, it } from 'vitest';
import { FIXTURE_VIEWS } from './fixtures';
import {
  bigSize,
  clockForm,
  figuresForm,
  fitFont,
  headInCorner,
  meterBlocks,
  nowForm,
  pagesAt,
  photoEveryMs,
  pictureGrid,
  postersForm,
  postersInRow,
  serverForm,
  statusForm,
  stripForm,
  tilesThatFit,
  tileValueFits,
  viewTone,
} from './forms';
import type { DeskPostersView } from './types';

const view = <K extends string>(id: string) =>
  FIXTURE_VIEWS.find((v) => v.id === id) as Extract<(typeof FIXTURE_VIEWS)[number], { kind: K }>;

describe('the forms by size', () => {
  it('draws the clock stacked, in a row when wide and low, the time alone when small', () => {
    expect(clockForm(3, 2)).toBe('stack');
    expect(clockForm(5, 1)).toBe('row');
    expect(clockForm(2, 1)).toBe('time');
  });

  it('says how things are in one line when low, with the sentence when wide', () => {
    expect(statusForm(3, 2)).toEqual({ form: 'block', more: true });
    expect(statusForm(3, 1)).toEqual({ form: 'line', more: false });
    expect(statusForm(6, 1)).toEqual({ form: 'line', more: true });
  });

  it('lays what’s going on side by side when wide, stacked when narrow', () => {
    expect(nowForm(8, 282, 3)).toEqual({ cols: 3, rows: 1, done: true });
    expect(nowForm(4, 282, 3)).toEqual({ cols: 2, rows: 1, done: false });
    expect(nowForm(2, 282, 3)).toEqual({ cols: 1, rows: 1, done: false });
    expect(nowForm(2, 430, 3).rows).toBe(3);
  });

  it('counts the servers that don’t fit in the last chip', () => {
    expect(stripForm(8, 1, 8)).toEqual({ shown: 8, more: 0, tall: false });
    expect(stripForm(6, 2, 9)).toEqual({ shown: 5, more: 4, tall: true });
  });

  it('draws a server as a figure, its card, meters, or meters and a chart', () => {
    expect(serverForm(2, 1, false)).toBe('figure');
    expect(serverForm(3, 1, false)).toBe('card');
    expect(serverForm(2, 2, false)).toBe('meters');
    expect(serverForm(4, 2, false)).toBe('chart');
    expect(serverForm(4, 2, true)).toBe('down');
  });

  it('lays wide pictures out as the grid that makes them biggest, all of them while they’re big enough', () => {
    // Two cameras in a 6 × 3 widget sit side by side; four in a 4 × 3 make two rows of two.
    expect(pictureGrid(2, 891, 355, 9 / 16)).toMatchObject({ cols: 2, count: 2 });
    expect(pictureGrid(4, 580, 355, 9 / 16)).toMatchObject({ cols: 2, count: 4 });
    expect(pictureGrid(1, 580, 355, 9 / 16)).toMatchObject({ cols: 1, count: 1 });
    // Too many for the room: as many as fit at 120 px wide.
    const crowded = pictureGrid(30, 280, 100, 9 / 16);
    expect(crowded.count).toBeLessThan(30);
    expect(crowded.width).toBeGreaterThanOrEqual(120);
  });

  it('gives a server’s meters the cards’ twenty blocks where there’s room, never fewer than ten', () => {
    // The old card's width (a third of the Z13) has room for twenty, a 2 × 2 widget for thirteen.
    expect(meterBlocks(354)).toBe(20);
    expect(meterBlocks(265)).toBe(13);
    expect(meterBlocks(120)).toBe(10);
  });

  it('draws now playing as a count, a list or posters, and recently added as a row', () => {
    const playing = view<'posters'>('w_playing') as DeskPostersView;
    const recent = view<'posters'>('w_recent') as DeskPostersView;
    expect(postersForm(playing, 2, 1)).toBe('count');
    expect(postersForm(playing, 2, 2)).toBe('rows');
    expect(postersForm(playing, 4, 2)).toBe('cards');
    expect(postersForm(recent, 4, 2)).toBe('row');
    expect(postersForm(recent, 2, 1)).toBe('row');
    expect(postersInRow(574, 208, 'poster')).toBe(4);
  });

  it('draws figures as a tile, a line, a row of figures, a block or beside a chart', () => {
    const sensor = { items: [1, 2], spark: [1, 2, 3] };
    expect(figuresForm(sensor, 1, 1)).toBe('tile');
    expect(figuresForm(sensor, 2, 1)).toBe('line');
    expect(figuresForm({ items: [1, 2, 3] }, 4, 1)).toBe('inline');
    expect(figuresForm(sensor, 2, 2)).toBe('block');
    expect(figuresForm(sensor, 4, 2)).toBe('split');
    expect(figuresForm({ items: [1] }, 4, 2)).toBe('block');
  });

  it('puts a short big line in the header’s corner', () => {
    expect(headInCorner('2 on')).toBe(true);
    expect(headInCorner('3 left · about 20 min')).toBe(false);
    expect(headInCorner(undefined)).toBe(false);
  });

  it('opens a widget as big as it may grow, as far as the screen has room', () => {
    expect(bigSize([8, 4], { cols: 8, rows: 5 })).toEqual({ w: 8, h: 4 });
    expect(bigSize([8, 5], { cols: 5, rows: 7 })).toEqual({ w: 5, h: 5 });
  });

  it('colours a card red for a problem, by its tone otherwise', () => {
    expect(viewTone({ ...view('w_climate'), problem: { text: 'Gone' } })).toBe('bad');
    expect(viewTone(view('w_storage'))).toBe('warn');
    expect(viewTone(view('w_climate'))).toBeNull();
    expect(viewTone(undefined)).toBeNull();
  });

  it('keeps the pages clear of the name, the pill and the chips', () => {
    const bar = { bar: 1280, left: 80, chips: 900, names: 220, dots: 51 };
    expect(pagesAt(bar)).toBe('centre');
    expect(pagesAt({ ...bar, chips: 700 })).toBe('after');
    expect(pagesAt({ ...bar, left: 500, chips: 700 })).toBe('dots');
    expect(pagesAt({ ...bar, left: 600, chips: 700 })).toBe('dotsAfter');
    expect(pagesAt({ bar: 820, left: 80, chips: 620, names: 140, dots: 34 })).toBe('dots');
  });

  it('shrinks a long big line to fit, down to half', () => {
    expect(fitFont('2 on', 260, 30)).toBe(30);
    expect(fitFont('3 left · about 20 min', 264, 30)).toBeLessThan(30);
    expect(fitFont('x'.repeat(80), 100, 30)).toBe(15);
  });
});

describe('a board’s tiles (DK-162)', () => {
  // Inside a widget at 1280 × 800: 2 × 1 is 265 × 71 px under its header, 4 × 2 is 553 × 218, 8 × 4 is 1204 × 513.
  it('fits a few small tiles in two by one, the last counting the rest', () => {
    const f = tilesThatFit(40, 40, 265, 71);
    expect([f.cols, f.rows, f.shown, f.more]).toEqual([2, 2, 3, 37]);
    expect(f.tileH).toBeGreaterThanOrEqual(30);
  });

  it('shows forty at eight by four, each big enough for its value under its name', () => {
    const f = tilesThatFit(40, 40, 1204, 513);
    expect(f.shown).toBe(40);
    expect(f.more).toBe(0);
    expect(f.cols * f.rows).toBeGreaterThanOrEqual(40);
    expect(f.tileW).toBeGreaterThanOrEqual(112);
    expect(f.tileH).toBeGreaterThanOrEqual(52);
  });

  it('keeps few tiles calm rather than huge', () => {
    const f = tilesThatFit(4, 4, 1204, 513);
    expect(f.tileH).toBeLessThanOrEqual(84);
    expect(f.shown).toBe(4);
  });

  it('counts what the runtime didn’t send', () => {
    const f = tilesThatFit(40, 52, 1204, 513);
    expect([f.shown, f.more]).toEqual([40, 12]);
    const small = tilesThatFit(40, 52, 553, 218);
    expect(small.shown + small.more).toBe(52);
    expect(small.shown).toBe(small.cols * small.rows - 1);
  });

  it('never lays out more slots than fit', () => {
    for (const [inner, high] of [
      [265, 71],
      [553, 218],
      [1204, 513],
      [100, 20],
    ] as const)
      for (const n of [0, 1, 7, 48]) {
        const f = tilesThatFit(n, n, inner, high);
        expect(f.shown + (f.more > 0 ? 1 : 0)).toBeLessThanOrEqual(f.cols * f.rows);
      }
  });
});

describe('a tile’s value', () => {
  it('goes beside the name only when the whole name still fits', () => {
    expect(tileValueFits('plex', '1 %', 130)).toBe(true);
    expect(tileValueFits('AP living room', '18 clients', 130)).toBe(false);
  });
});

describe('a photo view (DK-160)', () => {
  it('changes its picture every two minutes unless it says, within what the contract allows', () => {
    expect(photoEveryMs(undefined)).toBe(120_000);
    expect(photoEveryMs(45)).toBe(45_000);
    expect(photoEveryMs(5)).toBe(30_000);
  });
});
