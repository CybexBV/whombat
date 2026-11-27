/**
 * The editor's grid on a phone (Whombat desk-display.md DK-145; desk-display-android.md AP-6012…AP-6015): the screen's
 * cells drawn as labelled tiles — each widget's mark, name and size, no live drawing — at sizes a finger can hit, what
 * each tile says to TalkBack, and the phone's own words for the editor (the shared ones are `DESK_SCREENS_TEXT`). Pure.
 */
import {
  type DeskCatalogItem,
  type DeskWidget,
  type DeskWidgetView,
  deskScreensText,
  fillDeskWords,
  gridText,
  ownWidgetName,
} from '@whombat/client/desk';
import { type Grid, serverShow } from '@whombat/screen';
import { mobileTranslator } from '../../i18n/translate';

/** The phone's words for Settings → Screens and the editor, beyond the shared ones (`DESK_SCREENS_TEXT`). */
export function phoneScreensText(locale?: string | null) {
  const { t } = mobileTranslator(locale);
  return {
    add: t('settings2.screens.add'),
    addHint: t('settings2.screens.addHint'),
    full: t('settings2.screens.full'),
    lettersIo: t('settings2.screens.lettersIo'),
    demoLetters: t('settings2.screens.demoLetters'),
    open: t('settings2.screens.open'),
    editLayoutLine: t('settings2.screens.editLayoutLine'),
    tapHint: t('settings2.screens.tapHint'),
    emptyPage: t('settings2.screens.emptyPage'),
    page: t('settings2.screens.page'),
    pageName: t('settings2.screens.pageName'),
    pageNameHint: t('settings2.screens.pageNameHint'),
    screen: t('settings2.screens.screen'),
    sizeHint: t('settings2.screens.sizeHint'),
    move: t('settings2.screens.move'),
    moveTo: {
      left: t('settings2.screens.moveLeft'),
      right: t('settings2.screens.moveRight'),
      up: t('settings2.screens.moveUp'),
      down: t('settings2.screens.moveDown'),
    },
    where: t('settings2.screens.where'),
    done: t('settings2.screens.done'),
    trying: t('settings2.screens.trying'),
    tryIt: t('settings2.screens.tryIt'),
    newPage: t('settings2.screens.newPage'),
    pairFirst: t('settings2.screens.pairFirst'),
    pageMore: t('settings2.screens.pageMore'),
    orderUp: t('settings2.screens.moveUp'),
    orderDown: t('settings2.screens.moveDown'),
  } as const;
}

export const PHONE_SCREENS_TEXT = phoneScreensText();

/**
 * The smallest a cell is drawn (dp) and the gap between cells: with a 4dp slop on each side every tile is 44dp to the
 * finger, and the box's 8 columns fit a 360dp phone without scrolling.
 */
export const TILE_MIN = 36;
export const TILE_GAP = 4;
/** What each tile gets on each side beyond its box: the gap, so a touch between two tiles goes to one of them. */
export const TILE_SLOP = TILE_GAP;

/** The tile grid: a cell's size in dp, the whole grid's, and whether it's wider than the room it has (it scrolls). */
export interface TileGeometry {
  cols: number;
  rows: number;
  cell: { w: number; h: number };
  gap: number;
  width: number;
  height: number;
  scroll: boolean;
}

/**
 * The tiles for grid `g` in `room` dp across: the cells share the width with the screen's own proportions (a cell as
 * tall as the screen's cell is for its width), never smaller than 40dp either way; a grid that doesn't fit at that
 * (a monitor's 12 columns) is wider than the room and scrolls sideways.
 */
export function tileGeometry(g: Pick<Grid, 'cols' | 'rows' | 'cw' | 'ch'>, room: number): TileGeometry {
  const gap = TILE_GAP;
  const fit = (room - (g.cols - 1) * gap) / g.cols;
  const w = Math.max(TILE_MIN, Math.floor(fit * 10) / 10);
  const h = Math.max(TILE_MIN, Math.round(w * (g.ch / g.cw) * 10) / 10);
  const width = g.cols * w + (g.cols - 1) * gap;
  const height = g.rows * h + (g.rows - 1) * gap;
  return { cols: g.cols, rows: g.rows, cell: { w, h }, gap, width, height, scroll: width > room + 0.5 };
}

