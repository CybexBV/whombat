/**
 * Looks ahead's setting (Whombat looks-ahead.md; `looksAhead.get`, `looksAhead.update`): read it, and change one thing
 * at a time. A change shows at once and the Whombat's answer replaces it; one that didn't go through puts the view back
 * and reads it again.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type LooksAheadUpdate, type LooksAheadView } from '@whombat/core';
import type { CommitResult } from '../http/types';
import { withLooksAheadChange } from '../looksAhead';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

/** Looks ahead as the Whombat has it. */
export const useLooksAhead = queryHook(api.looksAhead.get);

/** Change Looks ahead: its switch, one calendar or one kind of finding. */
export function useUpdateLooksAhead(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const key = queryKeys.endpoint(api.looksAhead.get, { params: { burrow } });
  const putBack = (before: LooksAheadView | undefined) => {
    if (before) qc.setQueryData(key, before);
    void qc.invalidateQueries({ queryKey: key });
  };
  return useMutation<
    CommitResult<LooksAheadView>,
    Error,
    LooksAheadUpdate,
    { before: LooksAheadView | undefined }
  >({
    mutationFn: (body) => client.request(api.looksAhead.update, { params: { burrow }, body }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<LooksAheadView>(key);
      if (before) qc.setQueryData(key, withLooksAheadChange(before, body));
      return { before };
    },
    onSuccess: (result, _body, context) => {
      if (result.status === 'ok') qc.setQueryData(key, result.data);
      else putBack(context?.before);
    },
    onError: (_error, _body, context) => putBack(context?.before),
  });
}
