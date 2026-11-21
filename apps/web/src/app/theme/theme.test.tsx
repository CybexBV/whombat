import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_FLASH_SCRIPT, readStoredTheme, THEME_STORAGE_KEY, writeStoredTheme } from './theme';

type Listener = (e: { matches: boolean }) => void;

/** Controllable `prefers-color-scheme` stub. */
function _mockColorScheme(initialDark: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  );
  return {
    set(dark: boolean) {
      mql.matches = dark;
      for (const l of listeners) l({ matches: dark });
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme logic', () => {
  it('reads and writes only valid themes', () => {
    expect(readStoredTheme()).toBeNull();
    writeStoredTheme('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readStoredTheme()).toBeNull();
    writeStoredTheme(null);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

describe('no-flash script', () => {
  const run = () => new Function(NO_FLASH_SCRIPT)();

  it('defaults to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    run();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
