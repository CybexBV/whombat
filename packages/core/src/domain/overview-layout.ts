/**
 * How the Overview is arranged (Whombat docs/decisions/overview-arranged.md): one layout for the whole Whombat, which
 * the person changes with the page's Arrange. It says what each connection's tile shows, how big it is and where it
 * sits, which four figures lead the page, and how wide each pinned chart is. A tile shows what a desk-screen widget
 * would (`DeskWidgetSpec` of type `figures` or `panel`), so the figures and panels a tile offers and the values it draws
 * come from the same place as the screens' (`overview.figures`, `overview.views`).
 *
 * A thing that isn't in the layout (connected after it was arranged) gets a small tile with its figures at the end; one
 * the person removed keeps its entry with `hidden` and waits under *Add to Overview*. Never arranged: `null`, and the
 * page draws the starting layout (`overviewStartingLayout` in the client).
 */
import { z } from 'zod';
import { WidgetId } from '../ids.js';
import { DESK_WIDGET_RANGES, type DeskWidgetRef } from './desk-screens.js';

/** What a tile is about: a connection, a device, or one of the person's accounts (`account:<id>`, `account:github`). */
export const OVERVIEW_THING_RE = /^(connection|device|account):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const OverviewThing = z.string().regex(OVERVIEW_THING_RE);
export type OverviewThing = z.infer<typeof OverviewThing>;

/** A tile's size: small (one cell), wide (two across), large (two across, two down). */
export const OVERVIEW_TILE_SIZES = ['s', 'w', 'l'] as const;
export const OverviewTileSize = z.enum(OVERVIEW_TILE_SIZES);
export type OverviewTileSize = z.infer<typeof OverviewTileSize>;

/** A chart's time span, as the desk's widgets have it. */
export const OverviewRange = z.enum(DESK_WIDGET_RANGES);
export type OverviewRange = z.infer<typeof OverviewRange>;

/** A panel of a thing's page, by its id (the desk's `opts.panel`). */
export const OverviewPanel = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

/**
 * What a tile or a figure shows of its thing: its main figures (no `panel`), or one panel of its page. `range` the time
 * span of its chart, where it has one (absent: a day).
 */
export const OverviewShow = z.object({
  panel: OverviewPanel.optional(),
  range: OverviewRange.optional(),
});
export type OverviewShow = z.infer<typeof OverviewShow>;

export const OverviewLayoutTile = OverviewShow.extend({
  thing: OverviewThing,
  size: OverviewTileSize,
  /** Removed from the Overview: it waits under *Add to Overview*. */
  hidden: z.literal(true).optional(),
});
export type OverviewLayoutTile = z.infer<typeof OverviewLayoutTile>;

/**
 * Whombat's own figures for the top of the page: how many servers run, how many connections work, what needs the
 * person, what the assistant finished today.
 */
export const OVERVIEW_OWN_FIGURES = ['servers', 'connections', 'needsYou', 'doneToday'] as const;
export const OverviewOwnFigure = z.enum(OVERVIEW_OWN_FIGURES);
export type OverviewOwnFigure = z.infer<typeof OverviewOwnFigure>;

/** One of the four figures at the top: Whombat's own, or a thing's (its first figure, with its chart). */
export const OverviewLayoutTop = z.union([
  z.strictObject({ own: OverviewOwnFigure }),
  OverviewShow.extend({ thing: OverviewThing }).strict(),
]);
export type OverviewLayoutTop = z.infer<typeof OverviewLayoutTop>;
export const OVERVIEW_TOP_COUNT = 4;

/** A pinned chart's width (half the page or all of it) and whether it was removed from the Overview. */
export const OVERVIEW_PIN_SIZES = ['half', 'full'] as const;
export const OverviewPinSize = z.enum(OVERVIEW_PIN_SIZES);
export type OverviewPinSize = z.infer<typeof OverviewPinSize>;
export const OverviewLayoutPin = z.object({
  size: OverviewPinSize.optional(),
  hidden: z.literal(true).optional(),
});
export type OverviewLayoutPin = z.infer<typeof OverviewLayoutPin>;

