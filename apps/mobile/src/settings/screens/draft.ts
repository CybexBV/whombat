/**
 * The phone's layout draft (Whombat desk-display.md DK-132, DK-133, DK-143…DK-145, DK-164…DK-167; desk-display-android.md
 * AP-6010…, AP-9980…):
 * the editor's state around the shared rules of `@whombat/client/desk`'s editor — the layout as changed so far, the
 * page shown, the widget chosen, what *Didn’t fit* after a rearranging, the screen's *What’s going on* and *Servers*
 * choices changed with it, and Undo. Every change is a new draft or the reason it can't be made; nothing reaches the
 * screen before Save. Pure: the editor screen keeps one in its state, the tests drive it directly.
 */

import {
  addPage,
  addWidget,
  chooseWidget,
  type DeskCatalogItem,
  type DeskLayout,
  type DeskPageShow,
  type DeskScreenDetail,
  type DeskShowPatch,
  type DeskSize,
  type DeskTurn,
  type DeskWidget,
  deletePage,
  didntFit,
  type EditorRefusal,
  editorGrid,
  editorPage,
  growWidget,
  movePage,
  type NewWidget,
  newWidgetId,
  nudgeWidget,
  popUndo,
  pushUndo,
  removeWidget,
  renamePage,
  resizeWidget,
  sameLayout,
  setLayoutSize,
  setLayoutTurn,
  setPageShow,
  setWidgetSpec,
  tidyPage,
  type UndoStack,
  type ViewOf,
  widgetSize,
} from '@whombat/client/desk';
import { type Grid, shapeKey } from '@whombat/screen';

/** What Undo puts back. */
interface Snapshot {
  layout: DeskLayout;
  show: DeskShowPatch | null;
  page: number;
  left: Readonly<Record<string, readonly DeskWidget[]>>;
}

export interface Draft extends Snapshot {
  /** The layout as the screen has it (when the editor opened, or saved last). */
  saved: DeskLayout;
  /** The screen's size as it last said; null before it did (drawn at 1280 × 800). */
  size: { width: number; height: number } | null;
  /** The widget chosen on the grid (its sheet open on the phone), or none. */
  selected: string | null;
  undo: UndoStack<Snapshot>;
}

export type DraftResult =
  | { ok: true; draft: Draft; swapped?: string }
  | { ok: false; why: EditorRefusal; grow?: boolean; size?: { w: number; h: number } };

/** A new draft of a screen as it is. */
export function draftOf(screen: Pick<DeskScreenDetail, 'layout' | 'size'>): Draft {
  return {
    saved: screen.layout,
    layout: screen.layout,
    show: null,
    page: 0,
    left: {},
    size: screen.size,
    selected: null,
    undo: { past: [] },
  };
}

export const draftGrid = (d: Pick<Draft, 'size' | 'layout'>): Grid => editorGrid(d.size, d.layout.size);

/** Where a page's left-overs are kept: the page and the shape. */
const leftKey = (pageId: string, g: Pick<Grid, 'cols' | 'rows'>) => `${pageId} ${shapeKey(g)}`;

/**
 * What the page shown draws on the screen's grid now: its widgets in reading order (row by row, left to right, the
 * order TalkBack reads the tiles in), whether it's rearranged from another shape (`from`), and what didn't fit.
 */
export function draftPage(d: Draft, viewOf?: ViewOf) {
  const g = draftGrid(d);
  const shown = editorPage(d.layout, d.page, g, viewOf);
  const page = d.layout.pages[d.page];
  const kept = page ? (d.left[leftKey(page.id, g)] ?? []) : [];
  const left = shown.rearranged ? shown.left : didntFit(shown.widgets, kept);
  return {
    grid: g,
    widgets: [...shown.widgets].sort((a, b) => a.y - b.y || a.x - b.x),
    left,
    rearranged: shown.rearranged,
    from: shown.from,
  };
}

/** Whether anything changed since the screen's own (a choice changed, or the layout isn't the saved one). */
export function draftDirty(d: Draft): boolean {
  return d.show !== null || !sameLayout(d.layout, d.saved);
}

/**
 * A change on the page shown: Undo can take it back, and a page rearranged for this shape keeps what didn't fit in
 * *Didn’t fit* once the change makes the rearranged layout its own.
 */
function changed(d: Draft, next: Partial<Snapshot> & { selected?: string | null }, viewOf?: ViewOf): Draft {
  const before: Snapshot = { layout: d.layout, show: d.show, page: d.page, left: d.left };
  let left = d.left;
  const page = d.layout.pages[d.page];
  if (page && next.layout) {
    const g = draftGrid(d);
    const shown = editorPage(d.layout, d.page, g, viewOf);
    if (shown.rearranged && shown.left.length > 0) left = { ...left, [leftKey(page.id, g)]: shown.left };
  }
  return {
    ...d,
    ...next,
    left: next.left ?? left,
    selected: next.selected === undefined ? d.selected : next.selected,
    undo: pushUndo(d.undo, before),
  };
}

