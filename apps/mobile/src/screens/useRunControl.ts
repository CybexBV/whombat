/**
 * Pause, Resume, Take over and Try again on a run from the phone (AP-711): the web's `useRunControl` — the same
 * requests (`runs.pause`, `runs.resume`, `runs.takeOver`, `runs.retry`), one at a time, the run in the answer put in
 * the cache at once, a short note after (`runActionToast`), a refusal's own sentence, and after an error the run read
 * again. Asking first (Take over) is the caller's, from `RunControlButton.confirm`.
 */
import { useQueryClient } from '@tanstack/react-query';
import { type RunControlAction, runActionToast } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import type { Run, RunDetail } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { Alert } from 'react-native';
import { runControlRefusal } from '../data/run';
import { errorText, showNotice } from './feedback';

export interface RunControl {
  /** The control in flight: every control waits until the server answers. */
  pending: RunControlAction | null;
  act: (action: RunControlAction, run: Pick<Run, 'number' | 'branch'>, agentName: string) => void;
}

export function useRunControl(burrow: string): RunControl {
  const qc = useQueryClient();
  const pause = useApiMutation(api.runs.pause);
  const resume = useApiMutation(api.runs.resume);
  const takeOver = useApiMutation(api.runs.takeOver);
  const retry = useApiMutation(api.runs.retry);
  const [pending, setPending] = useState<RunControlAction | null>(null);

  const act: RunControl['act'] = (action, run, agentName) => {
    const params = { burrow, number: run.number };
    const key = queryKeys.runs.get({ params });
    setPending(action);
    const settle = {
      onSuccess: (result: Parameters<typeof runControlRefusal>[0] & { data?: { run?: Run } }) => {
        const refused = runControlRefusal(result);
        if (refused) {
          Alert.alert('That didn’t go through', refused);
          return;
        }
        const next = result.status === 'ok' ? result.data?.run : undefined;
        if (next) qc.setQueryData<RunDetail>(key, (d) => (d ? { ...d, run: next } : d));
        showNotice(runActionToast(action, agentName, run.branch));
      },
      onError: (error: unknown) => {
        Alert.alert('That didn’t go through', errorText(error));
        void qc.invalidateQueries({ queryKey: key });
      },
      onSettled: () => setPending(null),
    };
    switch (action) {
      case 'pause':
        pause.mutate({ params }, settle);
        return;
      case 'resume':
        resume.mutate({ params }, settle);
        return;
      case 'take_over':
        takeOver.mutate({ params }, settle);
        return;
      case 'retry':
        retry.mutate({ params }, settle);
        return;
    }
  };

  return { pending, act };
}
