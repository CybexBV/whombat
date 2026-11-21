/**
 * The theme as the account's preference (README: "persist per user"): against a server the app adopts the account's
 * theme when it loads or changes elsewhere, and a pick on the phone is saved to it; the device keeps a copy so the next
 * launch starts in the right theme before the bootstrap loads. Light/dark follows the system until one is picked. Was
 * the settings sheet's (settings-tab-android.md AP-2628); mounted around the navigator so it works on any tab.
 */
import { useBootstrapSelect, useWhombat } from '@whombat/client/react';
import type { Bootstrap } from '@whombat/core';
import { createContext, type ReactNode, useCallback, useContext, useEffect } from 'react';
import { useBurrowBase } from '../data/BurrowProvider';
import type { ThemePreference } from '../theme/preference';
import { useThemeContext } from '../theme/theme';

const themeOf = (bootstrap: Bootstrap) => bootstrap.preferences.theme;

const SetThemeContext = createContext<((preference: ThemePreference) => void) | null>(null);

/** The account's theme (server mode): adopt it when it loads or changes elsewhere; save changes to it. */
function useAccountTheme(): (preference: ThemePreference) => void {
  // Only the theme of the bootstrap: this is around the navigator, and every new message changes the rest.
  const { mode, slug } = useBurrowBase();
  const { client } = useWhombat();
  const { setPreference } = useThemeContext();
  const theme = useBootstrapSelect(slug, themeOf);
  const accountTheme = mode !== 'fixtures' ? (theme ?? null) : null;
  useEffect(() => {
    if (accountTheme) setPreference(accountTheme);
  }, [accountTheme, setPreference]);
  return useCallback(
    (preference: ThemePreference) => {
      setPreference(preference);
      if (mode !== 'fixtures')
        void client.me.updatePreferences({ body: { theme: preference } }).catch(() => {});
    },
    [mode, client, setPreference],
  );
}

export function AccountThemeProvider({ children }: { children: ReactNode }) {
  const setTheme = useAccountTheme();
  return <SetThemeContext.Provider value={setTheme}>{children}</SetThemeContext.Provider>;
}

/** Picks the theme, saved to the account where there is one. */
export function useSetTheme(): (preference: ThemePreference) => void {
  const set = useContext(SetThemeContext);
  if (!set) throw new Error('useSetTheme() must be used inside <AccountThemeProvider>');
  return set;
}
