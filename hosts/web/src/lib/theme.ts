// Theme: system (follows the OS), dark or light. Stored per browser; applied
// to <html data-theme> (public/theme.js applies it before the first paint).

import { t } from './i18n';

export type Theme = 'system' | 'dark' | 'light';

const KEY = 'rackoon-theme';
export const THEMES: Theme[] = ['system', 'light', 'dark'];
export const THEME_LABEL: Record<Theme, string> = { system: t('System'), light: t('Light'), dark: t('Dark') };

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // private mode: the choice lasts until the page reloads
  }
  applyTheme(t);
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

/** The next theme in the menu's cycle. */
export function nextTheme(t: Theme): Theme {
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length] ?? 'system';
}
