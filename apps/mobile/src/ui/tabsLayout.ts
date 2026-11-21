/**
 * How `UnderlineTabs` lays its tabs out (underline-tabs-android.md AP-2632), pure so it is tested without React Native:
 * up to four share the row's width equally when each one's words fit its share on a 360dp phone; more, or longer
 * ones, scroll sideways, each as wide as its words, and the open one is kept in view.
 */

/** At most this many tabs (a trailing control counts as one) share the row; a guest's five scroll. */
export const FILL_MAX_TABS = 4;

/**
 * Characters across a 360dp phone's row (324dp inside the page's 18dp padding, about 8dp a character at 14.5 with a
 * tab's padding): an equal share holds this divided by the shares.
 */
export const ROW_CHARS = 40;

/** How far past the open tab a scroll goes, so the next one peeks in and says there is more. */
export const REVEAL_PEEK = 24;

export interface TabWords {
  label: string;
  count?: number | string | null;
  tone?: unknown;
  /** A status mark after the count, as wide as the tone's dot or a little more. */
  level?: unknown;
}

/** A tab's words in characters: its label, its count after a space, the tone's dot or status mark as one more. */
export function tabWords(tab: TabWords): number {
  const count = tab.count === null || tab.count === undefined ? 0 : String(tab.count).length + 1;
  return tab.label.length + count + (tab.tone || tab.level ? 1 : 0);
}

/**
 * `fill`: equal shares, centred; `scroll`: sideways, each tab as wide as its words. `shares` counts a trailing control;
 * `fontScale` is the phone's text size, so larger text scrolls rather than cutting the words or crowding a mark.
 */
export function underlineTabsLayout(
  tabs: readonly TabWords[],
  shares = tabs.length,
  fontScale = 1,
): 'fill' | 'scroll' {
  if (shares > FILL_MAX_TABS) return 'scroll';
  const longest = Math.max(0, ...tabs.map(tabWords));
  return longest * shares * Math.max(1, fontScale) <= ROW_CHARS ? 'fill' : 'scroll';
}

interface Span {
  x: number;
  width: number;
}

/**
 * Where the row scrolls to show the open tab (`tab` in the content's coordinates, `view` the row's offset and width):
 * just far enough that it and a peek of its neighbour show; null when it already does, or before anything is measured.
 */
export function revealOffset(tab: Span, view: Span, peek = REVEAL_PEEK): number | null {
  if (view.width <= 0 || tab.width <= 0) return null;
  const left = Math.max(0, tab.x - peek);
  const right = tab.x + tab.width + peek - view.width;
  if (left < view.x) return left;
  if (right > view.x) return Math.max(0, right);
  return null;
}
