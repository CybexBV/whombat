import { nativeThemes } from '@whombat/tokens';
import { describe, expect, it } from 'vitest';
import { runBarColor, tagColors, tint } from './glanceColors';

describe('the Automations list’s colours (automation-list.md AP-1092, AP-1093)', () => {
  const { colors } = nativeThemes.light;

  it('tints a token colour, and leaves any other colour as it is', () => {
    expect(tint('#8d6d2d', 0.35)).toBe('#8d6d2d59');
    expect(tint('#8D6D2D', 0.07)).toBe('#8D6D2D12');
    expect(tint('#8d6d2d', 2)).toBe('#8d6d2dff');
    expect(tint('transparent', 0.5)).toBe('transparent');
    expect(tint('#fff', 0.5)).toBe('#fff');
  });

  it('draws a tag in its tone from the tokens, in both themes', () => {
    expect(tagColors(colors, 'plain')).toEqual({
      text: colors.ink2,
      border: colors.line2,
      background: 'transparent',
    });
    expect(tagColors(colors, 'warn')).toEqual({
      text: colors.warn,
      border: tint(colors.warn, 0.35),
      background: tint(colors.warn, 0.07),
    });
    const dark = nativeThemes.dark.colors;
    expect(tagColors(dark, 'bad').text).toBe(dark.bad);
    expect(tagColors(dark, 'bad').border).toMatch(/^#[0-9a-f]{8}$/i);
  });

  it('colours a run’s bar, a quiet one in line2', () => {
    expect(runBarColor(colors, 'ok')).toBe(colors.ok);
    expect(runBarColor(colors, 'brand')).toBe(colors.brand);
    expect(runBarColor(colors, 'quiet')).toBe(colors.line2);
  });
});
