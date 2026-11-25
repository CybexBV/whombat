/**
 * Looks ahead's setting (Whombat looks-ahead.md; `looksAhead.get`, `looksAhead.update`, `looksAhead.checkNow`): read
 * it, change one thing at a time, or trigger an immediate fresh check. A change shows at once and the Whombat's answer
 * replaces it; one that didn't go through puts the view back and reads it again.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type LooksAheadCheckNowResult,
  type LooksAheadUpdate,
  type LooksAheadView,
} from '@whombat/core';
import type { CommitResult } from '../http/types';
import { withLooksAheadChange } from '../looksAhead';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

/** Looks ahead as the Whombat has it. */
export const useLooksAhead = queryHook(api.looksAhead.get);

/** Change Looks ahead: its switch, incoming mail, one calendar, one kind of finding, or a standing rule. */
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

/** Run one immediate Looks ahead check right now (`looksAhead.checkNow`). */
export function useCheckLooksAheadNow(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const key = queryKeys.endpoint(api.looksAhead.get, { params: { burrow } });
  return useMutation<CommitResult<LooksAheadCheckNowResult>, Error, void>({
    mutationFn: () => client.request(api.looksAhead.checkNow, { params: { burrow }, body: {} }),
    onSuccess: (result) => {
      if (result.status === 'ok') qc.setQueryData(key, result.data.view);
    },
  });
}
