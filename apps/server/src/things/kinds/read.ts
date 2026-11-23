/**
 * What every kind's reader shares (connection-pages.md CP-04; connection-pages-server.md CP-S07): a GET as the
 * connection (`signedConnectionFetch`: its policy, its credential, a refresh after a refused OAuth token), a 30-second
 * cache per connection and credential with the last reading kept for pages (`latestRead`, page-speed.md PS-01), a
 * 15-second deadline for a whole read, and failures in plain words (`ReadProblem`), never the other side's.
 *
 * **Live parts** (service-dashboards.md SD-09, SD-S05): a page that shows something moving (what plays, the download
 * queue) asks again every 5 seconds (`KindView.refreshS`). Its kind splits its read in two: the slow part (libraries,
 * history, health) with `latestRead`/`cachedRead` under `<kind>:<id>` (30 s), and only the live part with `liveRead`
 * under its own key (`<kind>-live:<id>`), kept `LIVE_CACHE_MS` (4 s, or the module's `liveS`) and waited for at most
 * `LIVE_WAIT_MS` before the last one shows. So a page open every 5 seconds asks the service for its queue, not for
 * everything; a page nobody opens isn't read live at all (the health pass reads the slow part every 5 minutes).
 */

import { externalEffect } from '../../commit/scope';
import { signedConnectionFetch } from '../../connections/http';
import type { CatalogConnectionRow } from '../../connections/types';
import { ConnectionAuthError } from '../../connections/types';
import type { Services } from '../../services';
import { VaultCallError } from '../../vault/net';

/** How long a kind's read is kept per connection. */
export const KIND_CACHE_MS = 30_000;
/** A whole read's deadline. */
export const KIND_DEADLINE_MS = 15_000;
/** The largest answer a reader takes (Home Assistant's 171 integrations, UniFi's 200 devices). */
export const KIND_MAX_BYTES = 4 * 1024 * 1024;

/** Why a read gave nothing, in words for the page's `problem` line. */
export class ReadProblem extends Error {
  override name = 'ReadProblem';
  constructor(
    message: string,
    /** The connection's credential was refused: it needs connecting again. */
    readonly refused = false,
    /** The HTTP status of an answer that was an error, when there was one. */
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

/** A failure as a `ReadProblem` about `name` (“Home Assistant”). */
export function problemOf(err: unknown, name: string): ReadProblem {
  if (err instanceof ReadProblem) return err;
  if (err instanceof ConnectionAuthError) return new ReadProblem(`${name} needs you to sign in again.`, true);
  if (err instanceof VaultCallError) {
    if (err.reason === 'timeout') return new ReadProblem(`${name} didn’t answer in time.`);
    if (err.reason === 'not_allowed')
      return new ReadProblem(`Whombat may not call ${name}’s address any more.`);
    if (err.reason === 'too_large') return new ReadProblem(`${name} answered with more than Whombat reads.`);
  }
  return new ReadProblem(`Whombat couldn’t reach ${name} just now.`);
}

/** The answer's JSON of a GET as the connection; a refusal or an error status is a `ReadProblem`. */
export async function getJson(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  path: string,
  query: Record<string, string> = {},
): Promise<unknown> {
  const search = new URLSearchParams(query).toString();
  const url = `${row.baseUrl.replace(/\/+$/, '')}${path}${search ? `?${search}` : ''}`;
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          { method: 'GET', url, headers: { Accept: 'application/json' } },
          { maxBytes: KIND_MAX_BYTES, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, name);
  }
  if (res.status === 401 || res.status === 403)
    throw new ReadProblem(`${name} refused Whombat’s sign-in.`, res.status === 401, res.status);
  if (res.status >= 400) throw new ReadProblem(`${name} answered with an error.`, false, res.status);
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new ReadProblem(`${name} answered with something Whombat can’t read.`);
  }
}

/** Runs `work` with a deadline; past it, the read is a `ReadProblem`. */
export async function withDeadline<T>(work: Promise<T>, ms: number, problem: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadProblem(problem)), ms);
    timer.unref?.();
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a page shows a kind's last reading while it reads again (page-speed.md PS-01): past the health pass's 5 minutes. */
export const KIND_KEEP_MS = 15 * 60_000;
/** How long a page waits for a fresh reading before it shows the last one (PS-01). */
export const PAGE_WAIT_MS = 1_000;

/** How a read ended, and when it was started. */
type Outcome = { at: number; ok: true; value: unknown } | { at: number; ok: false; error: unknown };

/** What a read is kept by: the connection's credential and settings (a new one reads again), and its id. */
export type ReadRow = Pick<CatalogConnectionRow, 'credentialVersion' | 'updatedAt'> & { id?: string };

interface Cached {
  version: string;
  /** The connection read (`forgetConnectionReads`). */
  connectionId: string | null;
  /** The read under way, shared by everyone who asks meanwhile. */
  reading: Promise<unknown> | null;
  /** The last read's outcome. */
  last: Outcome | null;
  /** How long its last outcome is worth keeping: a read kept an hour isn't dropped after the usual 15 minutes. */
  keepMs: number;
}

const caches = new WeakMap<Services, Map<string, Cached>>();

