/**
 * Web search's writes (`burrows.setWebSearch`, `burrows.testWebSearch`, `burrows.clearWebSearch`): each answer goes
 * into the bootstrap and `burrows.get` at once, so Settings shows it before the server's publish of the burrow arrives.
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CallInput, CommitResult, ResponseData } from '@whombat/client';
import { patchEndpoint } from '@whombat/client/query';
import { useWhombat } from '@whombat/client/react';
import type { Burrow } from '@whombat/core';
import { type AnyEndpoint, api } from '@whombat/core/contracts';
import type { WebSearchView } from '@whombat/core/domain';

/** The burrow's web search; null while it is off. */
export function webSearchOf(burrow: { webSearch?: WebSearchView | null } | null | undefined) {
  return burrow?.webSearch ?? null;
}

function patchBurrow(qc: QueryClient, slug: string, fn: (b: Burrow) => Burrow): void {
  const patch = (d: { burrow: Burrow }) => (d.burrow ? { ...d, burrow: fn(d.burrow) } : d);
  patchEndpoint<{ burrow: Burrow }>(qc, 'conversations.bootstrap', patch, { burrow: slug });
  patchEndpoint<{ burrow: Burrow }>(qc, 'burrows.get', patch, { burrow: slug });
}

function useWrite<E extends AnyEndpoint>(ep: E, onOk: (qc: QueryClient, data: ResponseData<E>) => void) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result) => {
      if (result.status === 'ok') onOk(qc, result.data);
    },
  });
}

export function useSetWebSearch(burrow: string) {
  return useWrite(api.burrows.setWebSearch, (qc, data) =>
    patchBurrow(qc, burrow, (b) => (b.id === data.burrow.id ? { ...b, ...data.burrow } : b)),
  );
}

export function useClearWebSearch(burrow: string) {
  return useWrite(api.burrows.clearWebSearch, (qc, data) =>
    patchBurrow(qc, burrow, (b) => (b.id === data.burrow.id ? { ...b, ...data.burrow } : b)),
  );
}

/** Check the saved key again; the result is kept in the burrow's `webSearch.check`. */
export function useTestWebSearch(burrow: string) {
  return useWrite(api.burrows.testWebSearch, (qc, data) =>
    patchBurrow(qc, burrow, (b) =>
      b.webSearch ? { ...b, webSearch: { ...b.webSearch, check: data.check } } : b,
    ),
  );
}
