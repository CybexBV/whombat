/**
 * The layout editor's rules (3.6; Whombat desk-display.md DK-129…DK-133, DK-143, DK-145, DK-164…DK-167), pure so the
 * web's editor and the phone's share them and they're tested without a page: what a page shows on the screen's grid
 * (its own layout for this shape, else its latest rearranged, with what didn't fit), and every change — move (two
 * widgets change places when one lands on the other), resize and the size's shapes, add, remove, what a widget shows
 * and its settings, *Tidy up*, pages, Size and page turning — as a new draft or the reason it can't be made. Nothing is
 * pushed aside. The grid and the sizes are `@whombat/screen`'s, the same the screen draws with.
 */
import {
  clampSize,
  firstFree,
  fits,
  type Grid,
  overlaps,
  pageOn,
  parseShape,
  screenGrid,
  shapeKey,
  sizeOf,
  type WidgetSize,
} from '@whombat/screen';
import {
  DESK_PAGE_WIDGETS_MAX,
  DESK_PAGES_MAX,
  DESK_SCREEN_WORDS,
  type DeskCatalogItem,
  type DeskLayout,
  type DeskPage,
  type DeskSize,
  type DeskTurn,
  type DeskWidget,
  type DeskWidgetSpec,
  deskEmptyPage,
  deskLayoutProblem,
  fillDeskWords,
} from './contract';

/** Shapes a page keeps a layout for (the contract's `DESK_PAGE_SHAPES_MAX`). */
const SHAPES_MAX = 8;
/** The size a screen is drawn at in the editor before it said its own (DK-143). */
export const EDITOR_DEFAULT_SIZE = { width: 1280, height: 800 } as const;

/** A panel's view kind when known (its sizes depend on it); other widgets' sizes come from their type. */
export type ViewOf = (w: Pick<DeskWidget, 'id' | 'type'>) => string | undefined;

/** The grid the editor draws a screen on: its size as it last said (else 1280 × 800) at the layout's Size. */
export function editorGrid(size: { width: number; height: number } | null, layoutSize: DeskSize): Grid {
  const s = size ?? EDITOR_DEFAULT_SIZE;
  return screenGrid(s.width, s.height, layoutSize);
}

/** A widget's sizes: a server's by what it shows, a panel's by its view when known. */
export function widgetSize(
  w: Pick<DeskWidget, 'id' | 'type'> & { opts?: Readonly<Record<string, string>> | undefined },
  viewOf?: ViewOf,
): WidgetSize {
  return sizeOf(w, viewOf?.(w));
}

/**
 * What page `index` shows on grid `g`: its own widgets for this shape, or its latest layout rearranged (`rearranged`,
 * `from` the shape it came from), with what didn't fit (`left`).
 */
export function editorPage(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  viewOf?: ViewOf,
) {
  const page = layout.pages[index];
  if (!page)
    return { widgets: [] as DeskWidget[], left: [] as DeskWidget[], rearranged: false, from: shapeKey(g) };
  return pageOn<DeskWidget>(page, g, viewOf ? (w) => viewOf(w) : undefined);
}

/** The page's layout keys in age order, without the oldest beyond the contract's limit (`last` always stays). */
function trimShapes(page: DeskPage): DeskPage {
  const keys = Object.keys(page.layouts);
  if (keys.length <= SHAPES_MAX) return page;
  const drop = keys.filter((k) => k !== page.last).slice(0, keys.length - SHAPES_MAX);
  const layouts = { ...page.layouts };
  for (const k of drop) delete layouts[k];
  return { ...page, layouts };
}

/** `layout` with page `index` changed by `change`. */
function withPage(layout: DeskLayout, index: number, change: (page: DeskPage) => DeskPage): DeskLayout {
  return { ...layout, pages: layout.pages.map((p, i) => (i === index ? change(p) : p)) };
}

/**
 * The layout with page `index`'s widgets for this shape set to `widgets`: kept for this shape and made the latest, so
 * other shapes without their own rearrange from it (DK-132: changing a rearranged page keeps it for that shape).
 */
