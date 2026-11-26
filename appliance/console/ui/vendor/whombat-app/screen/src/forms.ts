/**
 * Which designed form a widget draws for the room it has (DK-131): a figure, a figure and a line, a list, posters. Pure,
 * so the editor's labels, the tests and the drawing agree. `w`, `h` in cells; pixel heights where a count of rows or
 * posters depends on them.
 */
import type { DeskPostersView, DeskWidgetView } from './types';

export type ClockForm = 'stack' | 'row' | 'time';
export function clockForm(w: number, h: number): ClockForm {
  if (h === 1) return w >= 4 ? 'row' : 'time';
  return 'stack';
}

/** The clock's size in px for the room it has: as big as fits, the date a fifth of it. */
export function clockSizes(form: ClockForm, pw: number, ph: number): { time: number; date: number } {
  const time =
    form === 'stack' ? Math.min(ph * 0.6, pw / 2.75) : Math.min(ph * 0.66, pw / (form === 'row' ? 4.9 : 3));
  return { time, date: Math.max(17, Math.min(28, time * 0.2)) };
}

/** *How things are*: one line (with the muted sentence when wide), or the sentence under it. */
export function statusForm(w: number, h: number): { form: 'line' | 'block'; more: boolean } {
  return { form: h === 1 ? 'line' : 'block', more: h >= 2 || w >= 5 };
}

/** *What’s going on*: cards side by side when wide, stacked when narrow, as many as fit. */
export function nowForm(w: number, ph: number, count: number): { cols: number; rows: number; done: boolean } {
  if (w < 4) return { cols: 1, rows: Math.max(1, Math.floor((ph - 36) / 128)), done: false };
  return { cols: Math.max(1, Math.min(count, Math.floor(w / 2), 3)), rows: 1, done: w >= 6 };
}

/** *Servers*: as many chips as cells across; with more, the last one counts the rest (“+3”). */
export function stripForm(
  w: number,
  h: number,
  total: number,
): { shown: number; more: number; tall: boolean } {
  const slots = Math.max(1, Math.min(total, w));
  const shown = total > slots ? slots - 1 : total;
  return { shown, more: total - shown, tall: h >= 2 };
}

/**
 * A server: down, its processor as a figure (one cell high, narrow), its card (one cell high, three wide or more: the
 * three meters as the server cards drew them, DK-152), its meters with what it is, or its meters beside its chart.
 */
export type ServerForm = 'down' | 'figure' | 'card' | 'meters' | 'chart';
export function serverForm(w: number, h: number, down: boolean): ServerForm {
  if (down) return 'down';
  if (h === 1) return w >= 3 ? 'card' : 'figure';
  return w < 4 ? 'meters' : 'chart';
}

/**
 * How many blocks a server's meters have in `width` px (the line's whole width: its name, the blocks, the percentage):
 * twenty as the cards had when there's room, fewer on a narrow widget so each block stays about 9 px wide, at least ten.
 */
export function meterBlocks(width: number): number {
  const blocks = width - 46 - 50 - 2 * 12;
  return Math.max(10, Math.min(20, Math.floor((blocks + 2) / 11)));
}

/** Posters with who's watching and how far are *Now playing*; without, a row of pictures (*Recently added*). */
export function postersPlaying(v: Pick<DeskPostersView, 'items'>): boolean {
  return v.items.some((p) => p.who !== undefined || p.progress !== undefined);
}

export type PostersForm = 'count' | 'rows' | 'cards' | 'row';
export function postersForm(v: Pick<DeskPostersView, 'items'>, w: number, h: number): PostersForm {
  if (!postersPlaying(v)) return 'row';
  if (h === 1) return 'count';
  return w < 3 ? 'rows' : 'cards';
}

/** How many posters fit in a row `inner` px wide and `high` px high, each 2:3 (or 16:9, 1:1) with 10 px between. */
export function postersInRow(inner: number, high: number, shape: DeskPostersView['shape']): number {
  const ratio = shape === 'wide' ? 16 / 9 : shape === 'square' ? 1 : 0.67;
  return Math.max(1, Math.round((inner + 10) / (high * ratio + 10)));
}

/**
 * Pictures of one `ratio` (height ÷ width) in a grid `inner` px wide and `high` px high, 10 px apart: the columns that
 * make them biggest with all of them in, else as many as fit at least 120 px wide; their width (whole px) and count.
 */
