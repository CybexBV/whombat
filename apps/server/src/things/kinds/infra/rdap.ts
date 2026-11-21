/**
 * Public RDAP domain registration expiry lookups (RFC 9224 bootstrap + RFC 9083 domain queries).
 *
 * Every network request goes through `outboundRequest` with the public-HTTPS policy so private, loopback,
 * link-local and reserved addresses can never be reached even via registry redirects. Results are cached
 * in memory per server instance so repeated reads stay polite to registries.
 */
import { outboundRequest } from '../../../lib/outbound';
import type { Services } from '../../../services';
import { list, rec, str } from '../../words';

export const IANA_RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

const BOOTSTRAP_OK_MS = 24 * 60 * 60_000;
const BOOTSTRAP_ERR_MS = 15 * 60_000;
const DOMAIN_OK_MS = 12 * 60 * 60_000;
const DOMAIN_ERR_MS = 60 * 60_000;
/** Overall deadline across bootstrap, redirects and domain lookups for one RDAP check. */
export const RDAP_DEADLINE_MS = 4_000;
const RDAP_MAX_BYTES = 512 * 1024;
const RDAP_MAX_REDIRECTS = 2;

/** Top-level domains reserved for local networks or documentation; never query public RDAP for these. */
const NON_PUBLIC_TLDS = new Set([
  'local',
  'lan',
  'home',
  'arpa',
  'internal',
  'intranet',
  'corp',
  'localhost',
  'example',
  'invalid',
  'test',
]);

export interface RdapFetchResult {
  ok: boolean;
  status: number;
  json?: unknown;
}

export type RdapFetch = (url: string, budgetMs?: number) => Promise<RdapFetchResult>;

/**
 * Parses IANA's RFC 9224 DNS bootstrap JSON into a map of lowercase TLD → authoritative HTTPS RDAP base URL
 * ending with `/`. Entries without an `https://` URL are skipped.
 */
export function parseRdapBootstrap(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const services = list(rec(body).services);
  for (const entry of services) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const tlds = list(entry[0]);
    const urls = list(entry[1]);
    const base = urls.map(str).find((u): u is string => !!u && /^https:\/\//i.test(u.trim()));
    if (!base) continue;
    const normalized = `${base.trim().replace(/\/+$/, '')}/`;
    for (const rawTld of tlds) {
      const tld = str(rawTld)
        ?.trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, '');
      if (tld && !out.has(tld)) out.set(tld, normalized);
    }
  }
  return out;
}

/**
 * Resolves the authoritative RDAP domain lookup URL for a domain name using the IANA bootstrap map.
 * Returns null for invalid names, IP literals, non-public TLDs, or TLDs with no published HTTPS RDAP server.
 */
export function rdapUrlForDomain(domain: string, bootstrap: ReadonlyMap<string, string>): string | null {
  const clean = domain.trim().toLowerCase().replace(/\.+$/, '');
  if (!clean || clean.length > 253 || !clean.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(clean) || clean.includes('..') || /^\d+(?:\.\d+)+$/.test(clean)) return null;
  const parts = clean.split('.');
  const top = parts[parts.length - 1];
  if (!top || NON_PUBLIC_TLDS.has(top)) return null;
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('.');
    const base = bootstrap.get(suffix);
    if (base) return `${base}domain/${encodeURIComponent(clean)}`;
  }
  return null;
}

/**
 * Extracts a domain's registration expiration timestamp from an RFC 9083 RDAP domain JSON response.
 * Prefers the standard `expiration` event and falls back to `registrar expiration` if present.
 */
export function parseRdapExpiration(body: unknown): Date | null {
  const events = list(rec(body).events);
  let fallback: Date | null = null;
  for (const raw of events) {
    const ev = rec(raw);
    const action = str(ev.eventAction)?.trim().toLowerCase();
    const rawDate = str(ev.eventDate)?.trim();
    if (!action || !rawDate) continue;
    const ms = Date.parse(rawDate);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (action === 'expiration') return new Date(ms);
    if (action === 'registrar expiration' && !fallback) fallback = new Date(ms);
  }
  return fallback;
}

