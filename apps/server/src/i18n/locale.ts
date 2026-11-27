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

const cache = new WeakMap<Services, Map<string, string | null>>();
const boxCache = new WeakMap<Services, string | null>();
const listeners = new WeakMap<Services, Set<LocaleListener>>();

function accountMap(services: Services): Map<string, string | null> {
  let map = cache.get(services);
  if (!map) {
    map = new Map();
    cache.set(services, map);
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
  boxCache.set(services, configured);
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
export async function configuredAccountLocale(services: Services, accountId: string): Promise<string | null> {
  const map = accountMap(services);
  if (map.has(accountId)) return map.get(accountId) ?? null;
  const [row] = await services.db
    .select({ preferences: accounts.preferences })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const raw = safeLocaleOrNull((row?.preferences as { locale?: unknown } | null)?.locale);
  map.set(accountId, raw);
  boxCache.set(services, raw);
  return raw;
}

/** Reads an account's resolved BCP-47 formatting locale (`en-GB`, `nl-NL`, ...). */
export async function accountLocale(services: Services, accountId: string): Promise<string> {
  const raw = await configuredAccountLocale(services, accountId);
  return raw ? formatLocaleOf(raw) : DEFAULT_LOCALE;
}

/** Reads the box owner's explicitly stored locale tag, or null when unset (default). */
export async function configuredBoxLocale(services: Services): Promise<string | null> {
  if (boxCache.has(services)) return boxCache.get(services) ?? null;
  const [row] = await services.db
    .select({ id: accounts.id, preferences: accounts.preferences })
    .from(accounts)
    .orderBy(asc(accounts.createdAt))
    .limit(1);
  if (!row) return null;
  const raw = safeLocaleOrNull((row.preferences as { locale?: unknown } | null)?.locale);
  accountMap(services).set(row.id, raw);
  boxCache.set(services, raw);
  return raw;
}

/**
 * Reads the single owner's BCP-47 locale for box-wide background work (console, desk, Link emails,
 * security pushes, unattended turns) where no specific viewer session is active.
 */
export async function boxLocale(services: Services): Promise<string> {
  const raw = await configuredBoxLocale(services);
  return raw ? formatLocaleOf(raw) : DEFAULT_LOCALE;
}

/** Convenience helper returning the box owner's resolved UI/agent language (`'en' | 'nl'`). */
export async function boxLanguage(services: Services): Promise<Language> {
  return resolveLanguage(await boxLocale(services));
}

/** Clears cached locales for a `Services` instance (used in tests or restores). */
export function clearLocaleCache(services: Services): void {
  cache.delete(services);
  boxCache.delete(services);
}
