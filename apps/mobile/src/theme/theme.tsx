/**
 * Theme: `@whombat/tokens` `nativeThemes`. Light/dark follows the system until the user picks one in the
 * Settings tab (persisted in the secure store, like the web app's localStorage choice).
 */
import { type NativeTheme, nativeThemes, type ThemeName } from '@whombat/tokens';
import * as SystemUI from 'expo-system-ui';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, type ColorSchemeName, useColorScheme } from 'react-native';
import { setNavigationBarTheme } from '../../modules/whombat-system-bars';
import type { KeyValueStore } from '../lib/kv';
import {
  loadThemePreference,
  resolveThemeName,
  saveThemePreference,
  type ThemePreference,
} from './preference';

export interface ThemeContextValue {
  theme: NativeTheme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ store, children }: { store: KeyValueStore; children: ReactNode }) {
  const system: ColorSchemeName = useColorScheme();
  const [preference, setPref] = useState<ThemePreference>('system');

  useEffect(() => {
    let alive = true;
    void loadThemePreference(store).then((value) => {
      if (alive) setPref(value);
    });
    return () => {
      alive = false;
    };
  }, [store]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setPref(next);
      void saveThemePreference(store, next);
    },
    [store],
  );

  // Native pieces (keyboard, alerts, the window background behind screens) follow the in-app choice.
  useEffect(() => {
    Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference);
  }, [preference]);

  const name: ThemeName = resolveThemeName(preference, system);
  const theme = nativeThemes[name];

  // The window behind the screens, and the system's area under the tab bar (the handle, the buttons: AP-2751).
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.bg);
    setNavigationBarTheme(theme.name);
  }, [theme]);

  const value = useMemo(() => ({ theme, preference, setPreference }), [theme, preference, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeContext(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme() must be used inside <ThemeProvider>');
  return value;
}

export function useTheme(): NativeTheme {
  return useThemeContext().theme;
}

/** Memoised per theme: `const useStyles = makeStyles((t) => StyleSheet.create({...}))`. */
export function makeStyles<S>(build: (theme: NativeTheme) => S): () => S {
  const cache = new Map<ThemeName, S>();
  return function useStyles() {
    const theme = useTheme();
    let styles = cache.get(theme.name);
    if (!styles) {
      styles = build(theme);
      cache.set(theme.name, styles);
    }
    return styles;
  };
}
