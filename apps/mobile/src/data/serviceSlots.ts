/**
 * A service's Summary in slots on the phone (Whombat service-slots.md SLT-01…SLT-10; app service-slots-mobile.md):
 * what the renderer draws for the slot looks, as plain data — Worth a look as a strip (its lines in the order they
 * matter, the first three, then “Show N more”), Live rows as cards to swipe (a person's initial, the progress with its
 * words at both ends, grey while paused), a shelf's tag on the picture, a list of counts as tiles, a person's initial
 * before a bar, and where each card sits when the page is wide: two columns, each in one half of the screen. Pure; the
 * renderer is `screens/thing/Slots.tsx` and `Panels.tsx`.
 */
import { noticeGroups, placePanels, thingImageInitial } from '@whombat/client';
import type { ThingNoticeIcon, ThingPageButton, ThingPageItem, ThingPagePanel } from '@whombat/core';
import { type GalleryItemView, galleryItems } from './servicePanels';

type NoticesPanel = Extract<ThingPagePanel, { kind: 'notices' }>;
type GalleryPanel = Extract<ThingPagePanel, { kind: 'gallery' }>;
type ListPanel = Extract<ThingPagePanel, { kind: 'list' }>;

export const SLOT_COPY = {
  /** The page dots under the Live cards, for VoiceOver and TalkBack. */
  pageOf: (n: number, of: number) => `${n} of ${of}`,
} as const;

/* Whether a page is in slots ------------------------------------------------------------------------------------- */

/**
 * A page built from slots (a Live, Inventory or Shelf look): its cards get headings instead of mono labels and, when
 * wide, the two half-screen columns. Other pages keep their own layout.
 */
export function isSlotPage(panels: readonly ThingPagePanel[]): boolean {
  return panels.some((p) => (p.kind === 'gallery' || p.kind === 'list') && !!p.look);
}

/** Worth a look drawn as the slim strip: a notices panel placed on top (any page's, a server's banner too). */
export function isStrip(panel: ThingPagePanel): panel is NoticesPanel {
  return panel.kind === 'notices' && panel.place === 'top';
}

/* Worth a look as a strip --------------------------------------------------------------------------------------- */

/** The strip shows this many lines before “Show N more”. */
export const STRIP_FIRST = 3;

/**
 * The strip's lines in the order they matter: what asks (and a heads-up with a button) first, then the other heads-ups,
 * then the quiet ones (so Undo stays reachable). Every line has its place in the strip; none hides behind a fold of its
 * own.
 */
export function stripOrder<T extends NoticesPanel['items'][number]>(items: readonly T[]): T[] {
  const groups = noticeGroups(items);
  return [...groups.shown, ...groups.folded];
}

/**
 * The strip's lines apart from those quiet with the whole thing (kept quiet, or down because of something else): the
 * line under the page's head says why, so they fold under their own “Show N on hold”, as on a server's page and the
 * web, and don't count in “Show N more”.
 */
export function splitHeld<T extends { held: 'window' | 'cause' | null }>(
  rows: readonly T[],
): { lines: T[]; held: T[] } {
  return { lines: rows.filter((r) => !r.held), held: rows.filter((r) => !!r.held) };
}

/** The first three, the rest behind “Show N more” (opened in place). */
export function foldStrip<T>(rows: readonly T[], open: boolean): { shown: readonly T[]; more: number } {
  if (open || rows.length <= STRIP_FIRST) return { shown: rows, more: 0 };
  return { shown: rows.slice(0, STRIP_FIRST), more: rows.length - STRIP_FIRST };
}

/** The strip's tint: its worst line that still asks; `info` when every line is a heads-up or quiet. */
export function stripTone(items: NoticesPanel['items']): 'bad' | 'warn' | 'info' {
  const asking = items.filter((n) => !n.quiet);
  if (asking.some((n) => n.tone === 'bad')) return 'bad';
  if (asking.some((n) => n.tone === 'warn')) return 'warn';
  return 'info';
}

/**
 * A strip line's words as one sentence after another: its title, closed with a full stop where it has none, then its
 * detail (“**Plex couldn’t match 3 home videos.** They show without a poster or a proper name.”).
 */
export function stripSentence(
  title: string,
  detail: string | null,
): { title: string; detail: string | null } {
  const t = title.trim();
  if (!detail?.trim()) return { title: t, detail: null };
  return { title: /[.!?…:]$/.test(t) ? t : `${t}.`, detail: detail.trim() };
}

/* People -------------------------------------------------------------------------------------------------------- */

/** The letter a person's round mark shows: their name's first letter, a capital. */
export function personInitial(name: string): string {
  return thingImageInitial(name.trim()) || '?';
}

/* Live (`gallery` with `look: 'rows'`) ------------------------------------------------------------------------- */

export interface LiveRowView extends GalleryItemView {
  person: { name: string; initial: string; note: string | null } | null;
  /** The progress line's end: “17 min left”. */
  noteEnd: string | null;
  /** The progress stands still: its bar is grey. */
  paused: boolean;
}