/** The cache entry of `key`, a new one when the credential changed; drops entries nobody can use any more. */
function entryOf(services: Services, key: string, row: ReadRow, now: number, keepMs = KIND_KEEP_MS): Cached {
  let cache = caches.get(services);
  if (!cache) {
    cache = new Map();
    caches.set(services, cache);
  }
  for (const [k, v] of cache) if (!v.reading && (!v.last || now - v.last.at > v.keepMs)) cache.delete(k);
  const version = `${row.credentialVersion}:${row.updatedAt.getTime()}`;
  let entry = cache.get(key);
  if (entry?.version !== version) {
    entry = { version, connectionId: row.id ?? null, reading: null, last: null, keepMs: KIND_KEEP_MS };
    cache.set(key, entry);
  }
  entry.keepMs = Math.max(entry.keepMs, keepMs);
  return entry;
}

/**
 * Forgets every kept read of a connection (its whole read and its live part): after a button changed something there,
 * the page the client reads right after shows the new state, not the one from before (service-dashboards.md SD-S10).
 */
export function forgetConnectionReads(services: Services, connectionId: string): void {
  const cache = caches.get(services);
  if (!cache) return;
  for (const [k, v] of cache) if (v.connectionId === connectionId) cache.delete(k);
}

/** The read under way, or a new one; its outcome becomes the entry's last. */
function readNow<T>(entry: Cached, load: () => Promise<T>, now: number): Promise<T> {
  if (entry.reading) return entry.reading as Promise<T>;
  const reading = load();
  entry.reading = reading;
  reading.then(
    (value) => {
      entry.last = { at: now, ok: true, value };
      entry.reading = null;
    },
    (error: unknown) => {
      entry.last = { at: now, ok: false, error };
      entry.reading = null;
    },
  );
  return reading;
}

/**
 * A kind's read of one connection, kept `KIND_CACHE_MS` (a page and Home's health pass share it); a new credential reads
 * again, and a failure isn't kept: the next caller reads again and waits for it (the health pass wants it fresh).
 */
export function cachedRead<T>(
  services: Services,
  key: string,
  row: ReadRow,
  load: () => Promise<T>,
  ttlMs = KIND_CACHE_MS,
): Promise<T> {
  const now = Date.now();
  const entry = entryOf(services, key, row, now, ttlMs);
  if (entry.last?.ok && now - entry.last.at <= ttlMs) return Promise.resolve(entry.last.value as T);
  return readNow(entry, load, now);
}

/** What a page shows of a kind's read: the reading, or why there is none, and whether a newer one is on its way. */
export type Latest<T> = ({ ok: true; value: T; at: Date } | { ok: false; error: unknown; at: Date }) & {
  /** A read is still under way: the page asks again soon (PS-02). */
  refreshing: boolean;
};

function latestOf<T>(o: Outcome, refreshing: boolean): Latest<T> {
  return o.ok
    ? { ok: true, value: o.value as T, at: new Date(o.at), refreshing }
    : { ok: false, error: o.error, at: new Date(o.at), refreshing };
}

/**
 * A kind's read for a page (PS-01): the last outcome while it is younger than `ttlMs` (a failure too, so a service that
 * doesn't answer doesn't hold every page for its deadline); otherwise a new read, waited for up to `waitMs` and else
 * the last outcome of the past `KIND_KEEP_MS` with `refreshing`. Only a connection read for the first time waits for
 * the read itself. Shares its cache with `cachedRead`, so the health pass keeps every page's reading warm.
 */
export async function latestRead<T>(
  services: Services,
  key: string,
  row: ReadRow,
  load: () => Promise<T>,
  { ttlMs = KIND_CACHE_MS, waitMs = PAGE_WAIT_MS }: { ttlMs?: number; waitMs?: number } = {},
): Promise<Latest<T>> {
  const now = Date.now();
  const entry = entryOf(services, key, row, now);
  const last = entry.last && now - entry.last.at <= KIND_KEEP_MS ? entry.last : null;
  if (last && now - last.at <= ttlMs) return latestOf(last, false);
  const reading = readNow(entry, load, now);
  // The entry's last is the new outcome by the time this runs (`readNow` listens first).
  const settled = reading.then(
    () => entry.last as Outcome,
    () => entry.last as Outcome,
  );
  if (!last) return latestOf(await settled, false);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
    timer.unref?.();
  });
  try {
    const fresh = await Promise.race([settled, late]);
    return fresh ? latestOf(fresh, false) : latestOf(last, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Tests: forget every cached read. */
export function forgetKindReads(services: Services): void {
  caches.delete(services);
}

/** How long a kind's live part is kept (SD-S05): under the 5 seconds a live page asks again in. */
export const LIVE_CACHE_MS = 4_000;
/** How long a live page waits for a fresh live part before it shows the last one. */
export const LIVE_WAIT_MS = 1_500;

/**
 * A kind's live part for a page (SD-S05): `latestRead` kept `liveS` seconds (default `LIVE_CACHE_MS`) under `key`, which
 * names the live part only (`sabnzbd-live:<id>`), never the kind's whole read.
 */
export function liveRead<T>(
  services: Services,
  key: string,
  row: ReadRow,
  load: () => Promise<T>,
  { liveS, waitMs = LIVE_WAIT_MS }: { liveS?: number | undefined; waitMs?: number } = {},
): Promise<Latest<T>> {
  return latestRead(services, key, row, load, {
    ttlMs: liveS !== undefined ? Math.max(1_000, liveS * 1000) : LIVE_CACHE_MS,
    waitMs,
  });
}
