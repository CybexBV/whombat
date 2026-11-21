/**
 * The grid (Whombat desk-display.md DK-129…DK-132): it comes from the screen — as many cells of about 140 logical pixels
 * as fit under the top bar, stretched to fill — and Size scales everything. A page keeps a layout per shape; a shape it
 * has none for is drawn rearranged from its latest. Pure: the box's console, the web app, the phone and the runtime use
 * the same numbers.
 */
import { type ScreenSize, sizeOf, type WidgetSpecLike } from './specs';

/** The top bar's height, the padding around the grid and between cells, and the cell size aimed at (logical px). */
export const BAR = 56;
export const PAD = 20;
export const GAP = 12;
export const TARGET = 140;
/** The most columns or rows (the contract's). */
export const GRID_MAX = 39;

export const ZOOM: Readonly<Record<ScreenSize, number>> = { smaller: 0.8, normal: 1, larger: 1.3 };

/** A screen's grid: its drawing size in logical pixels after Size's zoom, its columns and rows, a cell's size. */
export interface Grid {
  width: number;
  height: number;
  zoom: number;
  cols: number;
  rows: number;
  cw: number;
  ch: number;
}

/** A widget's place, in cells. */
export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A widget on a page (the contract's `DeskWidget`). */
export interface Placed extends Cell, WidgetSpecLike {
  id: string;
  ref?: string | undefined;
  opts: Readonly<Record<string, string>>;
}

/** A page as the contract has it: a layout per shape, `last` the latest. */
export interface PageLike {
  id: string;
  name: string;
  layouts: Readonly<Record<string, readonly Placed[]>>;
  last: string;
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** The grid of a screen `width` × `height` logical pixels at `size`. */
export function screenGrid(width: number, height: number, size: ScreenSize = 'normal'): Grid {
  const zoom = ZOOM[size];
  const w = width / zoom;
  const h = height / zoom;
  const cols = clampInt((w - 2 * PAD + GAP) / (TARGET + GAP), 1, GRID_MAX);
  const rows = clampInt((h - BAR - PAD + GAP) / (TARGET + GAP), 1, GRID_MAX);
  return {
    width: w,
    height: h,
    zoom,
    cols,
    rows,
    cw: (w - 2 * PAD - (cols - 1) * GAP) / cols,
    ch: (h - BAR - PAD - (rows - 1) * GAP) / rows,
  };
}

/** The grid's shape as the contract keys layouts: `"8x5"`. */
export function shapeKey(g: Pick<Grid, 'cols' | 'rows'>): string {
  return `${g.cols}x${g.rows}`;
}

export function parseShape(key: string): { cols: number; rows: number } | null {
  const m = /^([1-9]|[1-3][0-9])x([1-9]|[1-3][0-9])$/.exec(key);
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : null;
}

/** Where a cell range sits on the screen, in the grid's logical pixels. */
export function cellRect(g: Grid, c: Cell): { left: number; top: number; width: number; height: number } {
  return {
    left: PAD + c.x * (g.cw + GAP),
    top: BAR + c.y * (g.ch + GAP),
    width: c.w * g.cw + (c.w - 1) * GAP,
    height: c.h * g.ch + (c.h - 1) * GAP,
  };
}

/** The cell under a point of the grid (logical px), clamped to the grid. */
export function cellAt(g: Grid, left: number, top: number): { x: number; y: number } {
  return {
    x: clampInt(Math.floor((left - PAD) / (g.cw + GAP)), 0, g.cols - 1),
    y: clampInt(Math.floor((top - BAR) / (g.ch + GAP)), 0, g.rows - 1),
  };
}

export const overlaps = (a: Cell, b: Cell) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** `c` lies inside the grid and on none of `widgets` but `ignore`. */
export function fits(
  widgets: readonly (Cell & { id: string })[],
  c: Cell,
  g: Pick<Grid, 'cols' | 'rows'>,
  ignore?: string,
): boolean {
  if (c.x < 0 || c.y < 0 || c.w < 1 || c.h < 1 || c.x + c.w > g.cols || c.y + c.h > g.rows) return false;
  return widgets.every((o) => o.id === ignore || !overlaps(o, c));
}

/** The first free place for `w` × `h`, reading order (row by row, left to right); null when none. */
export function firstFree(
  widgets: readonly (Cell & { id: string })[],
  w: number,
  h: number,
  g: Pick<Grid, 'cols' | 'rows'>,
): { x: number; y: number } | null {
  for (let y = 0; y + h <= g.rows; y++)
    for (let x = 0; x + w <= g.cols; x++) if (fits(widgets, { x, y, w, h }, g)) return { x, y };
  return null;
}

/**
 * A layout made for `fromCols` columns, rearranged for `g` (DK-132): what fits stays where it is; a widget as wide as
 * the old grid stretches to the new width (as far as it may grow); the rest go to the first free place in reading
 * order, their own size or smaller down to their smallest; what still doesn't fit is `left` out, never lost.
 */
export function rearrange<T extends Placed>(
  widgets: readonly T[],
  fromCols: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  view?: (w: T) => string | undefined,
): { widgets: T[]; left: T[] } {
  const out: T[] = [];
  const left: T[] = [];
  for (const d of [...widgets].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const size = sizeOf(d, view?.(d));
    const w = Math.max(1, d.w === fromCols ? Math.min(g.cols, size.max[0]) : Math.min(d.w, g.cols));
    const h = Math.max(1, Math.min(d.h, g.rows));
    const same = { ...d, w, h };
    if (fits(out, same, g)) {
      out.push(same);
      continue;
    }
    let placed: T | null = null;
    for (let hh = h; hh >= Math.min(h, size.min[1]) && !placed; hh--)
      for (let ww = w; ww >= Math.min(w, size.min[0]) && !placed; ww--) {
        const p = firstFree(out, ww, hh, g);
        if (p) placed = { ...d, ...p, w: ww, h: hh };
      }
    if (placed) out.push(placed);
    else left.push(d);
  }
  return { widgets: out, left };
}

/**
 * What a page shows on grid `g`: its layout for this shape, else its latest rearranged (`rearranged`), with what
 * didn't fit (`left`).
 */
export function pageOn<T extends Placed>(
  page: { layouts: Readonly<Record<string, readonly T[]>>; last: string },
  g: Pick<Grid, 'cols' | 'rows'>,
  view?: (w: T) => string | undefined,
): { widgets: T[]; left: T[]; rearranged: boolean; from: string } {
  const key = shapeKey(g);
  const own = page.layouts[key];
  if (own) return { widgets: [...own], left: [], rearranged: false, from: key };
  const from = page.layouts[page.last] ? page.last : (Object.keys(page.layouts)[0] ?? key);
  const src = page.layouts[from] ?? [];
  const cols = parseShape(from)?.cols ?? g.cols;
  return { ...rearrange(src, cols, g, view), rearranged: true, from };
}
