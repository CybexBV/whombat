/**
 * How long a pull to refresh spins: until the reads it asked for have answered or failed, or as soon as one of them
 * waits to get online (TanStack pauses a read while the phone is offline, and its promise then stays open until it
 * is). The read itself goes on: it continues once the phone is online, and the list's “Updating…” line says it is
 * waiting meanwhile, so the spinner doesn't spin for ever over a list that can't be read now. Only the reads the pull
 * itself asked for count: another list of the same kind left waiting (a settled list, a server's threads) says
 * nothing about this one.
 */
import type { QueryClient, QueryKey } from '@tanstack/query-core';

/**
 * The reads a pull asks for, by query hash: each `exact` key's query, and the queries on screen under each `active`
 * key (what `invalidateQueries` refetches). Taken before the pull starts them.
 */
export function pullTargets(
  qc: Pick<QueryClient, 'getQueryCache'>,
  keys: { exact?: readonly (QueryKey | null)[]; active?: readonly QueryKey[] },
): string[] {
  const cache = qc.getQueryCache();
  const hashes = new Set<string>();
  for (const queryKey of keys.exact ?? []) {
    const q = queryKey ? cache.find({ queryKey, exact: true }) : undefined;
    if (q) hashes.add(q.queryHash);
  }
  for (const queryKey of keys.active ?? [])
    for (const q of cache.findAll({ queryKey, type: 'active' })) hashes.add(q.queryHash);
  return [...hashes];
}

export function pullSettled(
  qc: Pick<QueryClient, 'getQueryCache'>,
  reads: readonly Promise<unknown>[],
  watched: readonly string[],
): Promise<void> {
  const cache = qc.getQueryCache();
  const waiting = () => watched.some((hash) => cache.get(hash)?.state.fetchStatus === 'paused');
  return new Promise<void>((resolve) => {
    let done = false;
    let off = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      off();
      resolve();
    };
    off = cache.subscribe(() => {
      if (waiting()) finish();
    });
    void Promise.allSettled(reads).then(finish);
    if (waiting()) finish();
  });
}
