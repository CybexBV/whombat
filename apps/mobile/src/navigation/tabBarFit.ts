/**
 * How the bottom bar fits its five words (docs/app/decisions/automations-tab.md AP-6311): 11 px, each word at least
 * 2.5 px clear of its tab's edges, so neighbours never touch. Where a tab is too narrow for the longest word (a 360 dp
 * Galaxy S, a 375 pt iPhone mini or SE), the bar's side margins go from 10 to 4, and when that isn't enough the words
 * go to 10.5 px. Larger system text shrinks back to fit the tab (`adjustsFontSizeToFit`) instead of wrapping. Pure.
 */

export interface TabBarFit {
  /** The bar's padding on the left and the right. */
  margin: number;
  /** The words' size before the system's text size. */
  size: number;
}

export const TAB_BAR_MARGIN = 10;
export const TAB_BAR_NARROW_MARGIN = 4;
export const TAB_WORD_SIZE = 11;
export const TAB_WORD_SMALL_SIZE = 10.5;

/** “Automations”, the longest word, at 11 px semibold in Bricolage Grotesque (measured in the browser). */
const LONGEST_WORD = 69;
/** Room around a word: 2.5 px on either side. */
const CLEAR = 5;

export function tabBarFit(width: number, tabs: number): TabBarFit {
  const fits = (margin: number) => (width - 2 * margin) / tabs >= LONGEST_WORD + CLEAR;
  if (fits(TAB_BAR_MARGIN)) return { margin: TAB_BAR_MARGIN, size: TAB_WORD_SIZE };
  if (fits(TAB_BAR_NARROW_MARGIN)) return { margin: TAB_BAR_NARROW_MARGIN, size: TAB_WORD_SIZE };
  return { margin: TAB_BAR_NARROW_MARGIN, size: TAB_WORD_SMALL_SIZE };
}
