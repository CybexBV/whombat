import { act, render } from '@testing-library/react';
import type { ThemeChoice } from '@whombat/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ThemeContextValue, ThemeProvider, useTheme, useThemePreferenceSync } from './ThemeProvider';
import { NO_FLASH_SCRIPT, readStoredTheme, THEME_STORAGE_KEY, writeStoredTheme } from './theme';

type Listener = (e: { matches: boolean }) => void;

/** Controllable `prefers-color-scheme` stub. */
function mockColorScheme(initialDark: boolean) {
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

describe('the theme choice (Light · Dark · Auto)', () => {
  /** The provider with the account's preference, what it saves, and the context to choose with. */
  function mount(server: ThemeChoice | null) {
    const saved: ThemeChoice[] = [];
    const ctx: { current: ThemeContextValue | null } = { current: null };
    function Sync({ preference }: { preference: ThemeChoice | null }) {
      useThemePreferenceSync(preference, (choice) => saved.push(choice));
      ctx.current = useTheme();
      return null;
    }
    const view = render(
      <ThemeProvider>
        <Sync preference={server} />
      </ThemeProvider>,
    );
    const rerender = (preference: ThemeChoice | null) =>
      view.rerender(
        <ThemeProvider>
          <Sync preference={preference} />
        </ThemeProvider>,
      );
    return { saved, theme: () => ctx.current as ThemeContextValue, rerender };
  }

  it('saves each choice to the account, Auto as `system`, which keeps nothing on this device', () => {
    const scheme = mockColorScheme(true);
    const app = mount(null);
    act(() => app.theme().setChoice('light'));
    expect(app.theme().choice).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => app.theme().setChoice('system'));
    expect(app.theme().choice).toBe('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    // Auto follows the computer, and keeps following it.
    expect(document.documentElement.dataset.theme).toBe('dark');
    act(() => scheme.set(false));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(app.saved).toEqual(['light', 'system']);
  });

  it('applies the account’s preference without saving it back; `system` follows the computer', () => {
    mockColorScheme(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const app = mount('dark');
    expect(app.theme().choice).toBe('dark');
    app.rerender('system');
    expect(app.theme().choice).toBe('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(app.saved).toEqual([]);
  });
});
