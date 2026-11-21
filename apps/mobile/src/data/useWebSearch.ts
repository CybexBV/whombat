/**
 * Web search's writes (Whombat web-search.md): turn it on with a Brave Search key (`burrows.setWebSearch`), check the
 * saved key again (`burrows.testWebSearch`), turn it off (`burrows.clearWebSearch`). Each answer goes into the
 * bootstrap's and `burrows.get`'s burrow at once, so the card changes without waiting for the server's
 * `burrow.updated`.
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CallInput, CommitResult, ResponseData } from '@whombat/client';
import { patchEndpoint } from '@whombat/client/query';
import { useWhombat } from '@whombat/client/react';
import { type AnyEndpoint, api, type Burrow } from '@whombat/core';

function patchBurrow(qc: QueryClient, slug: string, change: (b: Burrow) => Burrow): void {
  const patch = (d: { burrow: Burrow }) => (d.burrow ? { ...d, burrow: change(d.burrow) } : d);
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

/** The burrow as the answer has it, where it is the same burrow. */
function applyBurrow(qc: QueryClient, slug: string, next: Burrow): void {
  patchBurrow(qc, slug, (b) => (b.id === next.id ? { ...b, ...next } : b));
}

export function useSetWebSearch(slug: string) {
  return useWrite(api.burrows.setWebSearch, (qc, data) => applyBurrow(qc, slug, data.burrow));
}

export function useClearWebSearch(slug: string) {
  return useWrite(api.burrows.clearWebSearch, (qc, data) => applyBurrow(qc, slug, data.burrow));
}

/** Check again: the result is kept as the burrow's `webSearch.check`. */
export function useTestWebSearch(slug: string) {
  return useWrite(api.burrows.testWebSearch, (qc, data) =>
    patchBurrow(qc, slug, (b) =>
      b.webSearch ? { ...b, webSearch: { ...b.webSearch, check: data.check } } : b,
    ),
  );
}
