/**
 * The web app's language (docs/decisions/i18n.md): which language is shown, its words, and keeping it in step with the
 * box owner's choice (`accounts.preferences.locale`). English is part of the page; Dutch is a chunk of its own, loaded
 * only when Dutch is shown, so English sessions never fetch it.
 */
import type { QueryClient } from '@tanstack/react-query';
import { I18nProvider, type RichSlots, renderRichTemplate, useI18n } from '@whombat/client/i18n/react';
import {
  createTranslator,
  DEFAULT_LOCALE,
  type MessageValue,
  type MessageVars,
  resolveDisplayLanguage,
  resolveLanguage,
} from '@whombat/core/i18n';
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { setServiceWorkerLanguage } from '../push/webPush';
import { EN } from './en';
import {
  browserLocale,
  cleanLocaleTag,
  htmlLangOf,
  readCachedLocale,
  readLocaleOverride,
  writeCachedLocale,
} from './locale';

export type WebMessageKey = keyof typeof EN;
export type DutchCatalog = Readonly<Record<WebMessageKey, MessageValue>>;

/** The language tag the page shows now, for code outside React components (`currentLocale`). */
let activeTag: string = DEFAULT_LOCALE;

/** The `locale` to give the shared packages' words: the tag, or nothing in plain English (their own English). */
function wordsLocaleOf(tag: string | null | undefined): string | undefined {
  if (!tag) return undefined;
  return resolveDisplayLanguage(tag) === 'en' ? undefined : tag;
}

/**
 * The page's language for code that isn't a component (models, catalogs, toasts built in callbacks), as the `locale`
 * of the shared packages' words: nothing in English. Components use `useWebI18n().tag`. A language change remounts
 * the app's screens (`LanguageBoundary`), so what was built with the old one is built again.
 */
export function currentLocale(): string | undefined {
  return wordsLocaleOf(activeTag);
}

let dutch: DutchCatalog | null = null;
let dutchLoading: Promise<DutchCatalog> | null = null;

/** Loads the Dutch words once (its own chunk); later calls share the first load. */
export function loadDutch(): Promise<DutchCatalog> {
  if (dutch) return Promise.resolve(dutch);
  dutchLoading ??= import('./nl').then(
    (m) => {
      dutch = m.NL;
      return m.NL;
    },
    (err: unknown) => {
      dutchLoading = null;
      throw err;
    },
  );
  return dutchLoading;
}

/** The Dutch words when they have been loaded, else null. */
export function loadedDutch(): DutchCatalog | null {
  return dutch;
}

/**
 * Whose language a page shows: `owner` is the box owner's app (their stored choice, cached per box); `visitor` is
 * a page someone else opens (a shared link, the claim before an account exists), which follows the visitor's own
 * browser and never the owner's.
 */
export type LocaleScope = 'owner' | 'visitor';

export interface WebI18nControl {
  readonly scope: LocaleScope;
  /** The language the person chose here (the picker); applied at once and remembered for this box. */
  setLocale(tag: string): void;
  /** The owner's stored language as the box reported it (`undefined` while unknown, null for the default). */
  applyOwnerLocale(tag: string | null | undefined): void;
  /** The box this page talks to, so its language is cached under it. */
  setBox(boxId: string | null): void;
  /** A query cache whose server-written words are fetched again when the language changes. */
  addQueryClient(queryClient: QueryClient): () => void;
  /** Fetches the server-written words again (after the box saved a new language). */
  refreshServerText(): void;
}

const ControlContext = createContext<WebI18nControl | null>(null);
const DutchContext = createContext<DutchCatalog | null>(null);

export interface WebI18nProviderProps {
  children: ReactNode;
  /** Whose language this page shows (default `owner`). */
  scope?: LocaleScope;
  /** The box this page talks to, when known. */
  boxId?: string | null;
  /** A query cache to refresh when the language changes. */
  queryClient?: QueryClient | null;
  /** A starting language for tests and stories; `?lang=` still wins. */
  initialLocale?: string | null;
}

/**
 * Provides the web app's language. Nested inside another one (the app's providers inside a box's root), it adds its box
 * and query cache to the outer one and renders nothing of its own, so one page has one language.
 */
