import { PAGE_THEME_VARIABLES } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { meetsTextContrast } from './contrast.js';
import { pageThemeCss, pageThemeVars } from './page.js';
import { THEMES } from './themes.js';

describe('page theme', () => {
  it('sets exactly the variables agents are told about, in both themes', () => {
    for (const theme of THEMES) {
      const names = Object.keys(pageThemeVars(theme)).map((n) => `--${n}`);
      expect(names.sort()).toEqual([...PAGE_THEME_VARIABLES].sort());
    }
  });

  it('keeps text readable on the page background', () => {
    for (const theme of THEMES) {
      const v = pageThemeVars(theme);
      expect(meetsTextContrast(v.foreground as string, v.background as string)).toBe(true);
      expect(meetsTextContrast(v['muted-foreground'] as string, v.background as string)).toBe(true);
    }
  });

  it('says its colour scheme and can sit in a style element', () => {
    expect(pageThemeCss('dark')).toContain('color-scheme:dark');
    expect(pageThemeCss('light')).toContain('--chart-1:');
    expect(pageThemeCss('light')).not.toContain('<');
  });
});