export function pictureGrid(
  total: number,
  inner: number,
  high: number,
  ratio: number,
): { cols: number; width: number; count: number } {
  const n = Math.max(1, total);
  let best = { cols: 1, width: 0, count: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byWidth = (inner - (cols - 1) * 10) / cols;
    const byHeight = (high - (rows - 1) * 10) / rows / ratio;
    const width = Math.floor(Math.min(byWidth, byHeight));
    if (width > best.width) best = { cols, width, count: n };
  }
  if (best.width >= 120 || n === 1) return best;
  // Too many to show at a size worth looking at: as many as fit at 120 px.
  const cols = Math.max(1, Math.floor((inner + 10) / 130));
  const rows = Math.max(1, Math.floor((high + 10) / (120 * ratio + 10)));
  const width = Math.floor(
    Math.min((inner - (cols - 1) * 10) / cols, (high - (rows - 1) * 10) / rows / ratio),
  );
  return { cols, width, count: Math.min(n, cols * rows) };
}

export type FiguresForm = 'tile' | 'line' | 'inline' | 'block' | 'split';
export function figuresForm(
  v: { items: readonly unknown[]; spark?: readonly number[] | undefined },
  w: number,
  h: number,
): FiguresForm {
  if (w === 1) return 'tile';
  if (h === 1) return v.items.length >= 3 && w >= 4 ? 'inline' : 'line';
  if (w >= 4 && v.spark && v.spark.length > 1) return 'split';
  return 'block';
}

export type ListForm = 'line' | 'rows';
export function listForm(h: number): ListForm {
  return h === 1 ? 'line' : 'rows';
}

/** Rows that fit under the header in `ph` px, `rowH` each, at least one. */
export function rowsThatFit(ph: number, used: number, rowH: number): number {
  return Math.max(1, Math.floor((ph - used) / rowH));
}

/**
 * A list's big line goes in the header's corner when it's short (“2 new”, “2 on”) and over the rows when it says more
 * (“3 left · about 20 min”).
 */
export function headInCorner(head: string | undefined): boolean {
  return head !== undefined && [...head].length <= 12;
}

/** A board's tiles (DK-162): at least this wide and high to read, at most this big when few, this far apart (px). */
export const BOARD_TILE = { minW: 112, minH: 30, maxW: 300, maxH: 84, gap: 8 } as const;
/** A tile this high or more puts its value under its label instead of beside it. */
export const BOARD_TILE_STACKED = 52;

export interface BoardForm {
  cols: number;
  rows: number;
  /** A tile's size (px): the columns fill the width, the rows stop at `BOARD_TILE.maxH`. */
  tileW: number;
  tileH: number;
  /** How many tiles are drawn, and how many the last slot counts (“+12”); 0 draws no such slot. */
  shown: number;
  more: number;
}

/**
 * A board's grid in `inner` × `high` px for `tiles` tiles of `total` in all (the view's `count`, else its tiles): every
 * tile when they fit at a readable size, as big as the room allows up to a calm chip; else as many as fit with the last
 * slot counting the rest. Columns that make each tile the largest 3.2 : 1 rectangle win (names want width), fewer
 * columns on a tie.
 */
export function tilesThatFit(tiles: number, total: number, inner: number, high: number): BoardForm {
  const { minW, minH, maxW, maxH, gap } = BOARD_TILE;
  const all = Math.max(tiles, total);
  const maxCols = Math.max(1, Math.floor((inner + gap) / (minW + gap)));
  const maxRows = Math.max(1, Math.floor((high + gap) / (minH + gap)));
  const room = maxCols * maxRows;
  const grid = (cols: number, rows: number) => ({
    cols,
    rows,
    tileW: Math.floor((inner - (cols - 1) * gap) / cols),
    tileH: Math.floor(Math.min(maxH, (high - (rows - 1) * gap) / rows)),
  });
  // Every tile, and a slot counting those not sent when the view says there are more.
  const slots = Math.max(1, tiles + (all > tiles ? 1 : 0));
  if (slots <= room) {
    let best = grid(maxCols, Math.ceil(slots / maxCols));
    let score = -1;
    for (let cols = 1; cols <= Math.min(maxCols, slots); cols++) {
      const rows = Math.ceil(slots / cols);
      if (rows > maxRows) continue;
      const g = grid(cols, rows);
      const s = Math.min(Math.min(maxW, g.tileW) / 3.2, g.tileH);
      if (s > score + 0.5) {
        best = g;
        score = s;
      }
    }
    return { ...best, shown: tiles, more: all - tiles };
  }
  // More than fit: every slot full, the last one counting the rest.
  const shown = room - 1;
  return { ...grid(maxCols, maxRows), shown, more: all - shown };
}

