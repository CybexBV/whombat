/**
 * WCAG 2.x contrast ratio (relative luminance formula, https://www.w3.org/TR/WCAG21/#dfn-relative-luminance)
 * for opaque `#rrggbb` colors. Used by `contrast.test.ts` to check every text/surface token pairing the
 * app actually renders meets 4.5:1 (AA, normal text) in both themes.
 */

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const n = Number.parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  // biome-ignore lint/style/noNonNullAssertion: map() over a fixed-length tuple keeps its length
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Contrast ratio between two opaque `#rrggbb` colors, from 1 (no contrast) to 21 (black on white). */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for normal-size text (README "4.5:1 text contrast", TODO 16.2). */
export const MIN_TEXT_CONTRAST = 4.5;

export function meetsTextContrast(fgHex: string, bgHex: string): boolean {
  return contrastRatio(fgHex, bgHex) >= MIN_TEXT_CONTRAST;
}