export function setPageWidgets(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  widgets: readonly DeskWidget[],
): DeskLayout {
  const key = shapeKey(g);
  return withPage(layout, index, (page) => {
    const layouts = { ...page.layouts };
    delete layouts[key];
    // Re-inserted last: the newest shape is the last key, so trimming drops the oldest.
    layouts[key] = [...widgets];
    return trimShapes({ ...page, layouts, last: key });
  });
}

/** Why a change couldn't be made, for the editor's words (`EDITOR_WORDS.refused`). */
export type EditorRefusal =
  | 'taken'
  | 'noRoom'
  | 'tooSmall'
  | 'tooBig'
  | 'full'
  | 'pagesFull'
  | 'lastPage'
  | 'tidy';

export type EditorResult = { ok: true; layout: DeskLayout } | { ok: false; why: EditorRefusal };

const refused = (why: EditorRefusal): EditorResult => ({ ok: false, why });

/**
 * Where widget `id` moved to `cell` (its size kept) goes: there when it's free; when it lands on exactly one other
 * widget, the two change places (DK-167) — it takes the other's top left corner and the other takes its old one, each
 * keeping its size — if both then fit; else nowhere (`ok` false). The web draws the change while dragging from this.
 */
export function moveSpot(
  widgets: readonly DeskWidget[],
  g: Pick<Grid, 'cols' | 'rows'>,
  id: string,
  cell: { x: number; y: number },
): { ok: false } | { ok: true; x: number; y: number; swap: { id: string; x: number; y: number } | null } {
  const w = widgets.find((x) => x.id === id);
  if (!w) return { ok: false };
  const next = { ...w, x: cell.x, y: cell.y };
  if (fits(widgets, next, g, id)) return { ok: true, x: cell.x, y: cell.y, swap: null };
  if (next.x < 0 || next.y < 0 || next.x + next.w > g.cols || next.y + next.h > g.rows) return { ok: false };
  const under = widgets.filter((o) => o.id !== id && overlaps(o, next));
  const other = under.length === 1 ? under[0] : undefined;
  if (!other) return { ok: false };
  const moved = { ...w, x: other.x, y: other.y };
  const back = { ...other, x: w.x, y: w.y };
  const rest = widgets.filter((o) => o.id !== id && o.id !== other.id);
  if (!fits(rest, moved, g) || !fits(rest, back, g) || overlaps(moved, back)) return { ok: false };
  return { ok: true, x: other.x, y: other.y, swap: { id: other.id, x: w.x, y: w.y } };
}

/** A move's result: `swapped` the widget it changed places with. */
export type MoveResult =
  | { ok: true; layout: DeskLayout; swapped?: string }
  | { ok: false; why: EditorRefusal };

/**
 * Moves widget `id` to `cell` (its size kept); onto exactly one other widget the two change places (`moveSpot`).
 * Refused when the spot is taken otherwise or off the grid.
 */
export function moveWidget(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  id: string,
  cell: { x: number; y: number },
  viewOf?: ViewOf,
): MoveResult {
  const { widgets } = editorPage(layout, index, g, viewOf);
  const w = widgets.find((x) => x.id === id);
  if (!w) return refused('taken');
  const spot = moveSpot(widgets, g, id, cell);
  if (!spot.ok) return refused('taken');
  if (spot.x === w.x && spot.y === w.y) return { ok: true, layout };
  const { swap } = spot;
  const next = widgets.map((x) =>
    x.id === id
      ? { ...x, x: spot.x, y: spot.y }
      : swap && x.id === swap.id
        ? { ...x, x: swap.x, y: swap.y }
        : x,
  );
  return {
    ok: true,
    layout: setPageWidgets(layout, index, g, next),
    ...(swap ? { swapped: swap.id } : {}),
  };
}

/** The page's widgets with the one whose id `next` has put in its place. */
const replaceWidget = (widgets: readonly DeskWidget[], next: DeskWidget) =>
  widgets.map((x) => (x.id === next.id ? next : x));

/**
 * Resizes widget `id` to `w` × `h` from its top left: refused below its smallest (`tooSmall`), above its largest
 * (`tooBig`) or onto another (`noRoom`).
 */
