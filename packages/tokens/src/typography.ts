/** Fonts and type scale. README "Fonts" and "Type scale"; sizes checked against the inline styles. */

export const fontFamilies = {
  /** All UI text. */
  sans: "'Bricolage Grotesque', system-ui, sans-serif",
  /** Metadata, labels, timestamps, code, branch names, counts. */
  mono: "'DM Mono', monospace",
} as const;
export type FontFamilyName = keyof typeof fontFamilies;

/**
 * Emoji on their own (web: the reaction picker, reaction pills; `--font-emoji`): the platform's colour emoji font before
 * any monochrome glyph a text font has (docs/decisions/essentials-messages.md AP-444). Not a type style's family.
 */
export const emojiFontFamily =
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', sans-serif";

export interface TypeStyle {
  family: FontFamilyName;
  /** px */
  size: number;
  weight: 400 | 500 | 600 | 700;
  /** Unitless multiplier; omitted = `normal`. */
  lineHeight?: number;
  /** em */
  tracking?: number;
  uppercase?: boolean;
}

/**
 * Named type styles. Emitted to CSS as `--type-<name>` (font shorthand) and
 * `--type-<name>-tracking` (letter-spacing, `normal` when unset).
 */
export const typeScale = {
  /** Onboarding h1. */
  displayOnboarding: { family: 'sans', size: 44, weight: 700, lineHeight: 1.02, tracking: -0.03 },
  /** Canvas h1. */
  displayCanvas: { family: 'sans', size: 42, weight: 700, lineHeight: 1.05, tracking: -0.03 },
  /** Page h1 (Agents, Audit log). */
  pageTitle: { family: 'sans', size: 36, weight: 700, tracking: -0.02 },
  /** Run h1. */
  runTitle: { family: 'sans', size: 32, weight: 700, lineHeight: 1.1, tracking: -0.02 },
  heading28: { family: 'sans', size: 28, weight: 700, tracking: -0.02 },
  heading26: { family: 'sans', size: 26, weight: 700, tracking: -0.02 },
  heading24: { family: 'sans', size: 24, weight: 700, tracking: -0.02 },
  /** Modal question. */
  heading23: { family: 'sans', size: 23, weight: 700, lineHeight: 1.15, tracking: -0.01 },
  /** Conversation header titles, canvas h2. */
  headerTitle: { family: 'sans', size: 21, weight: 700, tracking: -0.01 },
  /** Card titles. */
  cardTitle: { family: 'sans', size: 19, weight: 700, tracking: -0.01 },
  /** Canvas body, page subtitles. */
  bodyLarge: { family: 'sans', size: 17, weight: 400, lineHeight: 1.55 },
  /** Messages. */
  body: { family: 'sans', size: 16, weight: 400, lineHeight: 1.55 },
  /** Author names. */
  name: { family: 'sans', size: 15.5, weight: 600 },
  /** Lists. */
  list: { family: 'sans', size: 15, weight: 400 },
  /** Secondary text, sidebar rows. */
  secondary: { family: 'sans', size: 14.5, weight: 400 },
  small: { family: 'sans', size: 14, weight: 400 },
  meta: { family: 'sans', size: 13.5, weight: 400 },
  metaSmall: { family: 'sans', size: 13, weight: 400 },
  /** Section labels (`PLAN · 4 STEPS`, `KEYS`). */
  label: { family: 'mono', size: 11, weight: 500, tracking: 0.05, uppercase: true },
  /** Sidebar section labels (`CHANNELS`). */
  labelSmall: { family: 'mono', size: 10.5, weight: 500, tracking: 0.05, uppercase: true },
  /** Badges, counts, kbd hints. */
  monoBadge: { family: 'mono', size: 11, weight: 500 },
  /** Timestamps. */
  monoMeta: { family: 'mono', size: 12, weight: 400 },
  monoMetaSmall: { family: 'mono', size: 11.5, weight: 400 },
  monoMetaLarge: { family: 'mono', size: 12.5, weight: 400 },
  /** Mobile large title. */
  mobileLargeTitle: { family: 'sans', size: 34, weight: 700, tracking: -0.02 },
  mobileBody: { family: 'sans', size: 15.5, weight: 400 },
  mobileButton: { family: 'sans', size: 16, weight: 600 },
} as const satisfies Record<string, TypeStyle>;

export type TypeStyleName = keyof typeof typeScale;
