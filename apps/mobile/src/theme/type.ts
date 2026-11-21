/**
 * Text metrics shared by every screen. The mocks are CSS: `line-height: normal` is the font's
 * ascent + descent (Bricolage Grotesque 930 + 270, DM Mono 992 + 310 per 1000 units) and letter-spacing
 * is in em. Android's own font padding is turned off so a line box is exactly that height.
 */
import { nativeFontFamilies } from '@whombat/tokens';

export type FontWeight = 400 | 500 | 600 | 700;
export type FontFamily = 'sans' | 'mono';

/** CSS `line-height: normal` as a multiple of the font size. */
export const NORMAL_LINE_HEIGHT: Record<FontFamily, number> = { sans: 1.2, mono: 1.302 };

export interface TextMetricsInput {
  size: number;
  weight?: FontWeight;
  family?: FontFamily;
  /** Unitless CSS line-height; omitted = `normal`. */
  lineHeight?: number;
  /** CSS letter-spacing in em. */
  tracking?: number;
}

export interface TextMetrics {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
}

export function textMetrics({
  size,
  weight = 400,
  family = 'sans',
  lineHeight,
  tracking,
}: TextMetricsInput): TextMetrics {
  const out: TextMetrics = {
    fontFamily: nativeFontFamilies[family][weight],
    fontSize: size,
    lineHeight: Math.round(size * (lineHeight ?? NORMAL_LINE_HEIGHT[family]) * 100) / 100,
  };
  if (tracking) out.letterSpacing = Math.round(size * tracking * 100) / 100;
  return out;
}
