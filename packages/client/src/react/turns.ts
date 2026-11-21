/**
 * “Try again” on a failed turn (Whombat essentials item 4; contracts CT-167): `dispatches.retry`, then the card and the
 * Work item say “Tried again” at once (`applyTurnRetry`) and the work overview is read again. A second press anywhere
 * answers with the retry already queued (the runtime's get-or-create).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@whombat/core/contracts';
import type { CommitResult, ResponseData } from '../http/types';
import { invalidateWork } from '../query/supervision';
import { applyTurnRetry } from '../query/turns';
import { useWhombat } from './context';

export type RetryTurnResult = CommitResult<ResponseData<typeof api.dispatches.retry>>;

export function useRetryTurn(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<RetryTurnResult, Error, { dispatchId: string }>({
    mutationFn: ({ dispatchId }) => client.request(api.dispatches.retry, { params: { burrow, dispatchId } }),
    onSuccess: (result, { dispatchId }) => {
      if (result.status === 'ok') applyTurnRetry(qc, dispatchId, result.data.dispatchId);
      invalidateWork(qc);
    },
  });
}
