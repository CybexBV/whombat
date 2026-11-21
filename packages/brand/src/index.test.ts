import { readFileSync } from 'node:fs';
import { CATALOG_CONNECTABLE, HOST_OS_MARKS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { buildLogo, isBrandMark, isSmallSymbol, renderLogoSvg, SYMBOL_SMALL_PATH } from './index.js';

const _asset = (path: string) => readFileSync(new URL(`../assets/${path}`, import.meta.url), 'utf8');

describe('buildLogo', () => {
  it('uses the small symbol at 32px and below', () => {
    expect(isSmallSymbol(32)).toBe(true);
    expect(isSmallSymbol(33)).toBe(false);
    const small = renderLogoSvg(buildLogo({ height: 16, color: '#2b221d' }));
    expect(small).toContain(SYMBOL_SMALL_PATH);
    expect(small).not.toContain('<mask');
    const full = renderLogoSvg(buildLogo({ height: 64, color: '#2b221d', idPrefix: 'x' }));
    expect(full).toContain('<mask id="x-mask" maskUnits="userSpaceOnUse"');
    expect(full).toContain('mask="url(#x-mask)"');
    expect(full).toContain('stroke-width="3" stroke-linecap="round" stroke-linejoin="round"');
  });
});

describe('marks', () => {
  it('draw every server mark the contracts can answer (CT-399, MK-01)', () => {
    expect(HOST_OS_MARKS.filter((m) => !isBrandMark(m))).toEqual([]);
  });

  it('draw every connections catalog entry (MK-02)', () => {
    expect(CATALOG_CONNECTABLE.map((e) => e.id).filter((id) => !isBrandMark(id))).toEqual([]);
  });
});
