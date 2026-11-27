import { useQueryClient } from '@tanstack/react-query';
import { I18nProvider, useI18n } from '@whombat/client/i18n/react';
import { usePreferences, useSessionProtocol, useWhombat } from '@whombat/client/react';
import { api } from '@whombat/core';
import { DEFAULT_LOCALE, formatLocaleOf } from '@whombat/core/i18n';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { WhombatLive } from '../../modules/whombat-live';
import type { QueryPersister } from '../data/queryPersist';
import { secureStore } from '../lib/storage';
import { boxLocale, canSaveBoxLocale, deviceLocale, saveBoxLocale } from './locale';
import { refreshLanguageQueries } from './refreshLanguageQueries';

export function MobileI18nProvider({ locale, children }: { locale?: string; children: ReactNode }) {
  const [system] = useState(deviceLocale);
  return <I18nProvider locale={locale ?? system}>{children}</I18nProvider>;
}

export function BoxI18nProvider({
  scope,
  connected,
  initialLocale,
  persister,
  children,
}: {
  scope: string;
  connected: boolean;
  initialLocale: string | undefined;
  persister: QueryPersister;
  children: ReactNode;
}) {
  const { client, queries } = useWhombat();
  const canSave = canSaveBoxLocale(connected, useSessionProtocol());
  const qc = useQueryClient();
  const preferences = usePreferences(connected ? {} : null, {
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 30_000,
  });
  const [confirmed, setConfirmed] = useState<string | undefined>();
  const locale = confirmed ?? initialLocale ?? DEFAULT_LOCALE;
  const previous = useRef({ value: locale, confirmed: false });
  const tag = preferences.data && boxLocale(preferences.data.locale);

  useEffect(() => {
    if (tag === undefined) return;
    const prior = previous.current.confirmed ? previous.current.value : (initialLocale ?? DEFAULT_LOCALE);
    previous.current = { value: tag, confirmed: true };
    setConfirmed(tag);
    if (prior !== tag) {
      persister.setLocale(tag);
      void refreshLanguageQueries(qc);
    }
    void saveBoxLocale(secureStore, scope, tag);
  }, [tag, scope, persister, qc, initialLocale]);

  useEffect(() => {
    if (initialLocale !== undefined || confirmed !== undefined) WhombatLive.setLocale(formatLocaleOf(locale));
  }, [locale, initialLocale, confirmed]);

  const save = useCallback(
    async (next: string) => {
      const key = queries.endpoint(api.me.getPreferences, {}).queryKey;
      await qc.cancelQueries({ queryKey: key });
      const result = await client.me.updatePreferences({ body: { locale: next } });
      await qc.cancelQueries({ queryKey: key });
      if (result.status !== 'ok' || !result.data.locale || boxLocale(result.data.locale) !== next) {
        throw new Error('Language preference was not saved');
      }
      qc.setQueryData(key, result.data);
    },
    [client, qc, queries],
  );

  const localeControl = useMemo<LocaleControl>(
    () => ({ save: canSave ? save : null, needsUpdate: connected && !canSave }),
    [canSave, connected, save],
  );

  return (
    <SaveLocaleContext.Provider value={localeControl}>
      <MobileI18nProvider locale={locale}>{children}</MobileI18nProvider>
    </SaveLocaleContext.Provider>
  );
}

interface LocaleControl {
  save: ((next: string) => Promise<void>) | null;
  needsUpdate: boolean;
}

const SaveLocaleContext = createContext<LocaleControl>({ save: null, needsUpdate: false });

export function useSaveLocale() {
  return useContext(SaveLocaleContext).save;
}

export function useLocaleNeedsUpdate() {
  return useContext(SaveLocaleContext).needsUpdate;
}

export function useClaimLocale() {
  return useI18n().locale;
}
