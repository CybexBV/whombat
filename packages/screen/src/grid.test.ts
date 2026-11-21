import { describe, expect, it } from 'vitest';
import type { Placed } from './grid';
import { cellRect, firstFree, fits, pageOn, rearrange, screenGrid, shapeKey } from './grid';

const w = (id: string, type: Placed['type'], x: number, y: number, ww: number, h: number): Placed => ({
  id,
  type,
  opts: {},
  x,
  y,
  w: ww,
  h,
});

describe('the grid comes from the screen', () => {
  it('gives the Z13 8 × 5, a 1080p monitor 12 × 7 and a portrait iPad 5 × 7', () => {
    expect(shapeKey(screenGrid(1280, 800))).toBe('8x5');
    expect(shapeKey(screenGrid(1920, 1080))).toBe('12x7');
    expect(shapeKey(screenGrid(820, 1180))).toBe('5x7');
  });

  it('draws fewer, bigger cells at Larger and more at Smaller', () => {
    expect(shapeKey(screenGrid(1280, 800, 'larger'))).toBe('6x4');
    expect(shapeKey(screenGrid(1280, 800, 'smaller'))).toBe('10x6');
  });

  it('fills the screen exactly', () => {
    const g = screenGrid(1280, 800);
    const all = cellRect(g, { x: 0, y: 0, w: g.cols, h: g.rows });
    expect(all.left + all.width).toBeCloseTo(1260);
    expect(all.top + all.height).toBeCloseTo(780);
  });
});

describe('placing', () => {
  const page = [w('w_a', 'clock', 0, 0, 4, 2), w('w_b', 'status', 4, 0, 4, 2)];
  it('refuses a taken spot and anything outside', () => {
    const g = { cols: 8, rows: 5 };
    expect(fits(page, { x: 2, y: 0, w: 2, h: 1 }, g)).toBe(false);
    expect(fits(page, { x: 2, y: 0, w: 2, h: 1 }, g, 'w_a')).toBe(true);
    expect(fits(page, { x: 7, y: 4, w: 2, h: 1 }, g)).toBe(false);
  });
  it('finds the first free spot in reading order', () => {
    expect(firstFree(page, 2, 2, { cols: 8, rows: 5 })).toEqual({ x: 0, y: 2 });
    expect(firstFree(page, 9, 1, { cols: 8, rows: 5 })).toBeNull();
  });
});

describe('another shape', () => {
  const calm = [
    w('w_clock', 'clock', 0, 0, 4, 2),
    w('w_status', 'status', 4, 0, 4, 2),
    w('w_now', 'now', 0, 2, 8, 2),
    w('w_strip', 'strip', 0, 4, 8, 1),
  ];
  it('stretches full-width widgets and keeps what fits', () => {
    const { widgets, left } = rearrange(calm, 8, { cols: 12, rows: 7 });
    expect(left).toEqual([]);
    expect(widgets.find((x) => x.id === 'w_strip')).toMatchObject({ x: 0, w: 12 });
    expect(widgets.find((x) => x.id === 'w_clock')).toMatchObject({ x: 0, y: 0, w: 4 });
  });
  it('makes widgets smaller before leaving them out, and never loses one', () => {
    const { widgets, left } = rearrange(calm, 8, { cols: 5, rows: 3 });
    expect(widgets.length + left.length).toBe(calm.length);
    for (const x of widgets) expect(x.x + x.w).toBeLessThanOrEqual(5);
  });
  it('uses a page’s own layout for a shape it has one for', () => {
    const page = { layouts: { '8x5': calm, '6x4': [w('w_clock', 'clock', 0, 0, 6, 4)] }, last: '8x5' };
    expect(pageOn(page, { cols: 6, rows: 4 })).toMatchObject({ rearranged: false, widgets: [{ w: 6 }] });
    expect(pageOn(page, { cols: 12, rows: 7 }).rearranged).toBe(true);
  });
});
