/**
 * `whombat-system-bars` — Android's area under the tab bar (the gesture handle, the unfolded screen's stashed taskbar,
 * the three buttons) is drawn for the app's theme, not the one the window started with (fold-bar.md AP-2751): a small
 * Kotlin module (`android/`). Without it (tests, the iPhone) nothing happens.
 */
import { requireOptionalNativeModule } from 'expo';

interface NativeWhombatSystemBars {
  setNavigationBarTheme(theme: 'light' | 'dark'): void;
}

const native = requireOptionalNativeModule<NativeWhombatSystemBars>('WhombatSystemBars');

/** The theme of what the app draws under the navigation area: light draws a dark handle and buttons, dark light ones. */
export function setNavigationBarTheme(theme: 'light' | 'dark'): void {
  native?.setNavigationBarTheme(theme);
}
