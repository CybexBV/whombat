export const THEMES = ['light', 'dark'] as const;
export type ThemeName = (typeof THEMES)[number];

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}
