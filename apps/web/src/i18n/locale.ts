/**
 * Which language the web app shows before and after it knows the box owner's choice (docs/decisions/i18n.md): a
 * tab's `?lang=` test choice, the owner's stored language (cached per box in this browser), a visitor's browser
 * languages, else English. Browser storage only; every read and write survives storage being blocked.
 */
import {
  DEFAULT_LOCALE,
  type DisplayLanguage,
  LANGUAGE_DEFAULT_LOCALE,
  normalizeLocaleTag,
  resolveDisplayLanguage,
  resolvePreferredLanguage,
} from '@whombat/core/i18n';
import { LOCALE_LAST_KEY, LOCALE_OVERRIDE_KEY } from '../app/theme/noFlash';

export { LOCALE_LAST_KEY, LOCALE_OVERRIDE_KEY };

/** The tag stored for the dev/QA pseudo-locale. */
export const PSEUDO_TAG = 'pseudo';

/** The cache key of one box's language in this browser. */
export function localeBoxKey(boxId: string): string {
  return `whombat.locale.${boxId}`;
}

/**
 * A raw `?lang=` value or stored tag as the tag the app uses: `nl` → `nl-NL`, `en` → `en-GB`, `pseudo` kept; null for
 * anything else (an unknown language falls back to the next source rather than to a language Whombat lacks).
 */
export function cleanLocaleTag(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (resolveDisplayLanguage(value) === 'pseudo') return PSEUDO_TAG;
  const tag = normalizeLocaleTag(value);
  if (!tag) return null;
  const primary = tag.split('-')[0];
  if (primary === 'nl' || primary === 'en') return tag;
  return null;
}

/** The value the person asked to drop the test choice with (`?lang=auto` or an empty `?lang=`). */
function clearsOverride(raw: string | null): boolean {
  return raw !== null && (raw.trim() === '' || raw.trim().toLowerCase() === 'auto');
}

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(store: Storage | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: Storage | null, key: string, value: string | null): void {
  try {
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Blocked or full storage: the language still applies to this page.
  }
}

/**
 * The tab's test language: `?lang=` first (kept for the tab, so links inside the app keep it), else what the tab kept.
 * `?lang=auto` drops it.
 */
export function readLocaleOverride(search: string = currentSearch()): string | null {
  let param: string | null = null;
  try {
    param = new URLSearchParams(search).get('lang');
  } catch {
    param = null;
  }
  if (clearsOverride(param)) {
    write(session(), LOCALE_OVERRIDE_KEY, null);
    return null;
  }
  const fromQuery = cleanLocaleTag(param);
  if (fromQuery) {
    write(session(), LOCALE_OVERRIDE_KEY, fromQuery);
    return fromQuery;
  }
  return cleanLocaleTag(read(session(), LOCALE_OVERRIDE_KEY));
}

function currentSearch(): string {
  try {
    return typeof location === 'undefined' ? '' : location.search;
  } catch {
    return '';
  }
}

/** The language this browser last showed for a box (or for any box when none is known yet). */
export function readCachedLocale(boxId: string | null): string | null {
  const store = local();
  if (boxId) {
    const own = cleanLocaleTag(read(store, localeBoxKey(boxId)));
    if (own) return own;
  }
  return cleanLocaleTag(read(store, LOCALE_LAST_KEY));
}

/** Remembers a box's language for the next first paint. */
export function writeCachedLocale(boxId: string | null, tag: string): void {
  const store = local();
  if (boxId) write(store, localeBoxKey(boxId), tag);
  write(store, LOCALE_LAST_KEY, tag);
}

/**
 * A visitor's language from their browser (`navigator.languages`), formatted the Whombat way (`en-GB` day-first
 * dates, `nl-NL` decimals) whatever the region was.
 */
export function browserLocale(languages: readonly string[] | null = navigatorLanguages()): string {
  if (!languages || languages.length === 0) return DEFAULT_LOCALE;
  return LANGUAGE_DEFAULT_LOCALE[resolvePreferredLanguage(languages)];
}

function navigatorLanguages(): readonly string[] | null {
  try {
    if (typeof navigator === 'undefined') return null;
    if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
    return navigator.language ? [navigator.language] : null;
  } catch {
    return null;
  }
}

/**
 * The language a new box is claimed in: the tab's `?lang=` test language, else the language the claimant chose on this
 * page, else their browser's, else English. Never the language this browser remembers from another box: the claimant
 * may not be that box's owner, and they never chose it for this one. The pseudo-locale is a page language only.
 */
export function claimantLocale(
  chosen: string | null,
  search: string = currentSearch(),
  languages: readonly string[] | null = navigatorLanguages(),
): string {
  const override = readLocaleOverride(search);
  if (override && override !== PSEUDO_TAG) return override;
  const picked = cleanLocaleTag(chosen);
  if (picked && picked !== PSEUDO_TAG) return picked;
  return browserLocale(languages);
}

/** What `<html lang>` says for a tag: the BCP-47 tag, `en-XA` for the pseudo-locale. */
export function htmlLangOf(tag: string): string {
  const language: DisplayLanguage = resolveDisplayLanguage(tag);
  if (language === 'pseudo') return 'en-XA';
  return cleanLocaleTag(tag) ?? DEFAULT_LOCALE;
}

/** The stored form of a language choice: `nl-NL` or `en-GB`. */
export function storedLocaleOf(language: 'en' | 'nl'): string {
  return LANGUAGE_DEFAULT_LOCALE[language];
}
