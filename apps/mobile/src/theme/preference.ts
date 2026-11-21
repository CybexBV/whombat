import type { ThemeName } from '@whombat/tokens';
import { type KeyValueStore, STORAGE_KEYS } from '../lib/kv';

export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_PREFERENCES: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

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

/** The stored choice; System when there is none or the keystore won't give it (AP-594). */
export function loadThemePreference(store: KeyValueStore): Promise<ThemePreference> {
  return store.get(STORAGE_KEYS.theme).then(toThemePreference, () => 'system' as const);
}

/** Stores the choice; one the keystore won't take still holds for this run (the provider's state). */
export function saveThemePreference(store: KeyValueStore, preference: ThemePreference): Promise<void> {
  return store.set(STORAGE_KEYS.theme, preference).catch(() => {});
}