export function WebI18nProvider(props: WebI18nProviderProps) {
  const outer = useContext(ControlContext);
  if (outer) return <NestedProvider outer={outer} {...props} />;
  return <RootProvider {...props} />;
}

function NestedProvider({
  outer,
  boxId,
  queryClient,
  children,
}: WebI18nProviderProps & { outer: WebI18nControl }) {
  useEffect(() => {
    if (boxId !== undefined) outer.setBox(boxId);
  }, [outer, boxId]);
  useEffect(() => (queryClient ? outer.addQueryClient(queryClient) : undefined), [outer, queryClient]);
  return <>{children}</>;
}

interface LocaleState {
  boxId: string | null;
  /** The owner's language (stored on the box, or cached for it); null while unknown. */
  owner: string | null;
  /** A language chosen on this page before the box knows it (the claim's picker, a visitor's choice). */
  chosen: string | null;
  /** The tab's `?lang=` test language. */
  override: string | null;
}

function startState(scope: LocaleScope, boxId: string | null, initial: string | null): LocaleState {
  return {
    boxId,
    owner: scope === 'owner' ? (cleanLocaleTag(initial) ?? readCachedLocale(boxId)) : null,
    chosen: scope === 'visitor' ? cleanLocaleTag(initial) : null,
    override: readLocaleOverride(),
  };
}

function wantedTag(scope: LocaleScope, state: LocaleState): string {
  if (state.override) return state.override;
  if (scope === 'visitor') return state.chosen ?? browserLocale();
  return state.owner ?? state.chosen ?? browserLocale();
}

