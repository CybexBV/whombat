/**
 * TODO 16.2: 4.5:1 contrast for every text/background token pairing the app actually renders, in both
 * themes. `TEXT_ON_SURFACE` encodes those pairings from the README's "use" column (`docs/design-handoff/
 * README.md` "Colors — light / dark") and from how components use each token (verified by hand against
 * `apps/web/src/**\/*.module.css`): `ink`/`ink2`/`mut`/`brand` sit on any of the four surfaces; `ok`/`warn`/
 * `bad` are only ever rendered as *text* on `bg` or `sf` (cards and the page background) — where a chip or
 * track needs one of those colors on `sf2`/`side` it's a background fill (e.g. `RunCard` `.track`), not a
 * text color, so it isn't a contrast pairing at all.
 *
 * `ok` and `warn` fail 4.5:1 as text on `side`/`sf2` in the light theme (see the numbers below) — this is
 * a deliberate, recorded deviation from using those pairings, not a token change: `docs/decisions/
 * accessibility.md` D-A11Y-01. Adding a new `color: var(--ok|--warn)` (or `--bad`) rule on a `side`/`sf2`
 * background in light mode is what this test is guarding against. Text that needs those tones on a chip or pill
 * uses `warnText`/`okText` (`--warn-text`, `--ok-text`), which pass on every surface.
 */
import { describe, expect, it } from 'vitest';
import {
  chartColors,
  codeColors,
  contrastRatio,
  councilRoomColors,
  MIN_TEXT_CONTRAST,
  meetsTextContrast,
  statusTextColors,
  themeColors,
} from './index.js';

const SURFACES = ['bg', 'side', 'sf', 'sf2'] as const;
/** Every surface `ink`, `ink2`, `mut` and `brand` are used as text color on. */
const ALL_SURFACES: readonly (typeof SURFACES)[number][] = SURFACES;
/** `ok`/`warn` are only used as text on the page and card backgrounds (see file doc comment). */
const STATUS_TEXT_SURFACES: readonly (typeof SURFACES)[number][] = ['bg', 'sf'];

const TEXT_ON_SURFACE: Record<string, readonly (typeof SURFACES)[number][]> = {
  ink: ALL_SURFACES,
  ink2: ALL_SURFACES,
  mut: ALL_SURFACES,
  brand: ALL_SURFACES,
  ok: STATUS_TEXT_SURFACES,
  warn: STATUS_TEXT_SURFACES,
  // The “Not working” pill sets `bad` on `sf2`.
  bad: ALL_SURFACES,
  warnText: ALL_SURFACES,
  okText: ALL_SURFACES,
};

describe('contrastRatio', () => {
  it('is 1 for identical colors and 21 for black on white', () => {
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#221d18', '#fbf9f5')).toBeCloseTo(contrastRatio('#fbf9f5', '#221d18'), 10);
  });

  it('matches the AA threshold at 4.5:1', () => {
    expect(meetsTextContrast('#767676', '#ffffff')).toBe(true); // ~4.54:1, the canonical WCAG example
    expect(meetsTextContrast('#777777', '#ffffff')).toBe(false); // ~4.48:1
  });
});

describe('token contrast (TODO 16.2)', () => {
  for (const theme of ['light', 'dark'] as const) {
    const colors = { ...themeColors[theme], ...statusTextColors[theme] };
    for (const [text, surfaces] of Object.entries(TEXT_ON_SURFACE)) {
      for (const surface of surfaces) {
        it(`${theme}: ${text} on ${surface} reaches ${MIN_TEXT_CONTRAST}:1`, () => {
          const fg = colors[text as keyof typeof colors];
          const bg = colors[surface];
          const ratio = contrastRatio(fg, bg);
          expect(
            ratio,
            `${text} (${fg}) on ${surface} (${bg}) = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        });
      }
    }
  }

  it('syntax colors (message code blocks, AP-322) reach 4.5:1 on the code surface in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const [name, value] of Object.entries(codeColors)) {
        if (!name.startsWith('syntax')) continue;
        const ratio = contrastRatio(value, themeColors[theme].code);
        expect(ratio, `${theme}: ${name} (${value}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          MIN_TEXT_CONTRAST,
        );
      }
    }
  });

  it('btnfg on btn (primary buttons, active chips) reaches 4.5:1 in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const { btn, btnfg } = themeColors[theme];
      expect(contrastRatio(btnfg, btn)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it('documents why ok/warn are excluded from side/sf2 (the deliberate deviation, not a bug)', () => {
    const { ok, warn, side, sf2 } = themeColors.light;
    expect(contrastRatio(ok, side)).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(contrastRatio(ok, sf2)).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(contrastRatio(warn, side)).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(contrastRatio(warn, sf2)).toBeLessThan(MIN_TEXT_CONTRAST);
  });

  it('the council plaques’ words reach 4.5:1 on a plaque and a quiet plaque in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const room = councilRoomColors[theme];
      for (const text of ['plaqueInk', 'plaqueMut', 'plaqueOk', 'plaqueWarn'] as const)
        for (const surface of ['plaque', 'plaqueQuiet'] as const) {
          const ratio = contrastRatio(room[text], room[surface]);
          expect(ratio, `${theme}: ${text} on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            MIN_TEXT_CONTRAST,
          );
        }
    }
  });

  it('chart marks (chart1…chart4, AP-2001) reach 3:1 on the page and card backgrounds in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const { chartWash: _wash, ...marks } = chartColors[theme];
      expect(Object.keys(marks)).toEqual(['chart1', 'chart2', 'chart3', 'chart4']);
      for (const [name, value] of Object.entries(marks))
        for (const surface of ['bg', 'sf'] as const) {
          const ratio = contrastRatio(value, themeColors[theme][surface]);
          expect(ratio, `${theme}: ${name} on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
        }
    }
  });
});
