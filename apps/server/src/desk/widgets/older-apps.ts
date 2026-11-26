/**
 * What an older app can't read (docs/decisions/desk-display.md, weather-news.md): an app parses a screen's
 * layout, its views and *Add a widget* with the contract it was built with, and refuses a whole answer with a widget type
 * or a view it doesn't know. So its answers leave those out — its editor shows such a widget empty, or not at all, until
 * the app is updated — and a newer app gets everything.
 *
 * - An app at session protocol minor 1 of major 4 had no `photo` or `board` views and no `account:` refs; every app of
 *   major 5 reads them.
 * - An app below `WEATHER_NEWS_MINOR` has no `weather` or `news` widgets and no `weather` view. Its layouts come without
 *   them, and when it saves a layout the widgets it couldn't see are put back where they were (`withHiddenWidgets`).
 */
import type {
  DeskCatalogGroup,
  DeskGrid,
  DeskLayout,
  DeskScreenDetail,
  DeskWidget,
  DeskWidgetView,
} from '@whombat/core';
import { DESK_PAGE_WIDGETS_MAX, parseDeskShapeKey } from '@whombat/core';
import { WEATHER_NEWS_MINOR } from '@whombat/protocol/session';

/** The protocol minor that reads `photo`, `board` and accounts' widgets. */
export const PHOTO_BOARD_ACCOUNTS_MINOR = 2;

const NEW_VIEWS: ReadonlySet<string> = new Set(['photo', 'board']);
/** The widget types and views an app below `WEATHER_NEWS_MINOR` doesn't know. */
const WEATHER_NEWS_TYPES: ReadonlySet<string> = new Set(['weather', 'news']);
const WEATHER_NEWS_VIEWS: ReadonlySet<string> = new Set(['weather']);

/**
 * Whether a session at `minor` reads them; outside a session (`undefined`), it does. Every app of session major 5
 * (contracts 4.0) reads them, whatever its minor: the minor counts again from 0 within the new major.
 */
export const readsNewWidgets = (_minor: number | undefined) => true;

/** Whether a session at `minor` reads the `weather` and `news` widgets; outside a session (`undefined`), it does. */
export const readsWeatherNews = (minor: number | undefined) =>
  minor === undefined || minor >= WEATHER_NEWS_MINOR;

/** A screen's views as an app at `minor` reads them. */
export function viewsFor<V extends Pick<DeskWidgetView, 'kind'>>(
  views: readonly V[],
  minor: number | undefined,
): V[] {
  return views.filter(
    (v) =>
      (readsNewWidgets(minor) || !NEW_VIEWS.has(v.kind)) &&
      (readsWeatherNews(minor) || !WEATHER_NEWS_VIEWS.has(v.kind)),
  );
}

/** *Add a widget* as an app at `minor` reads it: nothing it can't draw or name. */
export function catalogFor(
  groups: readonly DeskCatalogGroup[],
  minor: number | undefined,
): DeskCatalogGroup[] {
  let out = [...groups];
  if (!readsNewWidgets(minor))
    out = out
      .filter((g) => !g.key.startsWith('account:') && !g.thing?.startsWith('account:'))
      .map((g) => ({ ...g, items: g.items.filter((i) => !i.view || !NEW_VIEWS.has(i.view)) }));
  if (!readsWeatherNews(minor))
    out = out.map((g) => ({
      ...g,
      items: g.items.filter(
        (i) => !WEATHER_NEWS_TYPES.has(i.type) && (!i.view || !WEATHER_NEWS_VIEWS.has(i.view)),
      ),
    }));
  return out;
}

/** A layout without the widgets an app at `minor` doesn't know. */
export function layoutFor(layout: DeskLayout, minor: number | undefined): DeskLayout {
  if (readsWeatherNews(minor)) return layout;
  return {
    ...layout,
    pages: layout.pages.map((p) => ({
      ...p,
      layouts: Object.fromEntries(
        Object.entries(p.layouts).map(([shape, widgets]) => [
          shape,
          widgets.filter((w) => !WEATHER_NEWS_TYPES.has(w.type)),
        ]),
      ),
    })),
  };
}

/** A screen as an app at `minor` reads it. */
export function screenDetailFor(detail: DeskScreenDetail, minor: number | undefined): DeskScreenDetail {
  return readsWeatherNews(minor) ? detail : { ...detail, layout: layoutFor(detail.layout, minor) };
}

/** A screen elsewhere's grid as an app at `minor` reads it: its layout and its views. */
export function gridFor(grid: DeskGrid, minor: number | undefined): DeskGrid {
  if (readsWeatherNews(minor)) return grid;
  const layout = layoutFor(grid.layout, minor);
  const kept = new Set(
    layout.pages.flatMap((p) =>
      Object.values(p.layouts)
        .flat()
        .map((w) => w.id),
    ),
  );
  return { ...grid, layout, views: viewsFor(grid.views, minor).filter((v) => kept.has(v.id)) };
}

const overlaps = (a: DeskWidget, b: DeskWidget) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A layout an app at `minor` saves, with the widgets it couldn't see (`stored`'s weather and news) put back: on the same
 * page and shape, at the same place and size, while that place is free, inside the shape and the page has room. One
 * whose page or shape the app removed, or whose place it filled, is left out.
 */
export function withHiddenWidgets(
  saved: DeskLayout,
  stored: DeskLayout,
  minor: number | undefined,
): DeskLayout {
  if (readsWeatherNews(minor)) return saved;
  const storedPages = new Map(stored.pages.map((p) => [p.id, p]));
  return {
    ...saved,
    pages: saved.pages.map((page) => {
      const before = storedPages.get(page.id);
      if (!before) return page;
      const layouts = Object.fromEntries(
        Object.entries(page.layouts).map(([shape, widgets]) => {
          const hidden = (before.layouts[shape] ?? []).filter((w) => WEATHER_NEWS_TYPES.has(w.type));
          const size = parseDeskShapeKey(shape);
          const out = [...widgets];
          for (const w of hidden) {
            if (out.length >= DESK_PAGE_WIDGETS_MAX || !size) break;
            const inside = w.x + w.w <= size.cols && w.y + w.h <= size.rows;
            if (!inside || out.some((o) => o.id === w.id || overlaps(o, w))) continue;
            out.push(w);
          }
          return [shape, out];
        }),
      );
      return { ...page, layouts };
    }),
  };
}
