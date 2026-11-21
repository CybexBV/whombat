/**
 * The theme an agent's page gets in a message (`@whombat/core` `PAGE_THEME_VARIABLES`,
 * docs/decisions/visual-replies.md): the app's colours under the names agents know from other tools (`--background`,
 * `--foreground`, `--chart-1` …), its fonts and card radius, and a base sheet (background, text, font, a margin). The
 * page sits on the preview card's surface (`sf`), so that is its background.
 */
import { chartColors, codeColors, themeColors } from './colors.js';
import { radii } from './scale.js';
import type { ThemeName } from './themes.js';
import { fontFamilies } from './typography.js';

/** Each page variable's value in `theme` (keys are the variable names without the leading `--`). */
export function pageThemeVars(theme: ThemeName): Record<string, string> {
  const c = themeColors[theme];
  const chart = chartColors[theme];
  return {
    background: c.sf,
    foreground: c.ink,
    muted: c.sf2,
    'muted-foreground': c.mut,
    card: c.sf2,
    'card-foreground': c.ink,
    border: c.line2,
    input: c.line2,
    ring: c.brand,
    primary: c.btn,
    'primary-foreground': c.btnfg,
    accent: c.brand,
    success: c.ok,
    warning: c.warn,
    destructive: c.bad,
    'code-background': c.code,
    'code-foreground': codeColors.text,
    'chart-1': chart.chart1,
    'chart-2': chart.chart2,
    'chart-3': chart.chart3,
    'chart-4': chart.chart4,
    'chart-wash': chart.chartWash,
    radius: `${radii.panel}px`,
    'font-sans': fontFamilies.sans,
    'font-mono': fontFamilies.mono,
  };
}

/** What every page starts from; the page's own rules come later and win. */
const BASE_SHEET = [
  'html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-text-size-adjust:100%}',
  'body{margin:0;padding:14px}',
  'code,kbd,pre,samp{font-family:var(--font-mono)}',
  'a{color:var(--accent)}',
  ':focus-visible{outline:2px solid var(--ring);outline-offset:2px}',
].join('');

/** The theme sheet of a page in `theme`: `color-scheme`, the variables, the base sheet. */
export function pageThemeCss(theme: ThemeName): string {
  const vars = Object.entries(pageThemeVars(theme))
    .map(([name, value]) => `--${name}:${value}`)
    .join(';');
  return `:root{color-scheme:${theme};${vars}}${BASE_SHEET}`;
}