/**
 * Fetches JSON from a public HTTPS URL under the outbound SSRF policy, following at most two safe HTTPS hops
 * within one shared deadline across all hops.
 */
export async function defaultRdapFetch(
  initialUrl: string,
  budgetMs = RDAP_DEADLINE_MS,
): Promise<RdapFetchResult> {
  const endAt = Date.now() + Math.max(0, budgetMs);
  let current = initialUrl;
  for (let hop = 0; hop <= RDAP_MAX_REDIRECTS; hop++) {
    const remaining = endAt - Date.now();
    if (remaining <= 0) return { ok: false, status: 0 };
    let res: Awaited<ReturnType<typeof outboundRequest>>;
    try {
      res = await outboundRequest(
        current,
        {
          method: 'GET',
          headers: {
            accept: 'application/rdap+json, application/json',
            'user-agent': 'Whombat',
          },
        },
        {
          timeoutMs: remaining,
          deadlineMs: remaining,
          maxBytes: RDAP_MAX_BYTES,
        },
      );
    } catch {
      return { ok: false, status: 0 };
    }
    if (res.status >= 300 && res.status < 400 && hop < RDAP_MAX_REDIRECTS) {
      const location = res.headers.location;
      const target = Array.isArray(location) ? location[0] : location;
      if (!target) return { ok: false, status: res.status };
      try {
        current = new URL(target, current).toString();
      } catch {
        return { ok: false, status: res.status };
      }
      continue;
    }
    if (res.status === 404) return { ok: true, status: 404, json: null };
    if (res.status < 200 || res.status >= 300) return { ok: false, status: res.status };
    try {
      const json: unknown = JSON.parse(res.body.toString('utf8'));
      return { ok: true, status: res.status, json };
    } catch {
      return { ok: false, status: res.status };
    }
  }
  return { ok: false, status: 0 };
}

interface CacheEntry<T> {
  value: T;
  until: number;
}

interface RdapCache {
  bootstrap: CacheEntry<Map<string, string> | null> | null;
  domains: Map<string, CacheEntry<{ ok: true; expires: Date | null } | { ok: false }>>;
  warming: Promise<void> | null;
}

const caches = new WeakMap<Services, RdapCache>();

function cacheOf(services: Services): RdapCache {
  let c = caches.get(services);
  if (!c) {
    c = { bootstrap: null, domains: new Map(), warming: null };
    caches.set(services, c);
  }
  return c;
}

function normalizeDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((d) => d.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean))];
}

async function withBudget<T>(
  budgetMs: number,
  work: (budget: number) => Promise<T>,
  fallback: T,
): Promise<T> {
  if (budgetMs <= 0) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(budgetMs),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), budgetMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getBootstrap(
  cache: RdapCache,
  nowMs: number,
  fetchJson: RdapFetch,
): Promise<Map<string, string> | null> {
  if (cache.bootstrap && cache.bootstrap.until > nowMs) return cache.bootstrap.value;
  const res = await fetchJson(IANA_RDAP_BOOTSTRAP_URL);
  if (!res.ok || !res.json) {
    cache.bootstrap = { value: null, until: nowMs + BOOTSTRAP_ERR_MS };
    return null;
  }
  const map = parseRdapBootstrap(res.json);
  if (map.size === 0) {
    cache.bootstrap = { value: null, until: nowMs + BOOTSTRAP_ERR_MS };
    return null;
  }
  cache.bootstrap = { value: map, until: nowMs + BOOTSTRAP_OK_MS };
  return map;
}

async function readOneDomain(
  cache: RdapCache,
  domain: string,
  bootstrap: ReadonlyMap<string, string>,
  nowMs: number,
  fetchJson: RdapFetch,
): Promise<{ ok: true; expires: Date | null } | { ok: false }> {
  const cached = cache.domains.get(domain);
  if (cached && cached.until > nowMs) return cached.value;
  const url = rdapUrlForDomain(domain, bootstrap);
  if (!url) {
    const val = { ok: true as const, expires: null };
    cache.domains.set(domain, { value: val, until: nowMs + DOMAIN_OK_MS });
    return val;
  }
  const res = await fetchJson(url);
  if (!res.ok) {
    const val = { ok: false as const };
    cache.domains.set(domain, { value: val, until: nowMs + DOMAIN_ERR_MS });
    return val;
  }
  const expires = res.json ? parseRdapExpiration(res.json) : null;
  const val = { ok: true as const, expires };
  cache.domains.set(domain, { value: val, until: nowMs + DOMAIN_OK_MS });
  return val;
}

