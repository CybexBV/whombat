/**
 * Large text: above this font scale buttons that sit side by side stack one per row and their labels wrap, so a
 * label is never cut or shrunk.
 */
import { useWindowDimensions } from 'react-native';

export const LARGE_TEXT_SCALE = 1.3;

/** Whether the person's text size is large enough that side-by-side buttons stack. */
export function isLargeText(fontScale: number): boolean {
  return fontScale > LARGE_TEXT_SCALE;
}

export function useLargeText(): boolean {
  return isLargeText(useWindowDimensions().fontScale);
}