const widgetOn = (d: Draft, id: string, viewOf?: ViewOf) =>
  editorPage(d.layout, d.page, draftGrid(d), viewOf).widgets.find((w) => w.id === id);

/**
 * *Move*'s arrows: one cell left, right, up or down; onto exactly one other widget the two change places (`swapped`,
 * DK-167); another taken spot or the edge refuses.
 */
export function draftNudge(d: Draft, id: string, dx: number, dy: number, viewOf?: ViewOf): DraftResult {
  const r = nudgeWidget(d.layout, d.page, draftGrid(d), id, dx, dy, viewOf);
  if (!r.ok) return r;
  if (r.layout === d.layout) return { ok: true, draft: d };
  return {
    ok: true,
    draft: changed(d, { layout: r.layout }, viewOf),
    ...(r.swapped ? { swapped: r.swapped } : {}),
  };
}

/** *Size*'s − and +: one cell narrower or wider (`w`), lower or higher (`h`), within its sizes and the room it has. */
export function draftGrow(d: Draft, id: string, dim: 'w' | 'h', by: number, viewOf?: ViewOf): DraftResult {
  const r = growWidget(d.layout, d.page, draftGrid(d), id, dim, by, viewOf);
  if (!r.ok) {
    // The words say its smallest or its largest (“It doesn’t get smaller than 2 × 1.”).
    const w = widgetOn(d, id, viewOf);
    const s = w ? widgetSize(w, viewOf) : null;
    const limit = s && (r.why === 'tooSmall' ? s.min : r.why === 'tooBig' ? s.max : null);
    return { ok: false, why: r.why, grow: true, ...(limit ? { size: { w: limit[0], h: limit[1] } } : {}) };
  }
  if (r.layout === d.layout) return { ok: true, draft: d };
  return { ok: true, draft: changed(d, { layout: r.layout }, viewOf) };
}

/** *Size*'s shapes (DK-165): `w` × `h` at once, within its sizes and the room it has. */
export function draftResize(
  d: Draft,
  id: string,
  size: { w: number; h: number },
  viewOf?: ViewOf,
): DraftResult {
  const r = resizeWidget(d.layout, d.page, draftGrid(d), id, size, viewOf);
  if (!r.ok) return { ok: false, why: r.why };
  if (r.layout === d.layout) return { ok: true, draft: d };
  return { ok: true, draft: changed(d, { layout: r.layout }, viewOf) };
}

/** Whether the arrow towards `dx`, `dy` can do anything: not at the grid's edge. A taken spot still says why. */
export function canNudge(d: Draft, id: string, dx: number, dy: number, viewOf?: ViewOf): boolean {
  const g = draftGrid(d);
  const w = widgetOn(d, id, viewOf);
  if (!w) return false;
  const x = w.x + dx;
  const y = w.y + dy;
  return x >= 0 && y >= 0 && x + w.w <= g.cols && y + w.h <= g.rows;
}

/** *Remove from this page*: Undo brings it back. */
export function draftRemove(d: Draft, id: string, viewOf?: ViewOf): Draft {
  const layout = removeWidget(d.layout, d.page, draftGrid(d), id, viewOf);
  return changed(d, { layout, selected: d.selected === id ? null : d.selected }, viewOf);
}

/**
 * *Add a widget*'s *Add*: the first free spot in reading order at the size it starts, smaller if it must (`smaller`);
 * one from *Didn’t fit* comes back with its id and the size it had. `view` what the item draws (a panel's sizes
 * depend on it: a camera's still is never under 2 × 2), known before the runtime resolved the new widget. The new widget
 * is the one chosen.
 */
export function draftAdd(
  d: Draft,
  widget: NewWidget,
  viewOf?: ViewOf,
  view?: string,
): { ok: true; draft: Draft; id: string; smaller: boolean } | { ok: false; why: EditorRefusal } {
  const id = widget.id ?? newWidgetId(d.layout);
  const sized: ViewOf | undefined = view ? (w) => (w.id === id ? view : viewOf?.(w)) : viewOf;
  const r = addWidget(d.layout, d.page, draftGrid(d), { ...widget, id }, undefined, sized);
  if (!r.ok) return r;
  return {
    ok: true,
    draft: changed(d, { layout: r.layout, selected: r.id }, viewOf),
    id: r.id,
    smaller: r.smaller,
  };
}

/** A widget's own settings (DK-144): what it shows and its options, on every shape it's on. */
export function draftSpec(
  d: Draft,
  id: string,
  spec: { ref?: string; opts: Record<string, string> },
  viewOf?: ViewOf,
): Draft {
  return changed(d, { layout: setWidgetSpec(d.layout, id, spec) }, viewOf);
}

/**
 * *What it shows* (DK-164): the widget shows another view of its connection, server or account (figures and panels
 * alike), on every shape it's on, in its place: it shrinks to the new view's largest and grows to its smallest where
 * there's room; where there isn't, it stays as it was and says so.
 */
