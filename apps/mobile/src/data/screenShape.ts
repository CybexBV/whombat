/**
 * The shape of the app's window (docs/app/decisions/iphone-duo.md): where the tabs go, one page or two, and where the
 * two meet. Decided from the window and what the system reports about it — never from the device's model — so the
 * iPhone Duo closed and open, Split View, an unfolded Android foldable and a phone all follow the same rules:
 *
 * - The tabs go where the system keeps its own vertical bar (the Duo's clock and buttons, down the right edge); without
 *   one, along the bottom on a narrow window and down the left on a wide one.
 * - Two pages, the list and what it opened, on a window at least 840 points wide; one otherwise.
 * - The list is the narrower page: on the Duo open it takes the width right of the crease and the wider page is on the
 *   right. The person moves the line between them (`dividerAt`); near the crease it snaps onto it.
 */

/** The side bar's width: its tabs' labels (“Connections” at 11) and the system's inset under the clock. */
export const SIDE_BAR_WIDTH = 72;

/** From this width the tabs go down the side instead of along the bottom (a phone is narrower). */
export const SIDE_TABS_MIN_WIDTH = 600;

/** From this width the list and what it opened show side by side (the Duo open is 951; held upright, 669). */
export const TWO_PAGES_MIN_WIDTH = 840;

/** Neither page is narrower than this. */
export const PAGE_MIN_WIDTH = 320;

/** How near the crease the line between the pages snaps onto it. */
export const FOLD_SNAP = 16;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = 'left' | 'right';

export interface ShapeInput {
  /** The window, in points. */
  width: number;
  height: number;
  /** The window's safe area. */
  insets: { top: number; right: number; bottom: number; left: number };
  /** The edge where the system keeps its own vertical bar, if any. */
  barSide: Side | null;
  /** Folds (division regions), in window points. */
  folds: readonly Rect[];
  /** What the system draws over the window: the clock, the cameras. */
  occlusions: readonly Rect[];
}

export interface ScreenShape {
  tabs: 'bottom' | Side;
  /** The side bar's width, the system's inset on its side included; 0 with the bottom bar. */
  barWidth: number;
  /** Where the side bar's tabs may start: below the clock. */
  barTop: number;
  /** The edge the app keeps clear of while nothing is drawn there (screens before the tabs, under the Duo's clock). */
  reserve: { side: Side; width: number } | null;
  /** The content's left and right edges in the window: between the side bar and the other edge's safe area. */
  content: { left: number; right: number };
  pages: 1 | 2;
  /** The list's width from the content's left edge until the person moves the line; the content's width on one page. */
  listWidth: number;
  /** With two pages: the crease, from the content's left edge, where the line snaps; null without a usable fold. */
  fold: number | null;
}

/** A phone's shape, before anything is known: the bottom bar, one page. */
export const PHONE_SHAPE: ScreenShape = {
  tabs: 'bottom',
  barWidth: 0,
  barTop: 0,
  reserve: null,
  content: { left: 0, right: 0 },
  pages: 1,
  listWidth: 0,
  fold: null,
};

export function screenShape(input: ShapeInput): ScreenShape {
  const { width, height, insets, barSide } = input;
  const reserveWidth = barSide ? Math.max(insets[barSide], edgeCover(input, barSide)) : 0;
  const reserve = barSide && reserveWidth > 0 ? { side: barSide, width: Math.ceil(reserveWidth) } : null;
  const tabs: ScreenShape['tabs'] = barSide ?? (width >= SIDE_TABS_MIN_WIDTH ? 'left' : 'bottom');
  if (tabs === 'bottom') {
    return { ...PHONE_SHAPE, reserve, content: { left: 0, right: width } };
  }
  const barWidth = Math.max(SIDE_BAR_WIDTH, insets[tabs], tabs === barSide ? reserveWidth : 0);
  const content = {
    left: tabs === 'left' ? barWidth : insets.left,
    right: width - (tabs === 'right' ? barWidth : insets.right),
  };
  const barTop = Math.max(insets.top, clockBottom(input, tabs, barWidth));
  const contentWidth = content.right - content.left;
  const two = width >= TWO_PAGES_MIN_WIDTH && contentWidth >= 2 * PAGE_MIN_WIDTH;
  const base = { tabs, barWidth, barTop, reserve, content };
  if (!two) return { ...base, pages: 1, listWidth: contentWidth, fold: null };
  const fold = input.folds.find((f) => f.height >= height / 2 && f.width < width / 4);
  if (fold) {
    const before = fold.x - content.left;
    const after = content.right - (fold.x + fold.width);
    if (before >= PAGE_MIN_WIDTH && after >= PAGE_MIN_WIDTH)
      return { ...base, pages: 2, listWidth: Math.min(before, after), fold: before + fold.width / 2 };
  }
  const listWidth = Math.min(
    Math.max(Math.round(contentWidth * 0.45), PAGE_MIN_WIDTH),
    contentWidth - PAGE_MIN_WIDTH,
  );
  return { ...base, pages: 2, listWidth, fold: null };
}