export function resizeWidget(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  id: string,
  size: { w: number; h: number },
  viewOf?: ViewOf,
): EditorResult {
  const { widgets } = editorPage(layout, index, g, viewOf);
  const w = widgets.find((x) => x.id === id);
  if (!w) return refused('noRoom');
  const limits = widgetSize(w, viewOf);
  if (size.w < limits.min[0] || size.h < limits.min[1]) return refused('tooSmall');
  if (size.w > limits.max[0] || size.h > limits.max[1]) return refused('tooBig');
  const next = { ...w, w: size.w, h: size.h };
  if (!fits(widgets, next, g, id)) return refused('noRoom');
  if (next.w === w.w && next.h === w.h) return { ok: true, layout };
  return { ok: true, layout: setPageWidgets(layout, index, g, replaceWidget(widgets, next)) };
}

/** The keyboard's and the phone's buttons: one cell left, right, up or down (onto another, the two change places). */
export function nudgeWidget(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  id: string,
  dx: number,
  dy: number,
  viewOf?: ViewOf,
): MoveResult {
  const w = editorPage(layout, index, g, viewOf).widgets.find((x) => x.id === id);
  if (!w) return refused('taken');
  return moveWidget(layout, index, g, id, { x: w.x + dx, y: w.y + dy }, viewOf);
}

/** Shift and the arrows, and the size steppers: one cell wider or narrower (`w`), higher or lower (`h`). */
export function growWidget(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  id: string,
  dim: 'w' | 'h',
  by: number,
  viewOf?: ViewOf,
): EditorResult {
  const w = editorPage(layout, index, g, viewOf).widgets.find((x) => x.id === id);
  if (!w) return refused('noRoom');
  return resizeWidget(
    layout,
    index,
    g,
    id,
    { w: w.w + (dim === 'w' ? by : 0), h: w.h + (dim === 'h' ? by : 0) },
    viewOf,
  );
}

/** The size's shapes (DK-165), in this order. */
export const SIZE_PRESETS = ['small', 'normal', 'wide', 'tall', 'large'] as const;
export type SizePresetKey = (typeof SIZE_PRESETS)[number];

/**
 * The shapes a widget's *Size* offers (DK-165), from its sizes and the grid: *Small* its smallest, *Normal* the size it
 * starts at, *Wide* that twice as wide, *Tall* twice as high, *Large* both — each as far as its largest and the grid
 * allow. A shape the same as an earlier one, or one its smallest or the grid rules out, isn't offered.
 */
export function sizePresets(
  limits: WidgetSize,
  g: Pick<Grid, 'cols' | 'rows'>,
): { key: SizePresetKey; w: number; h: number }[] {
  const maxW = Math.min(limits.max[0], g.cols);
  const maxH = Math.min(limits.max[1], g.rows);
  const w = Math.min(limits.def[0], maxW);
  const h = Math.min(limits.def[1], maxH);
  const wide = Math.min(w * 2, maxW);
  const tall = Math.min(h * 2, maxH);
  const all: { key: SizePresetKey; w: number; h: number }[] = [
    { key: 'small', w: limits.min[0], h: limits.min[1] },
    { key: 'normal', w, h },
    { key: 'wide', w: wide, h },
    { key: 'tall', w, h: tall },
    { key: 'large', w: wide, h: tall },
  ];
  const out: typeof all = [];
  for (const p of all) {
    if (p.w < limits.min[0] || p.h < limits.min[1] || p.w > maxW || p.h > maxH) continue;
    if (out.some((o) => o.w === p.w && o.h === p.h)) continue;
    out.push(p);
  }
  return out;
}

/** Takes widget `id` off this page's layout for this shape (Undo brings it back). */
export function removeWidget(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  id: string,
  viewOf?: ViewOf,
): DeskLayout {
  const { widgets } = editorPage(layout, index, g, viewOf);
  return setPageWidgets(
    layout,
    index,
    g,
    widgets.filter((x) => x.id !== id),
  );
}

/** A widget id no page of the layout uses yet. */
export function newWidgetId(layout: DeskLayout): string {
  const used = new Set<string>();
  for (const page of layout.pages)
    for (const widgets of Object.values(page.layouts)) for (const w of widgets) used.add(w.id);
  let n = used.size + 1;
  while (used.has(`w_n${n}`)) n += 1;
  return `w_n${n}`;
}