/** Live's rows: each item's words, its person, its tag and its progress with words at both ends. */
export function liveRows(
  panel: Pick<GalleryPanel, 'items'>,
  now: Date | number,
  timeZone: string,
): LiveRowView[] {
  const views = galleryItems(panel, now, timeZone);
  return panel.items.map((item, i) => {
    const view = views[i] as GalleryItemView;
    const person = item.person
      ? {
          name: item.person.name,
          initial: personInitial(item.person.name),
          note: item.person.note?.trim() || null,
        }
      : null;
    const noteEnd = item.noteEnd?.trim() || null;
    return {
      ...view,
      person,
      noteEnd,
      paused: !!item.paused,
      spoken: [
        item.title,
        view.sub,
        person ? [person.name, person.note].filter(Boolean).join(', ') : null,
        item.badge?.text,
        view.note,
        noteEnd,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  });
}

/**
 * A progress note's parts: where it is now, stronger, and the rest (“**38:12** of 55:00”); all of it strong when it
 * doesn't say “of”.
 */
export function noteParts(note: string): { strong: string; rest: string } {
  const at = note.indexOf(' of ');
  return at > 0 ? { strong: note.slice(0, at), rest: note.slice(at) } : { strong: note, rest: '' };
}

/** A Live card's width on a phone: one card and the edge of the next show, so it says it swipes. */
export const LIVE_CARD_WIDTH = 318;
/** The gap between the Live cards (and the shelf's pictures). */
export const SWIPE_GAP = 10;

/** Which card a sideways scroll shows: the nearest card's start, kept within the cards. */
export function swipePage(offset: number, count: number, width = LIVE_CARD_WIDTH, gap = SWIPE_GAP): number {
  if (count < 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(offset / (width + gap))));
}

/* Shelf (`gallery` with `look: 'shelf'`) ---------------------------------------------------------------------- */

/** A shelf picture's width on a phone: three and a bit show, so the row says it swipes. */
export const SHELF_WIDTH = 104;

/** The small tag on a shelf's picture: the person's initial and their words (“Anna asked”), else their name. */
export function shelfTag(item: GalleryPanel['items'][number]): { initial: string; text: string } | null {
  if (!item.person) return null;
  return {
    initial: personInitial(item.person.name),
    text: item.person.note?.trim() || item.person.name,
  };
}

/** In a wide page's half the shelf shows its first pictures three across, two rows at most, never a short last row. */
export const HALF_SHELF_COLUMNS = 3;

export function shelfShown(count: number, columns = HALF_SHELF_COLUMNS, rows = 2): number {
  if (count <= columns) return count;
  return Math.min(rows * columns, Math.floor(count / columns) * columns);
}

/* Counts (`list` with `look: 'counts'`) ----------------------------------------------------------------------- */

export interface CountTileView {
  id: string;
  title: string;
  icon: ThingNoticeIcon | null;
  /** The count, large: the line's `figure`, else its `right`. */
  value: string | null;
  /** What changed under it (“+9 this week”), in its tone; else the line's own words. */
  note: string | null;
  noteTone: ThingPageItem['tone'] | null;
  /** The line's detail (“4,210 episodes · scanned today”, “Scanning · 40 %”), on a wide screen's row. */
  detail: string | null;
  /** Its own button (Scan): a small icon button on the tile, beside the row. */
  action: ThingPageButton | null;
  /** “Movies: 1,284, +9 this week. Scanned today 03:10”. */
  spoken: string;
}

export function countTiles(panel: Pick<ListPanel, 'items'>): CountTileView[] {
  return panel.items.map((item) => {
    const value = item.figure?.value ?? item.right?.trim() ?? null;
    const figureNote = item.figure?.note?.trim() || null;
    const detail = item.detail?.trim() || null;
    const note = figureNote ?? detail;
    const noteTone = figureNote ? (item.figure?.tone ?? null) : (item.tone ?? null);
    return {
      id: item.id,
      title: item.title,
      icon: item.icon ?? null,
      value: value || null,
      note,
      noteTone,
      detail,
      action: item.actions?.[0] ?? null,
      spoken: [
        [item.title, value].filter(Boolean).join(': '),
        figureNote,
        detail && detail !== note ? detail : null,
      ]
        .filter(Boolean)
        .join('. '),
    };
  });
}

/* A wide page in slots (SLT-09) -------------------------------------------------------------------------------- */

/**
 * Where a slot page's cards sit on an open foldable or a tablet: what is on top and isn't Worth a look across the width;
 * then two columns, each in one half of the screen so no card crosses the fold — on the left the cards that span two or
 * three columns (Live, Shelf) and after them the main column's; on the right Worth a look's strip first, then the cards
 * of one column (Inventory, Trend, People, Machine) and the side column's —; then the bottom across. Each list keeps the
 * panels' order. Phones stack the panels in the order given.
 */
export interface SlotColumns {
  across: ThingPagePanel[];
  left: ThingPagePanel[];
  right: ThingPagePanel[];
  bottom: ThingPagePanel[];
}

export function slotColumns(panels: readonly ThingPagePanel[]): SlotColumns {
  const placed = placePanels(panels);
  const charts = placed.chart.flat();
  return {
    across: placed.top.filter((p) => !isStrip(p)),
    left: [...charts.filter((c) => c.span >= 2).map((c) => c.panel), ...placed.main],
    right: [
      ...placed.top.filter(isStrip),
      ...charts.filter((c) => c.span < 2).map((c) => c.panel),
      ...placed.side,
    ],
    bottom: placed.bottom,
  };
}

/** The room between the two columns: wider than the cards' gap, so the fold falls in it. */
export const HINGE_GAP = 28;

/**
 * The two columns' widths on an open foldable, so each sits in its own half with the fold in the room between them:
 * from where the page starts in the window (`x`), its width and the fold's place in the window. Null without a fold, or
 * when the fold is so far off the page's middle that a column would be too narrow: the columns then share the width.
 */
export function halfWidths({
  x,
  width,
  hinge,
  gap = HINGE_GAP,
}: {
  x: number;
  width: number;
  hinge: number | null;
  gap?: number;
}): { left: number; right: number } | null {
  if (hinge === null || width <= gap) return null;
  const left = Math.round(hinge - x - gap / 2);
  const right = width - left - gap;
  if (left < width * 0.3 || right < width * 0.3) return null;
  return { left, right };
}
