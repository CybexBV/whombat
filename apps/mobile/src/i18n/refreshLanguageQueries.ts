import type { Query, QueryClient } from '@tanstack/query-core';
import { parseKey } from '@whombat/client/query';
import { api } from '@whombat/core';

const startsOver = (id: string) => /^(home|things|search|notifications)\./.test(id);

export async function refreshLanguageQueries(qc: QueryClient): Promise<void> {
  const refresh = {
    predicate(query: Query) {
      const id = parseKey(query.queryKey)?.endpointId;
      return (
        id !== undefined &&
        !startsOver(id) &&
        id !== api.me.getPreferences.id &&
        id !== api.conversations.bootstrap.id
      );
    },
  };
  // A read already on its way may still be answered in the previous language.
  await qc.cancelQueries(refresh);
  await Promise.all([
    // Start the lists over so their previous language's pages and cursors are dropped.
    qc.resetQueries({
      predicate: (query) => startsOver(parseKey(query.queryKey)?.endpointId ?? ''),
    }),
    qc.invalidateQueries(refresh),
  ]);
}
