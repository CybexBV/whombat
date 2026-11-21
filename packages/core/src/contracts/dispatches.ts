/**
 * Turns (dispatches) people act on directly: “Try again” on a failed turn (0.26, CT-167) and “Stop” on an agent's turn
 * (0.55, CT-295).
 */
import { z } from 'zod';
import { DispatchSummary } from '../domain/work.js';
import { DispatchId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const RetryDispatchResponse = z.object({
  /** The retry: a new dispatch (trigger `retry`), or the one an earlier press already queued. */
  dispatchId: DispatchId,
});
export type RetryDispatchResponse = z.infer<typeof RetryDispatchResponse>;

/** `dispatches.cancel`'s answer (0.55, CT-295): the turn as it is now (`cancelled`, or how it had already ended). */
export const CancelDispatchResponse = z.object({ dispatch: DispatchSummary });
export type CancelDispatchResponse = z.infer<typeof CancelDispatchResponse>;

export const dispatchEndpoints = {
  retry: endpoint({
    id: 'dispatches.retry',
    method: 'POST',
    path: '/burrows/:burrow/dispatches/:dispatchId/retry',
    summary:
      '“Try again” on a failed turn: queues the same agent, conversation, thread, trigger message and person again (trigger `retry`), once per failed turn; pressing again answers with the existing retry. People who may wake that agent there.',
    params: B.extend({ dispatchId: DispatchId }),
    response: RetryDispatchResponse,
  }),
  cancel: endpoint({
    id: 'dispatches.cancel',
    method: 'POST',
    path: '/burrows/:burrow/dispatches/:dispatchId/cancel',
    summary:
      '“Stop” on an agent’s turn (0.55, CT-295, feature `dispatches.cancel`): a queued turn is cancelled at once; a claimed or running one is cancelled and its runner stops at its next beat; the thinking line clears. The person; never agents (403). A run’s turn answers 409 “Pause the run instead.”; a turn that already ended answers with how it ended.',
    params: B.extend({ dispatchId: DispatchId }),
    response: CancelDispatchResponse,
  }),
};
