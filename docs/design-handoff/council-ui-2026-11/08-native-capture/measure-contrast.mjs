// Run with Node 24 from the repository root. Nominal colours, not antialiased glyph edges.
import { writeFileSync } from 'node:fs';
import { statusTextColors, themeColors } from '../../../../packages/tokens/src/colors.ts';
const rgb = (value) => value.match(/[a-f\d]{2}/gi).map((v) => Number.parseInt(v, 16));
const luminance = (colour) => colour.map((v) => v / 255)
  .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (fg, bg) => {
  const a = luminance(fg), b = luminance(bg);
  return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(3);
};
const pairs = [];
function add(theme, foregroundToken, backgroundToken, foreground, background, extra = {}) {
  pairs.push({ theme, foregroundToken, backgroundToken, foreground, background,
    ratio: ratio(foreground, background), ...extra });
}
for (const theme of ['light', 'dark']) {
  const colours = { ...themeColors[theme], ...statusTextColors[theme] };
  for (const [fg, bg] of [
    ['mut', 'bg'], ['mut', 'sf'], ['mut', 'sf2'], ['brand', 'bg'], ['brand', 'sf'],
    ['warn', 'bg'], ['warn', 'sf'], ['warnText', 'sf2'], ['bad', 'sf2'],
    ['ink', 'bg'], ['ink2', 'bg'], ['btnfg', 'btn'], ['btnfg', 'bad'], ['btnfg', 'ink'],
  ]) add(theme, fg, bg, rgb(colours[fg]), rgb(colours[bg]), { source: 'packages/tokens/src/colors.ts' });
  add(theme, 'UIKit badge numeral (white upper bound)', 'sampled UIKit badge red',
    [255, 255, 255], theme === 'light' ? [255, 56, 60] : [255, 66, 69], {
      platform: 'ios', screenshot: `png/ios-chat-list-${theme}.png`,
      sample: 'x 76–92, y 768–785 at 390×844; 233 light / 232 dark solid background pixels',
      source: 'UIKit badge, navigation/GlassTabs.tsx; white gives the maximum possible numeral contrast',
    });
  for (const platform of ['ios', 'android']) {
    const bg = platform === 'ios'
      ? (theme === 'light' ? [251, 239, 228] : [64, 44, 30])
      : (theme === 'light' ? [251, 239, 229] : [63, 44, 29]);
    add(theme, 'mut', 'sampled lit control tile', rgb(colours.mut), bg, {
      platform, screenshot: `png/${platform}-connection-${theme}.png`,
      sample: 'solid lit-tile background, third most frequent screenshot colour; excludes antialiased edges',
      source: 'screens/thing/Controls.tsx useTileStyle: chart2/chartWash over sf; platform alpha rounding differs',
    });
  }
}
writeFileSync('docs/design-handoff/council-ui-2026-11/08-native-capture/contrast-pairs.json',
  `${JSON.stringify({
    method: 'WCAG 2 relative luminance; sRGB, target ≥4.5:1. Selected visible text pairs only. No inspector certification.',
    excludes: 'OS status bar, non-text icons/meters, image/gradient text, antialiasing and off-screen content. Files content unavailable.',
    pairs,
  }, null, 2)}\n`);
