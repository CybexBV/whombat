import {
  DEFAULT_LOCALE,
  formatLocaleOf,
  type Language,
  resolveLanguage,
  safeLocaleOrNull,
} from '@whombat/core/i18n';
import { asc, eq } from 'drizzle-orm';
import { accounts } from '../db/schema/index';
import type { Services } from '../services';

type LocaleListener = (accountId: string, locale: string | null) => void;

// Keyed by the database handle rather than the `Services` object, so parts that hold only the database (the hosts
// client) read the same cached locale as the rest of the server.
const cache = new WeakMap<object, Map<string, string | null>>();
const boxCache = new WeakMap<object, string | null>();
const listeners = new WeakMap<Services, Set<LocaleListener>>();

type LocaleReader = Pick<Services, 'db'>;

const keyOf = (services: LocaleReader): object => (services.db as object | undefined) ?? services;

function accountMap(services: LocaleReader): Map<string, string | null> {
  const key = keyOf(services);
  let map = cache.get(key);
  if (!map) {
    map = new Map();
    cache.set(key, map);
  }
  return map;
}

/** Subscribe to owner locale changes (for cache invalidation on desk, widgets, console, Link email). */
export function onLocaleChange(services: Services, listener: LocaleListener): () => void {
  let set = listeners.get(services);
  if (!set) {
    set = new Set();
    listeners.set(services, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

/** Updates cached locale after `me.updatePreferences` or claim commits, and notifies listeners. */
export function notifyLocaleChanged(
  services: Services,
  accountId: string,
  rawLocale: string | null | undefined,
): void {
  const configured = safeLocaleOrNull(rawLocale);
  accountMap(services).set(accountId, configured);
  boxCache.set(keyOf(services), configured);
  const set = listeners.get(services);
  if (set) {
    for (const fn of [...set]) {
      try {
        fn(accountId, configured);
      } catch {
        // Cache/listener failure must not break preference updates.
      }
    }
  }
}

/** Reads an account's explicitly stored BCP-47 locale tag, or null when unset (default). */
export async function configuredAccountLocale(
  services: LocaleReader,
  accountId: string,
): Promise<string | null> {
  const map = accountMap(services);
  if (map.has(accountId)) return map.get(accountId) ?? null;
  const [row] = await services.db
    .select({ preferences: accounts.preferences })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const raw = safeLocaleOrNull((row?.preferences as { locale?: unknown } | null)?.locale);
  map.set(accountId, raw);
  boxCache.set(keyOf(services), raw);
  return raw;
}

/** Reads an account's resolved BCP-47 formatting locale (`en-GB`, `nl-NL`, ...). */
export async function accountLocale(services: LocaleReader, accountId: string): Promise<string> {
  const raw = await configuredAccountLocale(services, accountId);
  return raw ? formatLocaleOf(raw) : DEFAULT_LOCALE;
}

/** Reads the box owner's explicitly stored locale tag, or null when unset (default). */
export async function configuredBoxLocale(services: LocaleReader): Promise<string | null> {
  const key = keyOf(services);
  if (boxCache.has(key)) return boxCache.get(key) ?? null;
  const [row] = await services.db
    .select({ id: accounts.id, preferences: accounts.preferences })
    .from(accounts)
    .orderBy(asc(accounts.createdAt))
    .limit(1);
  if (!row) return null;
  const raw = safeLocaleOrNull((row.preferences as { locale?: unknown } | null)?.locale);
  accountMap(services).set(row.id, raw);
  boxCache.set(key, raw);
  return raw;
}

/**
 * Reads the single owner's BCP-47 locale for box-wide background work (console, desk, Link emails,
 * security pushes, unattended turns) where no specific viewer session is active.
 */
export async function boxLocale(services: LocaleReader): Promise<string> {
  const raw = await configuredBoxLocale(services);
  return raw ? formatLocaleOf(raw) : DEFAULT_LOCALE;
}

/** Convenience helper returning the box owner's resolved UI/agent language (`'en' | 'nl'`). */
export async function boxLanguage(services: LocaleReader): Promise<Language> {
  return resolveLanguage(await boxLocale(services));
}

/** Clears cached locales for a `Services` instance (used in tests or restores). */
export function clearLocaleCache(services: LocaleReader): void {
  cache.delete(keyOf(services));
  boxCache.delete(keyOf(services));
}

/**
 * The burrow's (this box's) owner locale for what the server renders without a viewer session: Home and Needs you,
 * desk screens, emails, pushes and notices. A box has one person, so the burrow's locale is the box's. Never throws:
 * a read that fails (a test without a database, a restore in progress) renders English.
 */
export async function burrowLocale(
  services: LocaleReader | null | undefined,
  _burrowId?: string,
): Promise<string> {
  if (!services?.db) return DEFAULT_LOCALE;
  try {
    return await boxLocale(services);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** The locale an explicit tag names, else the burrow's: a caller's own choice wins (a viewer who picked a language). */
export async function resolveBurrowLocale(
  services: LocaleReader | null | undefined,
  explicit?: string | null,
): Promise<string> {
  const own = safeLocaleOrNull(explicit);
  return own ? formatLocaleOf(own) : burrowLocale(services);
}
