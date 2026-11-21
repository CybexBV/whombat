import { useQueryClient } from '@tanstack/react-query';
import { type CommitResult, problemText, runActionToast } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import type { Run } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import type { RunAction } from './RunView';

/** Toasts after a run control succeeds: shared with the phone (AP-711). */
export { runActionToast } from '@whombat/client';

export interface RunControl {
  /** The control in flight: its button is disabled until the server answers. */
  pending: RunAction | null;
  /** Send `action` for the run; a run in the answer goes to `onRun`. */
  act: (
    action: RunAction,
    run: Pick<Run, 'number' | 'branch'>,
    agentName: string,
    onRun?: (run: Run) => void,
  ) => void;
}

/**
 * Pause, Resume, Take over and Try again on a run (`api.runs.*`): the run page's controls (TODO 8.3, AP-596), and Try
 * again on a failed run's line or card in a conversation (AP-699), so both behave the same. A toast says how it went
 * (`runActionToast`, a refusal's own sentence, or the error's); after an error the run is fetched again.
 */
export function useRunControl(burrow: string): RunControl {
  const toast = useToast();
  const qc = useQueryClient();
  const pause = useApiMutation(api.runs.pause);
  const resume = useApiMutation(api.runs.resume);
  const takeOver = useApiMutation(api.runs.takeOver);
  const retry = useApiMutation(api.runs.retry);
  const [pending, setPending] = useState<RunAction | null>(null);

  const act: RunControl['act'] = (action, run, agentName, onRun) => {
    const params = { burrow, number: run.number };
    const mutation = { pause, resume, retry, take_over: takeOver }[action];
    setPending(action);
    mutation.mutate(
      { params },
      {
        onSuccess: (result: CommitResult<{ run: Run }>) => {
          if (result.status === 'ok') {
            onRun?.(result.data.run);
            toast.show(runActionToast(action, agentName, run.branch));
          } else if (result.status === 'blocked') {
            toast.show(result.message);
          } else {
            toast.show('That needs a person to approve first.');
          }
        },
        onError: (err) => {
          toast.show(licenceRefusalText(err) ?? problemText(err));
          void qc.invalidateQueries({ queryKey: queryKeys.runs.get({ params }) });
        },
        onSettled: () => setPending(null),
      },
    );
  };

  return { pending, act };
}