function RootProvider({
  children,
  scope = 'owner',
  boxId = null,
  queryClient,
  initialLocale = null,
}: WebI18nProviderProps) {
  const [state, setState] = useState<LocaleState>(() => startState(scope, boxId, initialLocale));
  const [nl, setNl] = useState<DutchCatalog | null>(() => loadedDutch());
  const [dutchFailed, setDutchFailed] = useState(false);
  const queryClients = useRef(new Set<QueryClient>());

  const wanted = wantedTag(scope, state);
  const wantsDutch = resolveLanguage(wanted) === 'nl' && resolveDisplayLanguage(wanted) !== 'pseudo';
  // While the Dutch words load, the page keeps the language it had (none yet on the first paint).
  const shownRef = useRef<string | null>(null);
  const ready = !wantsDutch || nl !== null || dutchFailed;
  const shown = ready ? (wantsDutch && !nl ? DEFAULT_LOCALE : wanted) : shownRef.current;
  shownRef.current = shown;
  // Set while rendering, before the children read it.
  if (shown) activeTag = shown;

  useEffect(() => {
    if (!wantsDutch || nl) return;
    let live = true;
    loadDutch().then(
      (catalog) => {
        if (live) setNl(catalog);
      },
      () => {
        if (live) setDutchFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [wantsDutch, nl]);

  useEffect(() => {
    if (queryClient) queryClients.current.add(queryClient);
  }, [queryClient]);

  useLayoutEffect(() => {
    if (!shown || typeof document === 'undefined') return;
    document.documentElement.lang = htmlLangOf(shown);
  }, [shown]);

  const shownLanguage = shown ? resolveLanguage(shown) : null;
  useEffect(() => {
    if (scope === 'owner' && shownLanguage) setServiceWorkerLanguage(shownLanguage);
  }, [scope, shownLanguage]);

  // Server-written words (dashboards, Home and Inbox lines) come back in the new language.
  const lastShown = useRef<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    const before = lastShown.current;
    lastShown.current = shown;
    if (before === null || resolveDisplayLanguage(before) === resolveDisplayLanguage(shown)) return;
    for (const client of queryClients.current) void client.invalidateQueries();
  }, [shown]);

  const control = useMemo<WebI18nControl>(
    () => ({
      scope,
      setLocale: (tag) => {
        const clean = cleanLocaleTag(tag);
        if (!clean) return;
        setState((s) => {
          if (scope === 'owner') writeCachedLocale(s.boxId, clean);
          return scope === 'owner' ? { ...s, owner: clean, chosen: clean } : { ...s, chosen: clean };
        });
      },
      applyOwnerLocale: (tag) => {
        if (tag === undefined || scope !== 'owner') return;
        const clean = cleanLocaleTag(tag) ?? DEFAULT_LOCALE;
        setState((s) => {
          writeCachedLocale(s.boxId, clean);
          return s.owner === clean ? s : { ...s, owner: clean };
        });
      },
      setBox: (next) => {
        setState((s) => {
          if (s.boxId === next) return s;
          const cached = scope === 'owner' && next ? readCachedLocale(next) : null;
          return { ...s, boxId: next, owner: cached ?? s.owner };
        });
      },
      addQueryClient: (client) => {
        queryClients.current.add(client);
        return () => {
          queryClients.current.delete(client);
        };
      },
      refreshServerText: () => {
        for (const client of queryClients.current) void client.invalidateQueries();
      },
    }),
    [scope],
  );

  const setLocale = useCallback((tag: string) => control.setLocale(tag), [control]);

  if (shown === null) return null;
  return (
    <ControlContext.Provider value={control}>
      <DutchContext.Provider value={nl}>
        <I18nProvider locale={shown} setLocale={setLocale}>
          {children}
        </I18nProvider>
      </DutchContext.Provider>
    </ControlContext.Provider>
  );
}

/**
 * Draws its children again from scratch when the language changes, so words built once (in a model, a memo, a
 * module's helper) are built again in the new language. Around the app's screens only: the session and the providers
 * above it stay.
 */
export function LanguageBoundary({ children }: { children: ReactNode }) {
  const { displayLanguage } = useI18n();
  return <Fragment key={displayLanguage}>{children}</Fragment>;
}

/** The page's language controls (null outside a `WebI18nProvider`: stories and isolated tests). */
export function useWebLocaleControl(): WebI18nControl | null {
  return useContext(ControlContext);
}

/**
 * Keeps the page in the owner's stored language: pass `accounts.preferences.locale` once the box has answered (null
 * for the default), `undefined` while it hasn't.
 */
export function useOwnerLocaleSync(locale: string | null | undefined): void {
  const control = useContext(ControlContext);
  useEffect(() => {
    control?.applyOwnerLocale(locale);
  }, [control, locale]);
}

export interface WebTranslator {
  /** The resolved formatting locale (`en-GB`, `nl-NL`): for `Intl` and the formatters. */
  readonly locale: string;
  /**
   * What to pass as `locale` to the words of `@whombat/core` and `@whombat/client`: the page's tag (`nl-NL`, or
   * `pseudo` in QA mode), and nothing in English, so the packages give exactly the English they always gave.
   */
  readonly tag: string | undefined;
  readonly language: 'en' | 'nl';
  readonly displayLanguage: 'en' | 'nl' | 'pseudo';
  t(key: WebMessageKey, vars?: MessageVars): string;
  tp(key: WebMessageKey, count: number, vars?: MessageVars): string;
  raw(key: WebMessageKey, count?: number): string;
  /** A message with React nodes in its `{slots}`. */
  tx(key: WebMessageKey, slots: RichSlots, count?: number): ReactNode;
}

/** The web catalog's words for a locale tag, with the Dutch words when they are loaded (English for each key otherwise). */
export function webTranslator(
  tag: string | null | undefined,
  nl: DutchCatalog | null = loadedDutch(),
): WebTranslator {
  const base = createTranslator<typeof EN>(nl ? { en: EN, nl } : { en: EN }, tag ?? DEFAULT_LOCALE);
  return {
    locale: base.locale,
    tag: wordsLocaleOf(tag),
    language: base.language === 'nl' ? 'nl' : 'en',
    displayLanguage: base.language,
    t: base.t,
    tp: base.tp,
    raw: base.raw,
    tx: (key, slots, count) => renderRichTemplate(base.raw(key, count), slots),
  };
}

/** The web app's words in the page's language (English outside a provider). */
export function useWebI18n(): WebTranslator {
  const { rawLocale } = useI18n();
  const nl = useContext(DutchContext);
  return useMemo(() => webTranslator(rawLocale, nl), [rawLocale, nl]);
}