/** A widget to place: what it is and shows, and its id when it's one coming back (from *Didn’t fit*). */
export type NewWidget = Pick<DeskWidgetSpec, 'type' | 'ref' | 'opts'> & {
  id?: string;
  w?: number;
  h?: number;
  /** What it draws as *Add a widget* says (`DeskCatalogItem.view`): a new panel starts at that view's size. */
  view?: string;
};

/** Where a widget goes and whether it had to be smaller than it starts (`smaller`). */
export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  smaller: boolean;
}

/**
 * *+* on *Add a widget* (DK-143): the first free spot in reading order at the size it starts (`def`, or the size it
 * had), else smaller down to its smallest; null when the page has no room.
 */
export function freeSpot(
  widgets: readonly DeskWidget[],
  g: Pick<Grid, 'cols' | 'rows'>,
  size: WidgetSize,
  want?: { w: number; h: number },
): Placement | null {
  const start = clampSize(size, want?.w ?? size.def[0], want?.h ?? size.def[1]);
  const w0 = Math.min(start.w, g.cols);
  const h0 = Math.min(start.h, g.rows);
  for (let h = h0; h >= size.min[1]; h--)
    for (let w = w0; w >= size.min[0]; w--) {
      const p = firstFree(widgets, w, h, g);
      if (p) return { ...p, w, h, smaller: w < start.w || h < start.h };
    }
  return null;
}

/**
 * Dragging one in from *Add a widget*: centred on the cell under the pointer at the size it starts; where that's
 * taken, the biggest size that fits over that cell. `ok` false: the spot is taken (drawn red).
 */
export function dropSpot(
  widgets: readonly DeskWidget[],
  g: Pick<Grid, 'cols' | 'rows'>,
  size: WidgetSize,
  at: { x: number; y: number },
  want?: { w: number; h: number },
): Placement & { ok: boolean } {
  const start = clampSize(size, want?.w ?? size.def[0], want?.h ?? size.def[1]);
  const w0 = Math.min(start.w, g.cols);
  const h0 = Math.min(start.h, g.rows);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const centred = {
    x: clamp(at.x - Math.floor((w0 - 1) / 2), 0, g.cols - w0),
    y: clamp(at.y - Math.floor((h0 - 1) / 2), 0, g.rows - h0),
    w: w0,
    h: h0,
  };
  if (fits(widgets, centred, g)) return { ...centred, smaller: w0 < start.w || h0 < start.h, ok: true };
  // Each size from its own down, every place that still covers the cell under the pointer, nearest the centre first.
  for (let h = h0; h >= size.min[1]; h--)
    for (let w = w0; w >= size.min[0]; w--) {
      const places: { x: number; y: number; w: number; h: number }[] = [];
      for (let y = clamp(at.y - h + 1, 0, g.rows - h); y <= clamp(at.y, 0, g.rows - h); y++)
        for (let x = clamp(at.x - w + 1, 0, g.cols - w); x <= clamp(at.x, 0, g.cols - w); x++)
          places.push({ x, y, w, h });
      places.sort(
        (a, b) =>
          Math.abs(a.x - centred.x) +
          Math.abs(a.y - centred.y) -
          Math.abs(b.x - centred.x) -
          Math.abs(b.y - centred.y),
      );
      const c = places.find((p) => fits(widgets, p, g));
      if (c) return { ...c, smaller: w < start.w || h < start.h, ok: true };
    }
  return { ...centred, smaller: false, ok: false };
}

/**
 * Puts a widget on page `index` (DK-143): at `at` when dropped there, else the first free spot, smaller if it must.
 * Refused when the page is full (`full`: 24 widgets, or no room) or the spot is taken. Answers the new widget's id.
 */
