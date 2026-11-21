import type { ThemeName } from '@whombat/tokens';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  applyTheme,
  DARK_QUERY,
  otherTheme,
  readStoredTheme,
  resolveTheme,
  systemTheme,
  writeStoredTheme,
} from './theme';

type PreferenceListener = (theme: ThemeName) => void;

export interface ThemeContextValue {
  /** The theme in effect. */
  theme: ThemeName;
  /** The explicit choice (local or from the server), or null when following the system. */
  preference: ThemeName | null;
  /** User choice: persisted locally and reported to `useThemePreferenceSync` listeners. */
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
  /** Forget the explicit choice and follow `prefers-color-scheme` again. */
  followSystem: () => void;
  /** Apply a preference that came from elsewhere (e.g. the server) without echoing it back. */
  applyPreference: (theme: ThemeName) => void;
  /** @internal used by `useThemePreferenceSync`. */
  subscribe: (listener: PreferenceListener) => () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Element that receives `data-theme`. Defaults to `<html>`. */
  root?: HTMLElement;
}

export function ThemeProvider({ children, root }: ThemeProviderProps) {
  const [preference, setPreference] = useState<ThemeName | null>(() => readStoredTheme());
  const [system, setSystem] = useState<ThemeName>(() => systemTheme());
  const listeners = useRef(new Set<PreferenceListener>());
  const theme = resolveTheme(preference, system);

  useLayoutEffect(() => {
    applyTheme(theme, root);
  }, [theme, root]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystem(mql.matches ? 'dark' : 'light');
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  const applyPreference = useCallback((next: ThemeName) => {
    writeStoredTheme(next);
    setPreference(next);
  }, []);

  const setTheme = useCallback(
    (next: ThemeName) => {
      applyPreference(next);
      for (const listener of listeners.current) listener(next);
    },
    [applyPreference],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      preference,
      setTheme,
      toggleTheme: () => setTheme(otherTheme(theme)),
      followSystem: () => {
        writeStoredTheme(null);
        setPreference(null);
      },
      applyPreference,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [theme, preference, setTheme, applyPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/**
 * Wires the per-user theme preference stored on the server (ARCHITECTURE "Theme … persisted locally
 * and per user"). Pass the preference from the current user's profile (or undefined while loading)
 * and a callback that saves a new choice. The server value is applied when it arrives; user toggles
 * are reported to `save`.
 */
export function useThemePreferenceSync(
  serverPreference: ThemeName | null | undefined,
  save: (theme: ThemeName) => void,
): void {
  const { applyPreference, subscribe } = useTheme();
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (serverPreference) applyPreference(serverPreference);
  }, [serverPreference, applyPreference]);

  useEffect(() => subscribe((theme) => saveRef.current(theme)), [subscribe]);
}
