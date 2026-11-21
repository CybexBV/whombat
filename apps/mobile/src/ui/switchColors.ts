/**
 * `<Switch>` colors from the tokens (Android's own teal thumb is not ours): on = an `ok` track with a paper
 * thumb (light in both themes — `btnfg` turns near-black in dark and vanished on dark rows), off = a `line2` track
 * with a `mut` thumb. Readable on `sf` rows in both themes. Pure.
 *
 * No `ios_backgroundColor`: React Native paints it as a rounded box behind the switch, sized for the switch iOS drew
 * before 26, and iOS 26's wider, flatter switch leaves it showing as a dark block under it (automation-page.md
 * AP-6336). iOS draws the off track itself.
 */
import { brandColors, type ThemeColors } from '@whombat/tokens';

export function switchColors(
  theme: { colors: Pick<ThemeColors, 'ok' | 'line2' | 'mut'> },
  on: boolean,
): { trackColor: { true: string; false: string }; thumbColor: string } {
  return {
    trackColor: { true: theme.colors.ok, false: theme.colors.line2 },
    thumbColor: on ? brandColors.paper : theme.colors.mut,
  };
}