export function draftChoose(d: Draft, id: string, item: DeskCatalogItem, viewOf?: ViewOf): DraftResult {
  const r = chooseWidget(d.layout, id, item);
  if (!r.ok) return r;
  const chosen: ViewOf = (w) => (w.id === id ? item.view : viewOf?.(w));
  return { ok: true, draft: changed(d, { layout: r.layout }, chosen) };
}

/** *Tidy up* (DK-166): the page shown packed up and to the left; `moved` none when it was tidy already. */
export function draftTidy(
  d: Draft,
  viewOf?: ViewOf,
): { ok: true; draft: Draft; moved: number } | { ok: false; why: EditorRefusal } {
  const r = tidyPage(d.layout, d.page, draftGrid(d), viewOf);
  if (!r.ok) return r;
  if (r.moved === 0) return { ok: true, draft: d, moved: 0 };
  return { ok: true, draft: changed(d, { layout: r.layout }, viewOf), moved: r.moved };
}

/** Two changes to the screen's choices as one: the later wins, item by item. */
export function mergeShowPatch(a: DeskShowPatch | null, b: DeskShowPatch): DeskShowPatch {
  if (!a) return b;
  const items = a.items || b.items ? { ...a.items, ...b.items } : undefined;
  const bar = a.bar || b.bar ? { ...a.bar, ...b.bar } : undefined;
  return { ...a, ...b, ...(items ? { items } : {}), ...(bar ? { bar } : {}) };
}

/**
 * *What’s going on*'s choices and *Servers*' order (DK-144): the screen's, not the layout's, but changed in the editor
 * like the rest — sent with Save, taken back by Undo.
 */
export function draftShow(d: Draft, patch: DeskShowPatch): Draft {
  return changed(d, { show: mergeShowPatch(d.show, patch) });
}

/* Pages ------------------------------------------------------------------------------------------------------------ */

/** Another page to look at and change (not a change itself). */
export function draftGoPage(d: Draft, index: number): Draft {
  if (index < 0 || index >= d.layout.pages.length || index === d.page) return d;
  return { ...d, page: index, selected: null };
}

/** *+ Page*: an empty page after the others, shown at once; refused at six. */
export function draftAddPage(d: Draft): DraftResult {
  const r = addPage(d.layout, draftGrid(d));
  if (!r.ok) return r;
  return { ok: true, draft: changed(d, { layout: r.layout, page: r.index, selected: null }) };
}

export function draftRenamePage(d: Draft, index: number, name: string): Draft {
  const layout = renamePage(d.layout, index, name);
  return layout === d.layout ? d : changed(d, { layout });
}

/** *Delete page*: the page before it shows next; the last page can't go. */
export function draftDeletePage(d: Draft, index: number): DraftResult {
  const r = deletePage(d.layout, index);
  if (!r.ok) return r;
  const shown = index === d.page ? index - 1 : index < d.page ? d.page - 1 : d.page;
  const page = Math.max(0, Math.min(shown, r.layout.pages.length - 1));
  return { ok: true, draft: changed(d, { layout: r.layout, page, selected: null }) };
}

/** *Show at set times…*: page `index` at these times, or always (`null`); null when no day is chosen. */
export function draftPageShow(d: Draft, index: number, show: DeskPageShow | null): Draft | null {
  const layout = setPageShow(d.layout, index, show);
  if (!layout) return null;
  return layout === d.layout ? d : changed(d, { layout });
}

/** *Move left* / *Move right* on a page's sheet: its place among the pages. */
export function draftMovePage(d: Draft, index: number, by: -1 | 1): Draft {
  const r = movePage(d.layout, index, by);
  if (r.layout === d.layout) return d;
  const page = d.page === index ? r.index : d.page === r.index ? index : d.page;
  return changed(d, { layout: r.layout, page });
}

/* The screen ------------------------------------------------------------------------------------------------------- */

/** *Size*: a new grid, each page drawn rearranged for it where it has no layout of its own. */
export function draftSize(d: Draft, size: DeskSize): Draft {
  if (d.layout.size === size) return d;
  return changed(d, { layout: setLayoutSize(d.layout, size), selected: null });
}

export function draftTurn(d: Draft, turn: DeskTurn): Draft {
  if (d.layout.turn === turn) return d;
  return changed(d, { layout: setLayoutTurn(d.layout, turn) });
}

export function draftSelect(d: Draft, id: string | null): Draft {
  return d.selected === id ? d : { ...d, selected: id };
}

/** Undo: the draft as it was before the last change; null when there's nothing to take back. */
export function draftUndo(d: Draft): Draft | null {
  const r = popUndo(d.undo);
  if (!r) return null;
  const selected = r.value.layout.pages[r.value.page] ? d.selected : null;
  return { ...d, ...r.value, selected, undo: r.stack };
}

/** Saved: the draft is the screen's own now (Undo still goes back through it). */
export function draftSaved(d: Draft, layout: DeskLayout): Draft {
  return { ...d, saved: layout, layout, show: null };
}