export function addWidget(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  widget: NewWidget,
  at?: { x: number; y: number; w: number; h: number },
  viewOf?: ViewOf,
): (EditorResult & { ok: false }) | { ok: true; layout: DeskLayout; id: string; smaller: boolean } {
  const { widgets } = editorPage(layout, index, g, viewOf);
  if (widgets.length >= DESK_PAGE_WIDGETS_MAX) return { ok: false, why: 'full' };
  const id = widget.id ?? newWidgetId(layout);
  // Not resolved yet, a new panel knows its view only from the catalogue.
  const size = widgetSize({ id, type: widget.type, opts: widget.opts }, (w) =>
    w.id === id && widget.view ? widget.view : viewOf?.(w),
  );
  const place = at
    ? { ...at, smaller: at.w < size.def[0] || at.h < size.def[1] }
    : freeSpot(widgets, g, size, widget.w && widget.h ? { w: widget.w, h: widget.h } : undefined);
  if (!place) return { ok: false, why: 'full' };
  const next: DeskWidget = {
    id,
    type: widget.type,
    ...(widget.ref ? { ref: widget.ref } : {}),
    opts: { ...widget.opts },
    x: place.x,
    y: place.y,
    w: place.w,
    h: place.h,
  };
  if (!fits(widgets, next, g)) return { ok: false, why: 'taken' };
  return {
    ok: true,
    layout: setPageWidgets(layout, index, g, [...widgets, next]),
    id,
    smaller: place.smaller,
  };
}

/**
 * A widget's own settings (DK-144) — what it shows (`ref`) and its options — on every shape of every page where it
 * is, since a widget keeps its id and what it shows across shapes.
 */
export function setWidgetSpec(
  layout: DeskLayout,
  id: string,
  spec: { ref?: string; opts: Record<string, string> },
): DeskLayout {
  return {
    ...layout,
    pages: layout.pages.map((page) => ({
      ...page,
      layouts: Object.fromEntries(
        Object.entries(page.layouts).map(([key, widgets]) => [
          key,
          widgets.map((w) => {
            if (w.id !== id) return w;
            const next = {
              ...w,
              ...(spec.ref !== undefined ? { ref: spec.ref } : {}),
              opts: { ...spec.opts },
            };
            // What it shows now may be smaller at most (a server's temperature is figures): it shrinks to fit.
            const max = sizeOf(next).max;
            return { ...next, w: Math.min(next.w, max[0]), h: Math.min(next.h, max[1]) };
          }),
        ]),
      ),
    })),
  };
}

/**
 * A widget's options once it shows `item` instead (DK-164): the item's own (its panel, its part), and of what it had
 * everything but what it showed — its chart's range, a photo's pace — with *On a locked screen* kept only where the new
 * one is private too.
 */
export function chosenOpts(
  current: Readonly<Record<string, string>>,
  item: Pick<DeskCatalogItem, 'opts' | 'private'>,
): Record<string, string> {
  const { panel: _panel, show: _show, lock, ...kept } = current;
  return { ...kept, ...item.opts, ...(item.private && lock ? { lock } : {}) };
}

/**
 * *What it shows*: widget `id` shows `item` instead (DK-164) — another view of its connection, server or account, a
 * connection's figures or one of its panels — on every shape of every page where it is, in its place: it shrinks to the
 * new view's largest and grows to its smallest. Refused (`noRoom`) where growing would run onto another widget or off
 * the grid, and nothing changes.
 */
export function chooseWidget(
  layout: DeskLayout,
  id: string,
  item: Pick<DeskCatalogItem, 'type' | 'ref' | 'opts' | 'view' | 'private'>,
): EditorResult {
  let found = false;
  let blocked = false;
  const pages = layout.pages.map((page) => ({
    ...page,
    layouts: Object.fromEntries(
      Object.entries(page.layouts).map(([key, widgets]) => {
        const w = widgets.find((x) => x.id === id);
        if (!w) return [key, widgets];
        found = true;
        const opts = chosenOpts(w.opts, item);
        const size = clampSize(sizeOf({ type: item.type, opts }, item.view), w.w, w.h);
        const next: DeskWidget = {
          id,
          type: item.type,
          ...(item.ref ? { ref: item.ref } : {}),
          opts,
          x: w.x,
          y: w.y,
          ...size,
        };
        const shape = parseShape(key);
        if (shape && !fits(widgets, next, shape, id)) blocked = true;
        return [key, replaceWidget(widgets, next)];
      }),
    ),
  }));
  if (!found || blocked) return refused('noRoom');
  return { ok: true, layout: { ...layout, pages } };
}

/**
 * What waits in *Didn’t fit* on this page and shape: what the rearranging left out (`left`, kept by the editor once the
 * rearranged layout became this shape's own) and isn't on the page now.
 */
