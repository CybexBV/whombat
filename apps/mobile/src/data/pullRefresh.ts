/**
 * How long a pull to refresh spins: until the reads it asked for have answered or failed, or as soon as one of them
 * waits to get online (TanStack pauses a read while the phone is offline, and its promise then stays open until it
 * is). The read itself goes on: it continues once the phone is online, and the list's “Updating…” line says it is
 * waiting meanwhile, so the spinner doesn't spin for ever over a list that can't be read now.
 */
import type { QueryClient, QueryFilters } from '@tanstack/query-core';

export function pullSettled(
  qc: Pick<QueryClient, 'getQueryCache'>,
  reads: readonly Promise<unknown>[],
  watched: readonly QueryFilters[],
): Promise<void> {
  const cache = qc.getQueryCache();
  const waiting = () =>
    watched.some((filters) => cache.findAll(filters).some((q) => q.state.fetchStatus === 'paused'));
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