export const OVERVIEW_TILES_MAX = 200;
export const OVERVIEW_PINS_MAX = 24;

export const OverviewLayout = z.object({
  /** The tiles in their order, removed ones included. */
  tiles: z.array(OverviewLayoutTile).max(OVERVIEW_TILES_MAX),
  /** The figures at the top, in their order. */
  top: z.array(OverviewLayoutTop).max(OVERVIEW_TOP_COUNT),
  /** The pinned charts' widths and which were removed, by widget id; their order is the pins' own (`widgets.move`). */
  pins: z
    .record(WidgetId, OverviewLayoutPin)
    .refine((r) => Object.keys(r).length <= OVERVIEW_PINS_MAX)
    .default(() => ({})),
});
export type OverviewLayout = z.infer<typeof OverviewLayout>;

/** Why a layout can't be kept (a thing twice), in a few words; null when it can. */
export function overviewLayoutProblem(layout: OverviewLayout): string | null {
  const seen = new Set<string>();
  for (const t of layout.tiles) {
    if (seen.has(t.thing)) return `${t.thing} twice`;
    seen.add(t.thing);
  }
  return null;
}

/* What a tile shows, as the desk's widgets ------------------------------------------------------------------------ */

/**
 * The desk-screen widget a tile or a figure is (`overview.views` resolves these): `figures` of the thing, or one
 * `panel` of its page, with its range. `id` names it in the answer.
 */
export function overviewWidgetSpec(
  id: string,
  show: OverviewShow & { thing: OverviewThing },
): { id: string; type: 'figures' | 'panel'; ref: DeskWidgetRef; opts: Record<string, string> } {
  const opts: Record<string, string> = {};
  if (show.panel) opts.panel = show.panel;
  if (show.range) opts.range = show.range;
  return { id, type: show.panel ? 'panel' : 'figures', ref: show.thing, opts };
}

/** FNV-1a, base 36: a short stable name for what a tile shows, so its view is kept while tiles move. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The widget id of what a tile or figure shows: the same thing, panel and span read once for both. */
export function overviewShowId(show: OverviewShow & { thing: string }): string {
  return `w_${shortHash(`${show.thing}|${show.panel ?? ''}|${show.range ?? ''}`)}`;
}

/**
 * `overview.views`' query: what the tiles and figures show, `thing~panel~range` each (empty parts left empty), comma
 * separated. A read every minute, so a GET (a change would leave a receipt each time).
 */
export const OVERVIEW_SHOWS_MAX = 64;
export const OverviewViewsQuery = z.object({
  show: z
    .string()
    .max(OVERVIEW_SHOWS_MAX * 260)
    .regex(/^[A-Za-z0-9._:~,-]*$/),
});

export function overviewShowParam(shows: readonly (OverviewShow & { thing: string })[]): string {
  return shows.map((x) => `${x.thing}~${x.panel ?? ''}~${x.range ?? ''}`).join(',');
}

/** The shows a query names; one that isn't sound is left out. */
export function parseOverviewShowParam(param: string): (OverviewShow & { thing: OverviewThing })[] {
  const out: (OverviewShow & { thing: OverviewThing })[] = [];
  for (const part of param.split(',').slice(0, OVERVIEW_SHOWS_MAX)) {
    const [thing = '', panel = '', range = ''] = part.split('~');
    const parsed = OverviewShow.extend({ thing: OverviewThing }).safeParse({
      thing,
      ...(panel ? { panel } : {}),
      ...(range ? { range } : {}),
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** `overview.arrange`'s body: the whole layout. */
export const ArrangeOverviewBody = z.object({ layout: OverviewLayout });
export type ArrangeOverviewBody = z.infer<typeof ArrangeOverviewBody>;