export function didntFit(widgets: readonly DeskWidget[], left: readonly DeskWidget[]): DeskWidget[] {
  const here = new Set(widgets.map((w) => w.id));
  return left.filter((w) => !here.has(w.id));
}

/**
 * *Tidy up* (DK-166): page `index`'s widgets packed up and to the left — in reading order, each at the first free spot
 * with its size kept, so nothing is dropped. `moved` how many moved (none: the layout as it was). Refused (`tidy`) in
 * the rare page whose widgets don't all fit packed that way; nothing moves then.
 */
export function tidyPage(
  layout: DeskLayout,
  index: number,
  g: Pick<Grid, 'cols' | 'rows'>,
  viewOf?: ViewOf,
): { ok: true; layout: DeskLayout; moved: number } | { ok: false; why: EditorRefusal } {
  const { widgets } = editorPage(layout, index, g, viewOf);
  const placed: DeskWidget[] = [];
  let moved = 0;
  for (const w of [...widgets].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const spot = firstFree(placed, w.w, w.h, g);
    if (!spot) return { ok: false, why: 'tidy' };
    if (spot.x !== w.x || spot.y !== w.y) moved += 1;
    placed.push({ ...w, ...spot });
  }
  if (moved === 0) return { ok: true, layout, moved };
  const at = new Map(placed.map((w) => [w.id, w]));
  return {
    ok: true,
    layout: setPageWidgets(
      layout,
      index,
      g,
      widgets.map((w) => at.get(w.id) ?? w),
    ),
    moved,
  };
}

/* Pages (DK-133) --------------------------------------------------------------------------------------------------- */

/** *+ Page*: an empty page named “Page {n}” after the others; refused at six. */
export function addPage(
  layout: DeskLayout,
  g: Pick<Grid, 'cols' | 'rows'>,
): { ok: true; layout: DeskLayout; index: number } | { ok: false; why: EditorRefusal } {
  if (layout.pages.length >= DESK_PAGES_MAX) return { ok: false, why: 'pagesFull' };
  const ids = new Set(layout.pages.map((p) => p.id));
  let n = layout.pages.length + 1;
  while (ids.has(`p_n${n}`)) n += 1;
  const names = new Set(layout.pages.map((p) => p.name));
  let k = layout.pages.length + 1;
  while (names.has(fillDeskWords(DESK_SCREEN_WORDS.newPage, { n: k }))) k += 1;
  const page = deskEmptyPage(`p_n${n}`, fillDeskWords(DESK_SCREEN_WORDS.newPage, { n: k }), shapeKey(g));
  return { ok: true, layout: { ...layout, pages: [...layout.pages, page] }, index: layout.pages.length };
}

/** The longest page name (the contract's). */
export const PAGE_NAME_MAX = 24;

/** A page's name as typed: one line, spaces run together, at most 24 characters; null when nothing is left. */
export function pageName(typed: string): string | null {
  const flat = [
    ...typed
      .replace(/[\s\p{Z}]+/gu, ' ')
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
      .trim(),
  ];
  return flat.length ? flat.slice(0, PAGE_NAME_MAX).join('').trimEnd() : null;
}

export function renamePage(layout: DeskLayout, index: number, name: string): DeskLayout {
  const clean = pageName(name);
  return clean ? withPage(layout, index, (p) => ({ ...p, name: clean })) : layout;
}

/** Deletes page `index`; the last page can't go. */
export function deletePage(layout: DeskLayout, index: number): EditorResult {
  if (layout.pages.length <= 1) return refused('lastPage');
  return { ok: true, layout: { ...layout, pages: layout.pages.filter((_, i) => i !== index) } };
}

/** Moves page `index` one place earlier (−1) or later (+1); at an end it stays. */
export function movePage(
  layout: DeskLayout,
  index: number,
  by: -1 | 1,
): { layout: DeskLayout; index: number } {
  const to = index + by;
  if (to < 0 || to >= layout.pages.length) return { layout, index };
  const pages = [...layout.pages];
  const [page] = pages.splice(index, 1);
  if (page) pages.splice(to, 0, page);
  return { layout: { ...layout, pages }, index: to };
}

