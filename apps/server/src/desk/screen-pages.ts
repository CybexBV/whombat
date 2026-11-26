/**
 * A screen's pages as the runtime writes them (docs/decisions/desk-display.md): a page the assistant
 * makes from a list of widgets (`desk.screen.addPage`), placed the way the editor would, and the times of day a layout
 * from an older app leaves out, kept. Pure; `service.ts` reads and commits.
 */
import {
  DESK_PAGES_MAX,
  type DeskCatalogGroup,
  type DeskCatalogItem,
  type DeskLayout,
  type DeskPage,
  type DeskPageShow,
  type DeskWidget,
  type DeskWidgetSpec,
  deskShapeKey,
} from '@whombat/core';
import { firstFree, serverShow, sizeOf } from '@whombat/screen';

/**
 * A layout from an app that can't read a page's times (below `SCREEN_TIMES_MINOR`): each page it sends back keeps the
 * times stored for the page with its id. A page it added has none; one it removed is gone.
 */
export function keepPageTimes(sent: DeskLayout, stored: DeskLayout): DeskLayout {
  const times = new Map(stored.pages.flatMap((p) => (p.show ? [[p.id, p.show] as const] : [])));
  if (times.size === 0) return sent;
  return {
    ...sent,
    pages: sent.pages.map((p) => {
      const show = p.show ?? times.get(p.id);
      return show ? { ...p, show } : p;
    }),
  };
}

/** A widget asked for: what it is and shows, and the size it would like. */
export interface AskedWidget {
  type: DeskWidgetSpec['type'];
  ref?: string | undefined;
  opts?: Readonly<Record<string, string>> | undefined;
  w?: number | undefined;
  h?: number | undefined;
}

/**
 * The item of *Add a widget* that is this widget, or null when the Whombat offers none like it: the same type and
 * thing, a panel's same panel and item, a server's same part.
 */
export function catalogItemFor(
  groups: readonly DeskCatalogGroup[],
  w: Pick<AskedWidget, 'type' | 'ref' | 'opts'>,
): DeskCatalogItem | null {
  for (const g of groups)
    for (const item of g.items) {
      if (item.type !== w.type || (item.ref ?? null) !== (w.ref ?? null)) continue;
      if (w.type === 'panel') {
        if (item.opts.panel !== w.opts?.panel || (item.opts.item ?? null) !== (w.opts?.item ?? null))
          continue;
      } else if (w.type === 'server' && serverShow(item.opts) !== serverShow(w.opts)) continue;
      return item;
    }
  return null;
}

/** A widget id no page of the layout (nor `taken`) uses yet. */
function newWidgetId(layout: DeskLayout, taken: ReadonlySet<string>): string {
  const used = new Set(taken);
  for (const page of layout.pages)
    for (const widgets of Object.values(page.layouts)) for (const w of widgets) used.add(w.id);
  let n = used.size + 1;
  while (used.has(`w_n${n}`)) n += 1;
  return `w_n${n}`;
}

/** A page id the layout doesn't use yet (the editor's *+ Page*'s way). */
function newPageId(layout: DeskLayout): string {
  const ids = new Set(layout.pages.map((p) => p.id));
  let n = layout.pages.length + 1;
  while (ids.has(`p_n${n}`)) n += 1;
  return `p_n${n}`;
}

/** The page made, and each asked widget's id on it in the order asked (null: left out, no room). */
export type PlacePageResult =
  | { ok: true; layout: DeskLayout; page: DeskPage; ids: (string | null)[] }
  | { ok: false; why: 'pages_full' | 'unknown_page' };

/**
 * A new page on the screen's shape (`cols` × `rows`) with `widgets` in their order: each at the size asked
 * (its first size without one), kept within its smallest and largest and the grid, at the first free place in reading
 * order; with no room, smaller down to its smallest; still none, it is left out (its id null). `view` is what a panel
 * draws (its sizes). With `replace` the page takes that page's place and id; else it
 * goes last, and a seventh is refused.
 */
export function placePage(input: {
  layout: DeskLayout;
  shape: { cols: number; rows: number };
  name: string;
  widgets: readonly (AskedWidget & { view?: string | undefined })[];
  show?: DeskPageShow | undefined;
  replace?: string | undefined;
}): PlacePageResult {
  const { layout, shape } = input;
  const at = input.replace === undefined ? -1 : layout.pages.findIndex((p) => p.id === input.replace);
  if (input.replace !== undefined && at < 0) return { ok: false, why: 'unknown_page' };
  if (at < 0 && layout.pages.length >= DESK_PAGES_MAX) return { ok: false, why: 'pages_full' };
  // The page replaced gives its widgets' ids back.
  const others: DeskLayout = at < 0 ? layout : { ...layout, pages: layout.pages.filter((_, i) => i !== at) };
  const placed: DeskWidget[] = [];
  const ids: (string | null)[] = [];
  for (const asked of input.widgets) {
    const size = sizeOf({ type: asked.type, opts: asked.opts }, asked.view);
    const clamp = (v: number | undefined, d: number, lo: number, hi: number, room: number) =>
      Math.max(1, Math.min(room, Math.max(lo, Math.min(hi, v ?? d))));
    const w = clamp(asked.w, size.def[0], size.min[0], size.max[0], shape.cols);
    const h = clamp(asked.h, size.def[1], size.min[1], size.max[1], shape.rows);
    let spot: { x: number; y: number; w: number; h: number } | null = null;
    for (let hh = h; hh >= Math.min(h, size.min[1]) && !spot; hh--)
      for (let ww = w; ww >= Math.min(w, size.min[0]) && !spot; ww--) {
        const p = firstFree(placed, ww, hh, shape);
        if (p) spot = { ...p, w: ww, h: hh };
      }
    if (!spot) {
      ids.push(null);
      continue;
    }
    const id = newWidgetId(others, new Set(placed.map((x) => x.id)));
    ids.push(id);
    placed.push({
      id,
      type: asked.type,
      ...(asked.ref ? { ref: asked.ref } : {}),
      opts: { ...(asked.opts ?? {}) },
      ...spot,
    });
  }
  const key = deskShapeKey(shape.cols, shape.rows);
  const page: DeskPage = {
    id: at < 0 ? newPageId(layout) : (layout.pages[at]?.id ?? newPageId(layout)),
    name: input.name,
    layouts: { [key]: placed },
    last: key,
    ...(input.show ? { show: input.show } : {}),
  };
  const pages = at < 0 ? [...layout.pages, page] : layout.pages.map((p, i) => (i === at ? page : p));
  return { ok: true, layout: { ...layout, pages }, page, ids };
}
