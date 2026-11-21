/**
 * Face colours (Whombat one-agent.md OA-08, five-agents.md FA-05). A face's dot (`--face-<face>`, 7–10px) always sits
 * next to a name, so it is never the only cue; the floors below are the avatar family's (docs/decisions/app-managed.md
 * AP-197) and the handoff colours meet them in both themes:
 *
 * - accent (the dot) on every dark surface ≥ 3:1 (WCAG 1.4.11); on every light surface ≥ 2:1 (the family is one
 *   lightness band — citron `#a6ad43` on `sf2` is 2.06:1 — and the name beside it carries the meaning);
 * - deep (text on a light accent tint) on every light surface ≥ 3:1;
 * - every two of the five accents at least 0.05 apart in OKLab (ΔE_OK).
 */
import { AGENT_CHARACTERS, AGENT_FACES } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { contrastRatio, FACES, facePalettes, renderTokensCss, themeColors } from './index.js';

const SURFACES = ['bg', 'side', 'sf', 'sf2'] as const;

function oklab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const deltaE = (a: string, b: string) => {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

describe('face colors', () => {
  it('are the contracts’ five faces, with agents.json’s accent and accentDeep (core AGENT_CHARACTERS), the same in both themes', () => {
    expect([...FACES]).toEqual([...AGENT_FACES]);
    expect(Object.keys(facePalettes)).toEqual([...FACES]);
    for (const c of AGENT_CHARACTERS)
      expect(facePalettes[c.face]).toEqual({ name: c.name, accent: c.accent, deep: c.accentDeep });
    const css = renderTokensCss();
    expect(css).toContain('--face-skipper: #c65d6e;');
    expect(css).toContain('--face-skipper-deep: #a33346;');
    // Declared once, at the root: no theme overrides them.
    expect(css.match(/--face-skipper:/g)).toHaveLength(1);
    expect(css).not.toContain('--role-');
  });

  for (const face of FACES) {
    const { accent, deep } = facePalettes[face];
    it(`${face}: the dot reads on every surface in both themes`, () => {
      for (const s of SURFACES) {
        const dark = contrastRatio(accent, themeColors.dark[s]);
        const light = contrastRatio(accent, themeColors.light[s]);
        expect(dark, `${accent} on dark ${s} = ${dark.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
        expect(light, `${accent} on light ${s} = ${light.toFixed(2)}:1`).toBeGreaterThanOrEqual(2);
      }
    });
    it(`${face}: deep reaches 3:1 on every light surface`, () => {
      for (const s of SURFACES) {
        const ratio = contrastRatio(deep, themeColors.light[s]);
        expect(ratio, `${deep} on light ${s} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('keeps every two of the five accents apart (ΔE_OK ≥ 0.05)', () => {
    for (const [i, a] of FACES.entries()) {
      for (const b of FACES.slice(i + 1)) {
        const d = deltaE(facePalettes[a].accent, facePalettes[b].accent);
        expect(d, `${a} ↔ ${b} = ${d.toFixed(3)}`).toBeGreaterThanOrEqual(0.05);
      }
    }
  });
});