/** Where a widget's tile sits, in dp from the grid's top left. */
export function tileRect(
  t: TileGeometry,
  c: Pick<DeskWidget, 'x' | 'y' | 'w' | 'h'>,
): { left: number; top: number; width: number; height: number } {
  return {
    left: c.x * (t.cell.w + t.gap),
    top: c.y * (t.cell.h + t.gap),
    width: c.w * t.cell.w + (c.w - 1) * t.gap,
    height: c.h * t.cell.h + (c.h - 1) * t.gap,
  };
}

/** What a tile has room for: its mark only, its mark and name, or the name with its size under it. */
export function tileFace(box: { width: number; height: number }): 'mark' | 'name' | 'full' {
  if (box.width < 72) return 'mark';
  if (box.height < 60) return 'name';
  return 'full';
}

/**
 * What a tile shows: its name, what it belongs to (“Plex”), its mark, and its own widgets' icon; what it draws where
 * known (`view`: a photo or a board has an icon that says so).
 */
export interface TileLabel {
  name: string;
  of: string | null;
  mark: string | null;
  view?: string | null | undefined;
}

/** What the editor knows of a widget beyond its type: the item it was added from (its name, mark and view). */
export type KnownWidget = Pick<DeskCatalogItem, 'name' | 'mark' | 'view'> & { of?: string };

/**
 * A widget's name on its tile: Whombat's own by their names (“{assistant}’s work”), the rest by their view (“Now
 * playing” of “Plex”, “pve-01”, a server's part “pve-01 · Storage”), else by the item it was added from, else by what it
 * names (“con_plex”).
 */
export function tileLabel(
  w: Pick<DeskWidget, 'id' | 'type' | 'ref'> & { opts?: Readonly<Record<string, string>> | undefined },
  view: (Pick<DeskWidgetView, 'title' | 'name' | 'mark'> & { kind?: string }) | undefined,
  known: KnownWidget | undefined,
  assistant: string,
  locale?: string | null,
): TileLabel {
  const own = ownWidgetName(w.type, assistant, locale);
  if (own) return { name: own, of: null, mark: null };
  const kind = view?.kind ?? known?.view;
  const drawn = kind ? { view: kind } : {};
  // A server's part is named by its server, as *Add a widget* names it (the view's title is the part's).
  if (
    view &&
    w.type === 'server' &&
    serverShow(w.opts) !== 'overview' &&
    view.name &&
    view.name !== view.title
  )
    return {
      name: `${view.name} · ${view.title}`,
      of: null,
      mark: view.mark ?? known?.mark ?? null,
      ...drawn,
    };
  if (view)
    return {
      name: view.title,
      of: view.name && view.name !== view.title ? view.name : (known?.of ?? null),
      mark: view.mark ?? known?.mark ?? null,
      ...drawn,
    };
  if (known) return { name: known.name, of: known.of ?? null, mark: known.mark ?? null, ...drawn };
  const named = w.ref ? w.ref.slice(w.ref.indexOf(':') + 1) : w.type;
  return { name: named, of: null, mark: null };
}

/** What TalkBack reads for a tile: “Now playing, Plex, 4 by 2, column 5, row 1”. */
export function tileSpoken(
  label: TileLabel,
  w: Pick<DeskWidget, 'x' | 'y' | 'w' | 'h'>,
  locale?: string | null,
): string {
  const name = label.of ? `${label.name}, ${label.of}` : label.name;
  return fillDeskWords(deskScreensText(locale).editor.widgetLabel, {
    name,
    w: w.w,
    h: w.h,
    x: w.x + 1,
    y: w.y + 1,
  });
}

/** “4 × 2, from column 5, row 1”: where the chosen widget is, under its name in its sheet. */
export function tileWhere(w: Pick<DeskWidget, 'x' | 'y' | 'w' | 'h'>, locale?: string | null): string {
  return fillDeskWords(phoneScreensText(locale).where, { w: w.w, h: w.h, x: w.x + 1, y: w.y + 1 });
}

/** “From 2 × 1 to 6 × 3. It shows more as it grows.” */
export function sizesLine(
  size: { min: readonly [number, number]; max: readonly [number, number] },
  locale?: string | null,
): string {
  return fillDeskWords(deskScreensText(locale).editor.sizes, {
    min: gridText(size.min[0], size.min[1], locale),
    max: gridText(size.max[0], size.max[1], locale),
  });
}

/** Under the grid when a rearranging left widgets out: “2 didn’t fit here after rearranging. They wait in …”. */
export function didntFitLine(n: number, locale?: string | null): string | null {
  if (n <= 0) return null;
  return mobileTranslator(locale).t('settings2.screens.didntFit', { n });
}
