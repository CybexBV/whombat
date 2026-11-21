/**
 * Theme logic (pure, no React). `data-theme` on `<html>` selects the token block in
 * `@whombat/tokens/tokens.css`. First load follows `prefers-color-scheme`; an explicit choice is
 * persisted in localStorage (and later per user on the server, see `useThemePreferenceSync`).
 */
import { isThemeName, type ThemeName } from '@whombat/tokens';

import { DARK_QUERY, THEME_STORAGE_KEY } from './noFlash';

export { DARK_QUERY, NO_FLASH_SCRIPT, THEME_STORAGE_KEY } from './noFlash';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readStoredTheme(storage: StorageLike | undefined = safeLocalStorage()): ThemeName | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeName(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredTheme(
  theme: ThemeName | null,
  storage: StorageLike | undefined = safeLocalStorage(),
): void {
  try {
    if (theme) storage?.setItem(THEME_STORAGE_KEY, theme);
    else storage?.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

export function systemTheme(win: Pick<Window, 'matchMedia'> | undefined = safeWindow()): ThemeName {
  try {
    return win?.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** An explicit preference wins; otherwise follow the system. */
export function resolveTheme(preference: ThemeName | null, system: ThemeName): ThemeName {
  return preference ?? system;
}

export function otherTheme(theme: ThemeName): ThemeName {
  return theme === 'dark' ? 'light' : 'dark';
}

export function applyTheme(
  theme: ThemeName,
  root: HTMLElement | undefined = safeDocument()?.documentElement,
): void {
  if (root) root.dataset.theme = theme;
}

function safeLocalStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function safeWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

function safeDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}