/**
 * Whether a one-line tile `tileW` px wide has room for its value beside its whole name (14 px names, 13 px values, the
 * dot and padding); without, the name keeps the room and the value goes (its tone still says how it is).
 */
export function tileValueFits(label: string, value: string, tileW: number): boolean {
  return 46 + [...label].length * 8 + [...value].length * 7 <= tileW;
}

/** How often a photo view shows its next picture (seconds), as the contract allows. */
export const PHOTO_EVERY_S = { min: 30, max: 3600, default: 120 } as const;

/** How long a photo view shows each picture (ms): its `every`, two minutes unless said. */
export function photoEveryMs(every: number | undefined): number {
  const { min, max } = PHOTO_EVERY_S;
  return Math.max(min, Math.min(max, every ?? PHOTO_EVERY_S.default)) * 1000;
}

export type ChartForm = 'spark' | 'chart';
export function chartForm(h: number): ChartForm {
  return h === 1 ? 'spark' : 'chart';
}

/** How long a moment takes over the screen (the contract's `DESK_SPOTLIGHT_S`): the line under the bar runs down. */
export const SPOTLIGHT_S = 60;

/** The size a widget opens to when touched (DK-140): its largest, as far as the screen has room. */
export function bigSize(
  max: readonly [number, number],
  grid: { cols: number; rows: number },
): { w: number; h: number } {
  return { w: Math.min(max[0], grid.cols), h: Math.min(max[1], grid.rows) };
}

/** A view whose card is red, amber or dimmed (DK-136: the widgets something touches say so in their own place). */
export function viewTone(v: DeskWidgetView | undefined): 'bad' | 'warn' | 'off' | null {
  if (!v) return null;
  if (v.problem) return 'bad';
  if (v.kind === 'server' && v.state !== 'ok') return v.state;
  return v.tone && v.tone !== 'ok' ? v.tone : null;
}

/**
 * The font size a line of `text` fits `width` px at, at most `max` and at least half of it (then it ends in an
 * ellipsis). Estimated from the text's length: Bricolage's figures and letters average about 0.53 em at 650.
 */
export function fitFont(text: string, width: number, max: number): number {
  const chars = [...text].length || 1;
  return Math.round(Math.max(max / 2, Math.min(max, width / (chars * 0.53))));
}

/** Where the top bar draws the pages: names centred, names right after the Whombat's name, dots centred or after it. */
export type PagesAt = 'centre' | 'after' | 'dots' | 'dotsAfter';

/** A screen narrower than this shows its pages as dots (the mockups' tablet), names or not. */
export const PAGE_NAMES_MIN = 900;

/** The room kept between what sits in the middle of the top bar and the name or the chips. */
const BAR_ROOM = 24;
const centredInBar = (m: { bar: number; left: number; chips: number }, w: number) =>
  (m.bar - w) / 2 >= m.left + BAR_ROOM && (m.bar + w) / 2 <= m.chips - BAR_ROOM;

/**
 * The pages never touch the name, the pill or the host's chips (any width): names centred while they fit between them
 * with room to spare, else right after the name, else dots, centred or after it; a narrow screen has dots. All in the
 * bar's own pixels: `left` where the name and the pill end, `chips` where the chips begin, `names` and `dots` the pages'
 * widths drawn either way.
 */
export function pagesAt(m: {
  bar: number;
  left: number;
  chips: number;
  names: number;
  dots: number;
}): PagesAt {
  const names = m.bar >= PAGE_NAMES_MIN;
  if (names && centredInBar(m, m.names)) return 'centre';
  if (names && m.left + 34 + m.names <= m.chips - BAR_ROOM) return 'after';
  return centredInBar(m, m.dots) ? 'dots' : 'dotsAfter';
}

/**
 * Where a moment's words and *Back* go in the top bar, as the pages: centred while they fit between the name and the
 * chips, else right after the name (the box's own screen has its widest chips while it's unlocked).
 */
export function spotAt(m: { bar: number; left: number; chips: number; spot: number }): 'centre' | 'after' {
  return centredInBar(m, m.spot) ? 'centre' : 'after';
}