/**
 * Reads already-cached RDAP expiration dates without making any network calls, so a page read never
 * blocks on or fails because of external RDAP registries. `missing` is true when a background refresh
 * should populate uncached entries.
 */
export function cachedDomainExpirations(
  services: Services,
  domains: readonly string[],
  now: Date,
): { expirations: Map<string, Date | null> | null; partial: boolean; missing: boolean } {
  const unique = normalizeDomains(domains);
  if (unique.length === 0) return { expirations: new Map(), partial: false, missing: false };
  const cache = cacheOf(services);
  const nowMs = now.getTime();
  if (!cache.bootstrap || cache.bootstrap.until <= nowMs)
    return { expirations: null, partial: false, missing: true };
  if (cache.bootstrap.value === null) return { expirations: null, partial: false, missing: false };
  const expirations = new Map<string, Date | null>();
  let partial = false;
  let missing = false;
  for (const domain of unique) {
    const cached = cache.domains.get(domain);
    if (!cached || cached.until <= nowMs) {
      missing = true;
      partial = true;
      continue;
    }
    if (cached.value.ok) expirations.set(domain, cached.value.expires);
    else partial = true;
  }
  if (expirations.size === 0 && partial) return { expirations: null, partial: true, missing };
  return { expirations, partial, missing };
}

/**
 * Looks up public RDAP registration expiration dates for a list of domain names under one overall
 * deadline covering IANA bootstrap, redirects and domain queries.
 * Returns null if the IANA bootstrap could not be fetched or every domain lookup failed;
 * otherwise returns the map of lowercase domain → expiration date (or null when unavailable)
 * and whether any domain lookup failed transiently (`partial`).
 */
export async function readDomainExpirations(
  services: Services,
  domains: readonly string[],
  now: Date,
  fetchJson: RdapFetch = defaultRdapFetch,
  deadlineMs = RDAP_DEADLINE_MS,
): Promise<{ expirations: Map<string, Date | null>; partial: boolean } | null> {
  const unique = normalizeDomains(domains);
  if (unique.length === 0) return { expirations: new Map(), partial: false };
  const cache = cacheOf(services);
  const nowMs = now.getTime();
  const endAt = Date.now() + Math.max(0, deadlineMs);
  const boundedFetch: RdapFetch = (url) => {
    const remaining = endAt - Date.now();
    if (remaining <= 0) return Promise.resolve({ ok: false, status: 0 });
    return withBudget(remaining, (budget) => fetchJson(url, budget).catch(() => ({ ok: false, status: 0 })), {
      ok: false,
      status: 0,
    });
  };
  const bootstrap = await getBootstrap(cache, nowMs, boundedFetch);
  if (!bootstrap) return null;
  const results = await Promise.all(
    unique.map(async (domain) => ({
      domain,
      res: await readOneDomain(cache, domain, bootstrap, nowMs, boundedFetch),
    })),
  );
  if (!results.some((r) => r.res.ok)) return null;
  const expirations = new Map<string, Date | null>();
  let partial = false;
  for (const { domain, res } of results) {
    if (res.ok) expirations.set(domain, res.expires);
    else partial = true;
  }
  return { expirations, partial };
}

/**
 * Starts a detached RDAP cache refresh when none is already running for this server instance,
 * swallowing all failures so callers (such as page reads) are never slowed down or broken by RDAP.
 */
export function warmDomainExpirations(
  services: Services,
  domains: readonly string[],
  now: Date,
  fetchJson: RdapFetch = defaultRdapFetch,
  deadlineMs = RDAP_DEADLINE_MS,
): void {
  const cache = cacheOf(services);
  if (cache.warming) return;
  const task = readDomainExpirations(services, domains, now, fetchJson, deadlineMs)
    .catch(() => null)
    .then(() => undefined)
    .finally(() => {
      if (cache.warming === task) cache.warming = null;
    });
  cache.warming = task;
}
