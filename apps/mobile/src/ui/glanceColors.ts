/**
 * The colours of the Automations list at a glance (docs/decisions/automation-list.md AP-1092, AP-1093), from the tokens:
 * a tag that changes code or calls out in `warn` and one that merges in `bad`, each on a 7 % wash with a 35 % border;
 * a run's bar and its status word. Pure.
 */
import type { ThemeColors } from '@whombat/tokens';
import type { AutomationTagTone, RunBarTone } from '../data/automations';

/** `#rrggbb` at `alpha` (0–1) as `#rrggbbaa`, the tokens' colours being plain hex; any other colour as it is. */
export function tint(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${color}${byte.toString(16).padStart(2, '0')}`;
}

type Colors = Pick<ThemeColors, 'ink2' | 'line2' | 'mut' | 'ok' | 'warn' | 'bad' | 'brand'>;

/** A tag's text, border and background: `plain` in `ink2` on a `line2` border, the others in their tone (AP-1092). */
export function tagColors(
  colors: Colors,
  tone: AutomationTagTone,
): { text: string; border: string; background: string } {
  if (tone === 'plain') return { text: colors.ink2, border: colors.line2, background: 'transparent' };
  const color = colors[tone];
  return { text: color, border: tint(color, 0.35), background: tint(color, 0.07) };
}

/** A run's bar (AP-1093): a stopped or skipped run is a quiet `line2`. */
export function runBarColor(colors: Colors, tone: RunBarTone): string {
  return tone === 'quiet' ? colors.line2 : colors[tone];
}