export const setLayoutSize = (layout: DeskLayout, size: DeskSize): DeskLayout => ({ ...layout, size });
export const setLayoutTurn = (layout: DeskLayout, turn: DeskTurn): DeskLayout => ({ ...layout, turn });

/**
 * Why the draft can't be saved, in the contract's few words; null when it can: the contract's checks, then every
 * widget within its sizes (the runtime refuses those as `bad_layout` too).
 */
export function draftProblem(layout: DeskLayout, viewOf?: ViewOf): string | null {
  const problem = deskLayoutProblem(layout);
  if (problem) return problem;
  for (const page of layout.pages)
    for (const widgets of Object.values(page.layouts))
      for (const w of widgets) {
        const s = widgetSize(w, viewOf);
        if (w.w < s.min[0] || w.h < s.min[1] || w.w > s.max[0] || w.h > s.max[1])
          return `${w.id} is ${w.w} × ${w.h}`;
      }
  return null;
}

/** Whether two layouts are the same (the draft against what's saved). */
export function sameLayout(a: DeskLayout, b: DeskLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* Moving with the pointer ------------------------------------------------------------------------------------------ */

/**
 * The cell a widget dragged by `dx`, `dy` logical pixels lands on (snapped to the nearest cell, kept on the grid), or
 * the size its corner dragged that far gives (clamped to its sizes and the grid).
 */
export function dragTarget(
  g: Pick<Grid, 'cols' | 'rows' | 'cw' | 'ch'>,
  from: { x: number; y: number; w: number; h: number },
  mode: 'move' | 'resize',
  dx: number,
  dy: number,
  size: WidgetSize,
  gap: number,
): { x: number; y: number; w: number; h: number } {
  const stepX = g.cw + gap;
  const stepY = g.ch + gap;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (mode === 'move')
    return {
      x: clamp(Math.round(from.x + dx / stepX), 0, g.cols - from.w),
      y: clamp(Math.round(from.y + dy / stepY), 0, g.rows - from.h),
      w: from.w,
      h: from.h,
    };
  return {
    x: from.x,
    y: from.y,
    w: clamp(
      Math.round(from.w + dx / stepX),
      size.min[0],
      Math.max(size.min[0], Math.min(size.max[0], g.cols - from.x)),
    ),
    h: clamp(
      Math.round(from.h + dy / stepY),
      size.min[1],
      Math.max(size.min[1], Math.min(size.max[1], g.rows - from.y)),
    ),
  };
}

/* The keyboard (DK-143) -------------------------------------------------------------------------------------------- */

export type EditorKey =
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'grow'; dim: 'w' | 'h'; by: number }
  | { kind: 'remove' }
  | { kind: 'deselect' }
  | { kind: 'undo' };

const ARROWS: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * What a key does in the editor: the arrows move the chosen widget, Shift and the arrows resize it, Delete (and
 * Backspace) removes it, Escape lets it go, ⌘Z / Ctrl Z undoes. Null: the key isn't the editor's.
 */
export function editorKey(e: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): EditorKey | null {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z')
    return { kind: 'undo' };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const arrow = ARROWS[e.key];
  if (arrow) {
    const [dx, dy] = arrow;
    return e.shiftKey
      ? dx
        ? { kind: 'grow', dim: 'w', by: dx }
        : { kind: 'grow', dim: 'h', by: dy }
      : { kind: 'move', dx, dy };
  }
  if (e.key === 'Delete' || e.key === 'Backspace') return { kind: 'remove' };
  if (e.key === 'Escape') return { kind: 'deselect' };
  return null;
}

/* Undo ------------------------------------------------------------------------------------------------------------- */

/** How many steps Undo goes back. */
export const UNDO_MAX = 80;

/** The undo stack: each change pushes what was before; Undo pops it. */
export interface UndoStack<T> {
  past: readonly T[];
}

export function pushUndo<T>(stack: UndoStack<T>, before: T): UndoStack<T> {
  const past = [...stack.past, before];
  return { past: past.length > UNDO_MAX ? past.slice(past.length - UNDO_MAX) : past };
}

export function popUndo<T>(stack: UndoStack<T>): { stack: UndoStack<T>; value: T } | null {
  const value = stack.past[stack.past.length - 1];
  if (value === undefined) return null;
  return { stack: { past: stack.past.slice(0, -1) }, value };
}
