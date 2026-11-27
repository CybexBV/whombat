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

/**
 * The box's locale is its owner's: the first account made on it. Other accounts (a teammate's, a restored one) have
 * languages of their own that must never become the box's, so only the owner's account sets this. Until the owner is
 * known (nothing has read the accounts yet), a change is kept as a guess and checked against the database at the next
 * read.
 */
interface BoxLocale {
  locale: string | null;
  /** Read from the owner's own account, not a guess from whoever changed their language first. */
  sure: boolean;
}
const boxCache = new WeakMap<object, BoxLocale>();
/** The owner's account id, once read. */
const owners = new WeakMap<object, string>();
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
  const key = keyOf(services);
  accountMap(services).set(accountId, configured);
  const owner = owners.get(key);
  if (owner === accountId) boxCache.set(key, { locale: configured, sure: true });
  else if (owner === undefined) boxCache.set(key, { locale: configured, sure: false });
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
  if (owners.get(keyOf(services)) === accountId) boxCache.set(keyOf(services), { locale: raw, sure: true });
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
  const kept = boxCache.get(key);
  if (kept?.sure) return kept.locale;
  let row: { id: string; preferences: unknown } | undefined;
  try {
    [row] = await services.db
      .select({ id: accounts.id, preferences: accounts.preferences })
      .from(accounts)
      .orderBy(asc(accounts.createdAt))
      .limit(1);
  } catch (err) {
    // A guess is better than nothing while the database can't be read (a restore in progress).
    if (kept) return kept.locale;
    throw err;
  }
  if (!row) return kept?.locale ?? null;
  const raw = safeLocaleOrNull((row.preferences as { locale?: unknown } | null)?.locale);
  owners.set(key, row.id);
  accountMap(services).set(row.id, raw);
  boxCache.set(key, { locale: raw, sure: true });
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

/**
 * After something other than the person changed an account's preferences (a restore): forgets what was kept, reads the
 * locale the database has now and tells every listener, so the desk, the widgets, the console and Link's emails follow.
 */
export async function reloadAccountLocale(services: Services, accountId: string): Promise<string | null> {
  clearLocaleCache(services);
  const locale = await configuredAccountLocale(services, accountId);
  notifyLocaleChanged(services, accountId, locale);
  return locale;
}

/** Clears cached locales for a `Services` instance (used in tests or restores). */
export function clearLocaleCache(services: LocaleReader): void {
  cache.delete(keyOf(services));
  boxCache.delete(keyOf(services));
  owners.delete(keyOf(services));
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