/** Where the line between the pages settles for a wanted list width: neither page under the minimum, on the crease when near it. */
export function dividerAt(shape: ScreenShape, wanted: number): number {
  'worklet';
  const width = shape.content.right - shape.content.left;
  const at = Math.min(Math.max(wanted, PAGE_MIN_WIDTH), width - PAGE_MIN_WIDTH);
  return shape.fold !== null && Math.abs(at - shape.fold) <= FOLD_SNAP ? shape.fold : at;
}

/** The list's width for the share of the content the person left it at (null: never moved), in this window. */
export function listWidthFor(shape: ScreenShape, share: number | null): number {
  if (shape.pages !== 2 || share === null) return shape.listWidth;
  return dividerAt(shape, share * (shape.content.right - shape.content.left));
}

/** The list's share of the content, as kept on the phone. */
export function shareOf(shape: ScreenShape, listWidth: number): number {
  return Math.round((listWidth / (shape.content.right - shape.content.left)) * 10_000) / 10_000;
}

/** A kept share, if it is one. */
export function parseShare(raw: string | null): number | null {
  const share = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(share) && share > 0 && share < 1 ? share : null;
}

/** How near an edge the clock may float and still count as that edge's (the Duo's sits about 12 points in). */
const EDGE_SLACK = 24;

/** How far in from `side` the system's clock and cameras reach (the narrow ones: not a bar along the bottom). */
function edgeCover({ width, occlusions }: ShapeInput, side: Side): number {
  let cover = 0;
  for (const r of occlusions) {
    if (r.width > width * 0.3) continue;
    if (side === 'left' && r.x <= EDGE_SLACK) cover = Math.max(cover, r.x + r.width);
    if (side === 'right' && r.x + r.width >= width - EDGE_SLACK) cover = Math.max(cover, width - r.x);
  }
  return cover;
}

/** The bottom of what the system draws in the upper half of the side bar's column (the Duo's clock). */
function clockBottom({ width, height, occlusions }: ShapeInput, side: Side, barWidth: number): number {
  const from = side === 'left' ? 0 : width - barWidth;
  const to = side === 'left' ? barWidth : width;
  let bottom = 0;
  for (const r of occlusions) {
    if (r.y > height / 2 || r.x >= to || r.x + r.width <= from) continue;
    bottom = Math.max(bottom, r.y + r.height);
  }
  return bottom;
}

/**
 * Whether two shapes would draw the same: the fold module reports again on every foreground and hinge move, and a new
 * shape object for the same layout would draw every screen again.
 */
export function sameShape(a: ScreenShape, b: ScreenShape): boolean {
  return (
    a.tabs === b.tabs &&
    a.barWidth === b.barWidth &&
    a.barTop === b.barTop &&
    a.reserve?.side === b.reserve?.side &&
    a.reserve?.width === b.reserve?.width &&
    a.content.left === b.content.left &&
    a.content.right === b.content.right &&
    a.pages === b.pages &&
    a.listWidth === b.listWidth &&
    a.fold === b.fold
  );
}

/** Which page something is drawn on: the only one, the list, or the page beside it. */
export type PageSide = 'only' | 'list' | 'beside';

/**
 * A page's left and right edges in the window: with two pages the list from the content's left edge to the line
 * (`listWidth`, where the person left it), the page beside it from the line to the content's right edge; with one the
 * whole content, never under the side bar.
 */
export function pageFrame(
  shape: ScreenShape,
  listWidth: number,
  side: PageSide,
): { left: number; right: number } {
  const { left, right } = shape.content;
  if (shape.pages !== 2 || side === 'only') return { left, right };
  return side === 'list' ? { left, right: left + listWidth } : { left: left + listWidth, right };
}

/** How far a toast keeps from the keyboard, and from the bottom where nothing covers it. */
export const TOAST_GAP = 12;

/**
 * Where the toast floats (its box's left, right and bottom in the window): over the page that shows what was done —
 * with two pages the one beside the list, where reading and acting happen — never over the side bar or the crease,
 * above the bottom tab bar when there is one (`aboveTabs`, its height) and above the keyboard while it is up.
 */
export function toastPlacement({
  shape,
  window,
  listWidth,
  bottomInset,
  aboveTabs,
  keyboard,
}: {
  shape: ScreenShape;
  window: { width: number };
  listWidth: number;
  bottomInset: number;
  /** The bottom tab bar's height (0 with the tabs down the side). */
  aboveTabs: number;
  /** The keyboard's height while it is up, else 0. */
  keyboard: number;
}): { left: number; right: number; bottom: number } {
  const page = pageFrame(shape, listWidth, shape.pages === 2 ? 'beside' : 'only');
  const right = shape.tabs === 'bottom' ? 0 : window.width - page.right;
  const left = shape.tabs === 'bottom' ? 0 : page.left;
  const resting = shape.tabs === 'bottom' ? aboveTabs : bottomInset + TOAST_GAP;
  return { left, right, bottom: Math.max(resting, keyboard > 0 ? keyboard + TOAST_GAP : 0) };
}
