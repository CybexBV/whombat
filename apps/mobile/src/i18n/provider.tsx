import { useQueryClient } from '@tanstack/react-query';
import { I18nProvider, useI18n } from '@whombat/client/i18n/react';
import { parseKey } from '@whombat/client/query';
import { usePreferences, useWhombat } from '@whombat/client/react';
import { api } from '@whombat/core';
import { DEFAULT_LOCALE, formatLocaleOf } from '@whombat/core/i18n';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WhombatLive } from '../../modules/whombat-live';
import type { QueryPersister } from '../data/queryPersist';
import { secureStore } from '../lib/storage';
import { boxLocale, deviceLocale, saveBoxLocale } from './locale';

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
      // Search's cursors and the box's rendered text belong to the language that produced them.
      void qc.resetQueries({
        predicate: (query) => {
          const id = parseKey(query.queryKey)?.endpointId;
          return !!id && /^(home|things|search|notifications)\./.test(id);
        },
      });
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
      if (result.status !== 'ok' || boxLocale(result.data.locale) !== next) {
        throw new Error('Language preference was not saved');
      }
      qc.setQueryData(key, result.data);
    },
    [client, qc, queries],
  );

  return (
    <SaveLocaleContext.Provider value={connected ? save : null}>
      <MobileI18nProvider locale={locale}>{children}</MobileI18nProvider>
    </SaveLocaleContext.Provider>
  );
}

const SaveLocaleContext = createContext<((next: string) => Promise<void>) | null>(null);

export function useSaveLocale() {
  return useContext(SaveLocaleContext);
}

export function useClaimLocale() {
  return useI18n().locale;
}
