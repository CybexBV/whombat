/**
 * Shared React i18n context, hooks and rich-text slot renderer for `apps/web` and `apps/mobile`.
 * Pure React (no DOM, no `localStorage`, no React Native imports) so both web and mobile use the same provider.
 */
import {
  compareLocaleText,
  createTranslator,
  DEFAULT_LOCALE,
  type DisplayLanguage,
  formatLocaleBytes,
  formatLocaleCurrency,
  formatLocaleList,
  formatLocaleNumber,
  formatLocaleOf,
  formatLocalePercent,
  formatLocaleRegion,
  type Language,
  type LocaleCatalogs,
  type MessageCatalog,
  type MessageVars,
  resolveDisplayLanguage,
  resolveLanguage,
  splitRichTemplate,
  type Translator,
} from '@whombat/core/i18n';
import { createContext, Fragment, type ReactNode, useContext, useMemo } from 'react';
import { type ClientMessageKey, clientTranslator } from './catalog';

export type RichSlots = Record<string, ReactNode>;

/**
 * Renders a localized message template containing `{slot}` tokens into a React fragment without
 * `dangerouslySetInnerHTML`, preserving translator word order across languages.
 */
export function renderRichTemplate(template: string, slots: RichSlots): ReactNode {
  const parts = splitRichTemplate(template);
  const seen = new Map<string, number>();
  return parts.map((part) => {
    const base = part.type === 'text' ? `t:${part.value}` : `s:${part.name}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const key = `${base}#${occurrence}`;
    if (part.type === 'text') return <Fragment key={key}>{part.value}</Fragment>;
    if (part.name in slots) return <Fragment key={key}>{slots[part.name]}</Fragment>;
    return <Fragment key={key}>{`{${part.name}}`}</Fragment>;
  });
}

export interface I18nContextValue {
  /** Resolved BCP-47 formatting locale (`en-GB`, `nl-NL`, …). */
  readonly locale: string;
  /** Raw tag passed to the provider (preserves `pseudo` for dev/QA mode). */
  readonly rawLocale: string;
  /** Supported language (`en` or `nl`). */
  readonly language: Language;
  /** Display language (`en`, `nl` or `pseudo`). */
  readonly displayLanguage: DisplayLanguage;
  /** Updates the active locale when supported by the surface. */
  readonly setLocale?: (nextLocale: string) => void;
  /** Translator bound to `@whombat/client`'s shared catalog. */
  readonly client: Translator<typeof import('./catalog').EN>;
  /** Shorthand for `client.t`. */
  readonly tClient: <K extends ClientMessageKey>(key: K, vars?: MessageVars) => string;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  readonly formatPercent: (value: number, fractionDigits?: number) => string;
  readonly formatBytes: (bytes: number) => string;
  readonly formatCurrency: (
    cents: number,
    currency: 'EUR' | 'USD',
    options?: { trimWhole?: boolean; space?: boolean },
  ) => string;
  readonly formatList: (items: readonly string[], type?: 'conjunction' | 'disjunction') => string;
  readonly formatRegion: (code: string) => string;
  readonly compareText: (a: string, b: string) => number;
}

function buildContextValue(rawTag: string, setLocale?: (nextLocale: string) => void): I18nContextValue {
  const locale = formatLocaleOf(rawTag);
  const language = resolveLanguage(rawTag);
  const displayLanguage = resolveDisplayLanguage(rawTag);
  const client = clientTranslator(rawTag);
  return {
    locale,
    rawLocale: rawTag,
    language,
    displayLanguage,
    ...(setLocale ? { setLocale } : {}),
    client,
    tClient: (key, vars) => client.t(key, vars),
    formatNumber: (v, opts) => formatLocaleNumber(v, locale, opts),
    formatPercent: (v, digits) => formatLocalePercent(v, locale, digits),
    formatBytes: (b) => formatLocaleBytes(b, locale),
    formatCurrency: (c, cur, opts) => formatLocaleCurrency(c, cur, locale, opts),
    formatList: (items, type) => formatLocaleList(items, locale, type),
    formatRegion: (code) => formatLocaleRegion(code, locale),
    compareText: (a, b) => compareLocaleText(a, b, locale),
  };
}

const DEFAULT_VALUE = buildContextValue(DEFAULT_LOCALE);

const I18nContext = createContext<I18nContextValue>(DEFAULT_VALUE);

export interface I18nProviderProps {
  /** Active locale tag (e.g. `en-GB`, `nl-NL`, or `pseudo`). Defaults to `en-GB`. */
  locale?: string | null | undefined;
  setLocale?: ((nextLocale: string) => void) | undefined;
  children: ReactNode;
}

/** Provides the active locale and `@whombat/core/i18n` formatters to React trees on web and mobile. */
export function I18nProvider({ locale, setLocale, children }: I18nProviderProps) {
  const rawTag = locale?.trim() || DEFAULT_LOCALE;
  const value = useMemo(() => buildContextValue(rawTag, setLocale), [rawTag, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** Returns the active locale tag (preserving `pseudo` when QA mode is active). */
export function useLocale(): string {
  return useContext(I18nContext).rawLocale;
}

/** Returns the active supported language (`en` or `nl`). */
export function useLanguage(): Language {
  return useContext(I18nContext).language;
}

export interface SurfaceTranslator<T extends MessageCatalog> extends Translator<T> {
  /** Renders a template with named React node slots `{slot}`. */
  tx<K extends keyof T & string>(key: K, slots: RichSlots, count?: number): ReactNode;
}

/**
 * Creates a typed React hook bound to a surface's own co-located catalog (e.g. `apps/web` or `apps/mobile`)
 * using the active `I18nProvider` locale.
 */
export function createCatalogHook<T extends MessageCatalog>(
  catalogs: LocaleCatalogs<T>,
): () => SurfaceTranslator<T> {
  return function useCatalogT(): SurfaceTranslator<T> {
    const { rawLocale } = useI18n();
    return useMemo(() => {
      const base = createTranslator(catalogs, rawLocale);
      return {
        ...base,
        tx: (key, slots, count) => renderRichTemplate(base.raw(key, count), slots),
      };
    }, [rawLocale]);
  };
}
