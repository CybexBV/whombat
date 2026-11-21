/** Helpers for reading and patching Whombat entries in a TanStack `QueryClient`. */
import {
  matchQuery,
  notifyManager,
  type Query,
  type QueryCache,
  type QueryClient,
  type QueryKey,
} from '@tanstack/query-core';
import type { Bootstrap, MeResponse, Principal } from '@whombat/core';
import { endpointScope, type ParsedKey, parseKey, QUERY_ROOT } from './keys';

const endpointIndexes = new WeakMap<QueryCache, Map<string, Set<Query>>>();

/** Keep endpoint lookups proportional to their entries, rather than every screen visited in this session. */
function endpointIndex(cache: QueryCache): Map<string, Set<Query>> {
  let index = endpointIndexes.get(cache);
  if (index) return index;
  index = new Map();
  const entries = index;
  const update = (query: Query, added: boolean) => {
    const [root, id] = query.queryKey;
    if (root !== QUERY_ROOT || typeof id !== 'string') return;
    const queries = entries.get(id);
    if (added) {
      // An earlier subscriber may have removed this query during the same notification.
      if (cache.get(query.queryHash) !== query) return;
      if (queries) queries.add(query);
      else entries.set(id, new Set([query]));
    } else if (queries) {
      queries.delete(query);
      if (!queries.size) entries.delete(id);
    }
  };
  for (const query of cache.getAll()) update(query, true);
  cache.subscribe((event) => {
    if (event.type === 'added' || event.type === 'removed') update(event.query, event.type === 'added');
  });
  endpointIndexes.set(cache, index);
  return index;
}

/**
 * Apply `fn` to the data of every cached call of an endpoint. `fn` returns the data unchanged to skip;
 * queries without data are left alone.
 */
export function patchEndpoint<T>(
  qc: QueryClient,
  endpointId: string,
  fn: (data: T, key: ParsedKey) => T,
  params?: Record<string, unknown>,
): void {
  for (const query of endpointQueries(qc, endpointId, params)) {
    const data = query.state.data as T | undefined;
    const key = parseKey(query.queryKey);
    if (data === undefined || !key) continue;
    const next = fn(data, key);
    if (next !== data) patchQueryData(qc, query, next);
  }
}

/**
 * Change what a cached read shows (a live update, a change made here) without counting it as read again.
 * `setQueryData` alone stamps the read as answered now, clears a failure and an invalidation: a list read days ago
 * that one live event touched then looked just read, and nothing asked for it again — not the read after a quiet
 * while, not the retry of a failed read, not the catch-up of a screen coming back into view. So the patch keeps
 * when the read was answered, its failure and its invalidation. A query without data gets it as before.
 */
export function patchQueryData(qc: QueryClient, query: Query, data: unknown): void {
  const { dataUpdatedAt, status, error, isInvalidated } = query.state;
  if (query.state.data === undefined) {
    qc.setQueryData(query.queryKey, data);
    return;
  }
  notifyManager.batch(() => {
    // Through `setQueryData` still: an answer on its way that is cancelled falls back to this data, not to before it.
    // It falls back to it as a success, though (query-core keeps that state privately): a failure or an invalidation
    // is lost then, and the read's old `dataUpdatedAt` is what still has it asked again on the next mount.
    qc.setQueryData(query.queryKey, data, { updatedAt: dataUpdatedAt });
    if (status !== 'success' || isInvalidated) query.setState({ status, error, isInvalidated });
  });
}

/** `patchQueryData` by key: a query no longer cached gets the data as `setQueryData` gives it. */
export function putQueryData(qc: QueryClient, queryKey: QueryKey, data: unknown): void {
  const query = qc.getQueryCache().find({ queryKey, exact: true });
  if (query) patchQueryData(qc, query, data);
  else qc.setQueryData(queryKey, data);
}

/**
 * Ask again every read on screen that is owed one and isn't being asked now: one that failed, or one marked to be read
 * again (a copy kept on the device, a change the live updates couldn't follow). For when the connection opens: those
 * would otherwise wait for their next retry, or for the person to leave and come back.
 */
export function refetchOwedReads(qc: QueryClient): Promise<void> {
  return qc
    .refetchQueries(
      {
        type: 'active',
        predicate: (q) =>
          q.state.fetchStatus === 'idle' && (q.state.status === 'error' || q.state.isInvalidated),
      },
      { cancelRefetch: false },
    )
    .catch(() => {});
}

/** Every cached query of an endpoint. */
export function endpointQueries(
  qc: QueryClient,
  endpointId: string,
  params?: Record<string, unknown>,
): Query[] {
  const queries = [...(endpointIndex(qc.getQueryCache()).get(endpointId) ?? [])];
  if (!params) return queries;
  const filters = { queryKey: endpointScope(endpointId, params) };
  return queries.filter((query) => matchQuery(filters, query));
}

/** Data of every cached call of an endpoint. */
export function cachedData<T>(qc: QueryClient, endpointId: string): { key: QueryKey; data: T }[] {
  return endpointQueries(qc, endpointId)
    .filter((q) => q.state.data !== undefined)
    .map((q) => ({ key: q.queryKey, data: q.state.data as T }));
}

/** Burrow id for a burrow slug, from whatever the cache knows (bootstrap, burrow, memberships). */
export function burrowIdForSlug(qc: QueryClient, slug: unknown): string | null {
  if (typeof slug !== 'string') return null;
  for (const { data } of cachedData<Bootstrap>(qc, 'conversations.bootstrap')) {
    if (data.burrow.slug === slug) return data.burrow.id;
  }
  for (const { data } of cachedData<{ burrow: { id: string; slug: string } }>(qc, 'burrows.get')) {
    if (data.burrow.slug === slug) return data.burrow.id;
  }
  for (const { data } of cachedData<MeResponse>(qc, 'me.get')) {
    const m = data.memberships.find((x) => x.burrowSlug === slug);
    if (m) return m.burrowId;
  }
  return null;
}

/**
 * Does a cached call (by its `:burrow` param) belong to `burrowId`? Unknown on either side counts as a
 * match: the realtime socket is per burrow, so an unresolvable slug is almost always the current one.
 */
export function sameBurrow(qc: QueryClient, key: ParsedKey, burrowId: string | null | undefined): boolean {
  if (!burrowId) return true;
  const id = burrowIdForSlug(qc, key.params.burrow);
  return id === null || id === burrowId;
}

/** Every principal the cache knows (bootstrap of any burrow). */
export function cachedPrincipals(qc: QueryClient): Map<string, Principal> {
  const out = new Map<string, Principal>();
  for (const { data } of cachedData<Bootstrap>(qc, 'conversations.bootstrap')) {
    for (const p of data.principals) out.set(p.id, p);
  }
  return out;
}

/** The signed-in principal ids (one per cached bootstrap). */
export function cachedMe(qc: QueryClient, burrowId?: string | null): string | null {
  for (const { data } of cachedData<Bootstrap>(qc, 'conversations.bootstrap')) {
    if (!burrowId || data.burrow.id === burrowId) return data.me.id;
  }
  return null;
}
