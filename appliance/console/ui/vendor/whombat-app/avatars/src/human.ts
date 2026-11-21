/** Human avatar: a tone circle with 2-letter initials (README "Human avatar"). */

/** README: Human avatar tones. */
export const HUMAN_TONES = ['#d9c3a9', '#bfd0bf', '#dcc0cc', '#c3cad9', '#cfd2b8'] as const;
export type HumanTone = (typeof HUMAN_TONES)[number];

/** README: initials text color on every tone. */
export const HUMAN_INITIALS_COLOR = '#221d18';

/** Font sizes the mocks use at each diameter; other sizes use ≈ 0.35 × diameter. */
const MOCK_FONT_SIZES: Record<number, number> = {
  22: 9,
  24: 9.5,
  26: 10,
  28: 10.5,
  30: 12,
  32: 12,
  36: 13,
  40: 14,
  44: 14,
};

export function initialsFontSize(size: number): number {
  return MOCK_FONT_SIZES[size] ?? Math.round(size * 0.35 * 2) / 2;
}

/** Up to two initials, uppercased: "Mara Okafor" → "MO", "hazel" → "H". */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters
    .map((w) => Array.from(w as string)[0] ?? '')
    .join('')
    .toUpperCase();
}

/** Two visible characters at most. */
export function normalizeInitials(initials: string): string {
  return Array.from(initials.trim()).slice(0, 2).join('').toUpperCase();
}

/** A stable tone for a person without one (e.g. a newly invited member). */
export function toneFor(seed: string): HumanTone {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return HUMAN_TONES[h % HUMAN_TONES.length] as HumanTone;
}
