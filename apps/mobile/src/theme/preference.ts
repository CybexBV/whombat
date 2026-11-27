import { THEME_CHOICES, THEME_WORDS, type ThemeChoice } from '@whombat/client';
import type { ThemeName } from '@whombat/tokens';
import { type KeyValueStore, STORAGE_KEYS } from '../lib/kv';

/** What is stored and saved to the account: `system` is Auto, which follows the phone. */
export type ThemePreference = ThemeChoice;

/** The choices in the web's words and order: Light · Dark · Auto. */
export const THEME_PREFERENCES: readonly { value: ThemePreference; label: string }[] = THEME_CHOICES.map(
  (value) => ({ value, label: THEME_WORDS.choices[value] }),
);

export function toThemePreference(value: string | null | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The stored choice wins; otherwise the system scheme (light when the system has none). */
export function resolveThemeName(
  preference: ThemePreference,
  system: 'light' | 'dark' | 'unspecified' | null | undefined,
): ThemeName {
  if (preference !== 'system') return preference;
  return system === 'dark' ? 'dark' : 'light';
}

/** The stored choice; Auto when there is none or the keystore won't give it (AP-594). */
export function loadThemePreference(store: KeyValueStore): Promise<ThemePreference> {
  return store.get(STORAGE_KEYS.theme).then(toThemePreference, () => 'system' as const);
}

/** Stores the choice; one the keystore won't take still holds for this run (the provider's state). */
export function saveThemePreference(store: KeyValueStore, preference: ThemePreference): Promise<void> {
  return store.set(STORAGE_KEYS.theme, preference).catch(() => {});
}
