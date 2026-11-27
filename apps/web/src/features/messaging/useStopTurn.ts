/**
 * “Stop” on an agent's turn (docs/decisions/web-messages.md WX-10; contracts 0.55 CT-295, Whombat RF-01): on the
 * “is thinking” line, in the profile pane's RIGHT NOW and on the Inbox's NEEDS YOU rows (`stop_turn`). `dispatches.cancel`; the
 * runtime clears the thinking line and the runner stops at its next beat. Who may is `canStopTurn` here and the server's
 * rule there (a run's turn answers “Pause the run instead.”).
 */
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, problemText } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { invalidateWork, queryKeys, type TypingEntry } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import { api, canStopTurn, type Principal, shortNameOf, TURN_STOP_RUN_REFUSAL } from '@whombat/core';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { currentLocale } from '../../i18n/provider';

/** What a stop that went through says. */
export function stoppedToast(name: string): string {
  return `Stopped ${name}.`;
}

/** What a stop that didn't happen says: the server's words when it gave some. */
export function stopFailureText(error: unknown, name: string): string {
  const licence = licenceRefusalText(error, currentLocale());
  if (licence) return licence;
  if (error instanceof ApiError) {
    if (error.status === 409) return error.message || TURN_STOP_RUN_REFUSAL;
    if (error.status === 403) return `You can’t stop ${name} here.`;
    if (error.status === 404 || error.status === 501) return 'That isn’t available here yet.';
    return problemText(error, undefined, currentLocale());
  }
  return 'Couldn’t reach Whombat. Nothing changed, try again.';
}

/**
 * Whether the viewer gets Stop on an agent's live turn that isn't a run's (the thinking line, RIGHT NOW): core's rule
 * says so.
 */
export function useCanStop(): (agent: Principal | undefined, viewer: Principal | undefined) => boolean {
  return (agent, viewer) =>
    !!agent &&
    !!viewer &&
    canStopTurn({ state: 'running', runId: null }, { id: viewer.id, kind: viewer.kind });
}

export interface StopTurn {
  /** Stops `dispatchId`, the turn of `agent`; `where`: the conversation whose thinking line goes at once. */
  stop: (
    dispatchId: string,
    agent: Principal | undefined,
    where?: { conversationId: string },
  ) => Promise<boolean>;
  /** The turn being stopped, until the answer. */
  pending: string | null;
}

export function useStopTurn(burrow: string): StopTurn {
  const cancel = useApiMutation(api.dispatches.cancel);
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);

  const stop: StopTurn['stop'] = async (dispatchId, agent, where) => {
    const name = agent ? shortNameOf(agent) : 'the agent';
    setPending(dispatchId);
    try {
      const result = await cancel.mutateAsync({ params: { burrow, dispatchId } });
      if (result.status !== 'ok') {
        toast.show(result.status === 'blocked' ? result.message : 'That needs a person to approve it first.');
        return false;
      }
      // The line goes now; the runtime's `typing` (inactive) says the same a moment later.
      if (where)
        qc.setQueryData<TypingEntry[]>(queryKeys.typing(where.conversationId), (old) =>
          old?.filter((e) => e.dispatchId !== dispatchId),
        );
      toast.show(stoppedToast(name));
      return true;
    } catch (error) {
      toast.show(stopFailureText(error, name));
      return false;
    } finally {
      setPending(null);
      invalidateWork(qc);
    }
  };

  return { stop, pending };
}
