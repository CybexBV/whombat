/**
 * The editor's draft (Whombat desk-display.md DK-143, DK-164…DK-167; desk-display-web.md AP-5950…, AP-9970…): the layout
 * being changed, the page open, the widget chosen, what each change replaced (Undo) and what didn't fit after
 * rearranging. Every change goes through `@whombat/client/desk`'s editor rules; this only keeps the state and says what
 * happened in words.
 */
import {
  addPage,
  addWidget,
  chooseWidget,
  type DeskCatalogItem,
  type DeskLayout,
  type DeskPageShow,
  type DeskSize,
  type DeskTurn,
  type DeskWidget,
  deletePage,
  didntFit,
  type EditorRefusal,
  type EditorResult,
  editorGrid,
  editorPage,
  fillDeskWords,
  gridText,
  growWidget,
  type MoveResult,
  movePage,
  moveWidget,
  type NewWidget,
  nudgeWidget,
  pageShowSaid,
  popUndo,
  pushUndo,
  refusalText,
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
import { useCallback, useMemo, useRef, useState } from 'react';
import { DESK_SCREENS_TEXT } from '../../../i18n/clientWords';
import { currentLocale } from '../../../i18n/provider';

const E = DESK_SCREENS_TEXT.editor;

interface Snapshot {
  layout: DeskLayout;
  page: number;
}

export interface EditorState {
  draft: DeskLayout;
  saved: DeskLayout;
  page: number;
  selected: string | null;
  undo: UndoStack<Snapshot>;
  /** What the rearranging left out, per page and shape, kept once the rearranged layout became the shape's own. */
  left: Record<string, DeskWidget[]>;
}

export interface ScreenEditor {
  state: EditorState;
  grid: Grid;
  /** The open page's widgets on this grid. */
  widgets: DeskWidget[];
  /** The page is drawn rearranged from another shape (`from`), not changed here yet. */
  rearranged: string | null;
  /** What waits in *Didn’t fit*. */
  tray: DeskWidget[];
  dirty: boolean;
  select(id: string | null): void;
  setPage(index: number): void;
  undo(): string | null;
  move(id: string, cell: { x: number; y: number }): string | null;
  resize(id: string, size: { w: number; h: number }): string | null;
  nudge(id: string, dx: number, dy: number): string | null;
  grow(id: string, dim: 'w' | 'h', by: number): string | null;
  remove(id: string, name: string): string;
  /** Puts a widget on the page: what to say, and the new widget's id when it went on. */
  add(
    widget: NewWidget,
    name: string,
    at?: { x: number; y: number; w: number; h: number },
  ): { text: string; id: string | null };
  setSpec(id: string, spec: { ref?: string; opts: Record<string, string> }): void;
  /** *What it shows*: another view of its connection, server or account, in its place; what to say when refused. */
  choose(id: string, item: DeskCatalogItem): string | null;
  /** *Tidy up*: the open page packed up and to the left; what to say. */
  tidy(): string;
  addPage(): string;
  renamePage(index: number, name: string): void;
  movePage(index: number, by: -1 | 1): void;
  deletePage(index: number): string;
  /** Page `index` at set times, or always (`null`): what to say, or why it can't be (no day chosen). */
  setPageShow(index: number, show: DeskPageShow | null): { ok: boolean; text: string };
  setSize(size: DeskSize): string;
  setTurn(turn: DeskTurn): string;
  /** After *Save*: what's saved now. */
  markSaved(layout: DeskLayout): void;
}

const leftKey = (layout: DeskLayout, page: number, g: Pick<Grid, 'cols' | 'rows'>) =>
  `${layout.pages[page]?.id ?? ''}|${shapeKey(g)}`;

/**
 * The editor's state for a screen `size` (as it last said) starting from `initial`; `viewOf` knows each panel's view
 * kind (its sizes), `nameOf` a widget's name for the words (“Swapped Clock and Weather.”).
 */
export function useScreenEditor(
  initial: DeskLayout,
  size: { width: number; height: number } | null,
  viewOf: ViewOf,
  nameOf: (w: DeskWidget) => string = (w) => w.id,
): ScreenEditor {
  const [state, setState] = useState<EditorState>(() => ({
    draft: initial,
    saved: initial,
    page: 0,
    selected: null,
    undo: { past: [] },
    left: {},
  }));
  // The latest state for the callbacks, so a quick second change reads the first's result.
  const live = useRef(state);
  live.current = state;
  const set = useCallback((next: EditorState) => {
    live.current = next;
    setState(next);
  }, []);
  const view = useRef(viewOf);
  view.current = viewOf;
  const names = useRef(nameOf);
  names.current = nameOf;

  const grid = editorGrid(size, state.draft.size);
  const page = editorPage(state.draft, state.page, grid, viewOf);
  const kept = state.left[leftKey(state.draft, state.page, grid)] ?? [];
  const tray = didntFit(page.widgets, page.rearranged ? page.left : kept);

  return useMemo(() => {
    const gridOf = (layout: DeskLayout) => editorGrid(size, layout.size);
    /** Applies a change that keeps the page's widgets for this shape: remembers what didn't fit first. */
    const commit = (s: EditorState, layout: DeskLayout, extra: Partial<EditorState> = {}): EditorState => {
      const g = gridOf(s.draft);
      const before = editorPage(s.draft, s.page, g, view.current);
      const key = leftKey(s.draft, s.page, g);
      const left = before.rearranged && before.left.length ? { ...s.left, [key]: before.left } : s.left;
      return {
        ...s,
        draft: layout,
        undo: pushUndo(s.undo, { layout: s.draft, page: s.page }),
        left,
        ...extra,
      };
    };
    const run = (result: EditorResult, refusal: (why: EditorRefusal) => string): string | null => {
      const s = live.current;
      if (!result.ok) return refusal(result.why);
      if (result.layout !== s.draft) set(commit(s, result.layout));
      return null;
    };
    /** A move done: two widgets that changed places say so (DK-167). */
    const moved = (s: EditorState, r: Extract<MoveResult, { ok: true }> & { id: string }): string | null => {
      if (r.layout !== s.draft) set(commit(s, r.layout));
      if (!r.swapped) return null;
      const before = editorPage(s.draft, s.page, gridOf(s.draft), view.current).widgets;
      const name = (id: string) => {
        const w = before.find((x) => x.id === id);
        return w ? names.current(w) : id;
      };
      return fillDeskWords(E.swapped, { a: name(r.id), b: name(r.swapped) });
    };
    const sizeOfId = (id: string) => {
      const s = live.current;
      const w = editorPage(s.draft, s.page, gridOf(s.draft), view.current).widgets.find((x) => x.id === id);
      return w ? widgetSize(w, view.current) : null;
    };
    const limitText = (id: string, why: EditorRefusal, grow: boolean) => {
      const limits = sizeOfId(id);
      const size =
        why === 'tooSmall' && limits
          ? { w: limits.min[0], h: limits.min[1] }
          : why === 'tooBig' && limits
            ? { w: limits.max[0], h: limits.max[1] }
            : undefined;
      return refusalText(why, size, grow, currentLocale());
    };
    return {
      state,
      grid,
      widgets: page.widgets,
      rearranged: page.rearranged ? page.from : null,
      tray,
      dirty: !sameLayout(state.draft, state.saved),
      select: (id) => set({ ...live.current, selected: id }),
      setPage: (index) => set({ ...live.current, page: index, selected: null }),
      undo() {
        const s = live.current;
        const back = popUndo(s.undo);
        if (!back) return null;
        set({
          ...s,
          draft: back.value.layout,
          page: Math.min(back.value.page, back.value.layout.pages.length - 1),
          selected: null,
          undo: back.stack,
        });
        return E.undone;
      },
      move: (id, cell) => {
        const s = live.current;
        const r = moveWidget(s.draft, s.page, gridOf(s.draft), id, cell, view.current);
        return r.ok ? moved(s, { ...r, id }) : refusalText(r.why, undefined, undefined, currentLocale());
      },
      resize: (id, size) => {
        const s = live.current;
        return run(resizeWidget(s.draft, s.page, gridOf(s.draft), id, size, view.current), (why) =>
          limitText(id, why, false),
        );
      },
      nudge: (id, dx, dy) => {
        const s = live.current;
        // An arrow into a taken spot or off the grid does nothing, as a key pressed at an edge.
        const r = nudgeWidget(s.draft, s.page, gridOf(s.draft), id, dx, dy, view.current);
        return r.ok ? moved(s, { ...r, id }) : null;
      },
      grow: (id, dim, by) => {
        const s = live.current;
        return run(growWidget(s.draft, s.page, gridOf(s.draft), id, dim, by, view.current), (why) =>
          limitText(id, why, true),
        );
      },
      remove(id, name) {
        const s = live.current;
        set(commit(s, removeWidget(s.draft, s.page, gridOf(s.draft), id, view.current), { selected: null }));
        return fillDeskWords(E.removed, { name });
      },
      add(widget, name, at) {
        const s = live.current;
        const r = addWidget(s.draft, s.page, gridOf(s.draft), widget, at, view.current);
        if (!r.ok)
          return {
            text: at ? E.refused.drop : refusalText(r.why, undefined, undefined, currentLocale()),
            id: null,
          };
        set(commit(s, r.layout, { selected: r.id }));
        return { text: fillDeskWords(r.smaller ? E.addedSmaller : E.added, { name }), id: r.id };
      },
      setSpec(id, spec) {
        const s = live.current;
        set(commit(s, setWidgetSpec(s.draft, id, spec)));
      },
      choose(id, item) {
        const s = live.current;
        const r = chooseWidget(s.draft, id, item);
        if (!r.ok) return refusalText(r.why, undefined, undefined, currentLocale());
        if (r.layout !== s.draft) set(commit(s, r.layout));
        return null;
      },
      tidy() {
        const s = live.current;
        const r = tidyPage(s.draft, s.page, gridOf(s.draft), view.current);
        if (!r.ok) return refusalText(r.why, undefined, undefined, currentLocale());
        if (r.moved === 0) return E.alreadyTidy;
        set(commit(s, r.layout));
        return E.tidied;
      },
      addPage() {
        const s = live.current;
        const r = addPage(s.draft, gridOf(s.draft));
        if (!r.ok) return refusalText(r.why, undefined, undefined, currentLocale());
        set({ ...commit(s, r.layout), page: r.index, selected: null });
        return E.newPage;
      },
      renamePage(index, name) {
        const s = live.current;
        const next = renamePage(s.draft, index, name);
        if (next !== s.draft) set(commit(s, next));
      },
      movePage(index, by) {
        const s = live.current;
        const r = movePage(s.draft, index, by);
        if (r.layout !== s.draft) set({ ...commit(s, r.layout), page: r.index });
      },
      deletePage(index) {
        const s = live.current;
        const name = s.draft.pages[index]?.name ?? '';
        const r = deletePage(s.draft, index);
        if (!r.ok) return refusalText(r.why, undefined, undefined, currentLocale());
        set({
          ...commit(s, r.layout),
          page: Math.max(0, Math.min(index, r.layout.pages.length - 1)),
          selected: null,
        });
        return fillDeskWords(E.deletedPage, { name });
      },
      setPageShow(index, show) {
        const s = live.current;
        const next = setPageShow(s.draft, index, show);
        if (!next) return { ok: false, text: E.times.noDays };
        if (next !== s.draft) set(commit(s, next));
        return {
          ok: true,
          text: pageShowSaid(next.pages[index]?.name ?? '', next.pages[index]?.show ?? null, currentLocale()),
        };
      },
      setSize(size) {
        const s = live.current;
        const layout = setLayoutSize(s.draft, size);
        set({
          ...s,
          draft: layout,
          undo: pushUndo(s.undo, { layout: s.draft, page: s.page }),
          selected: null,
        });
        const g = gridOf(layout);
        const p = editorPage(layout, s.page, g, view.current);
        const grid = gridText(g.cols, g.rows, currentLocale());
        if (!p.rearranged) return fillDeskWords(E.sizeOwn, { grid });
        return p.left.length
          ? fillDeskWords(E.sizeChangedLeft, { grid, n: p.left.length })
          : fillDeskWords(E.sizeChanged, { grid });
      },
      setTurn(turn) {
        const s = live.current;
        set({
          ...s,
          draft: setLayoutTurn(s.draft, turn),
          undo: pushUndo(s.undo, { layout: s.draft, page: s.page }),
        });
        return turn === 'touch' ? E.turnTouch : fillDeskWords(E.turnAuto, { every: E.every[turn] });
      },
      markSaved(layout) {
        set({ ...live.current, saved: layout, draft: layout });
      },
    };
  }, [state, grid, page, tray, size, set]);
}
