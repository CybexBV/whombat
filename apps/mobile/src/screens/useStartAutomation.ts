/**
 * Starting an automation by hand from the phone: Run now (an automation started by hand, while it is on) or Try it (a
 * test run of the plan waiting for a yes, else the live version), on the newest issue, pull request or report when
 * something like that starts it (`automations.samples`), else once as it is. The plan card in Chat and the Automations
 * list both use it; neither needs the agent.
 */
import { useQueryClient } from '@tanstack/react-query';
import { queryHook, useApiMutation, useWhombat } from '@whombat/client/react';
import { type AutomationPlanView, type AutomationSample, api } from '@whombat/core';
import { useCallback } from 'react';
import { newestSample, runNowBody } from '../data/automationPlan';
import { useBurrowBase } from '../data/BurrowProvider';
import { errorText, outcomeText } from './feedback';

/** The issues, pull requests or reports to try an automation on, newest first. */
export const useAutomationSamples = queryHook(api.automations.samples);

/** A minute: the newest issue rarely changes while a card is on screen, and Try asks again after that. */
export const SAMPLES_STALE_MS = 60_000;

export type StartOutcome =
  | { ok: true; runNumber: number; sample: AutomationSample | null }
  /** The server's words for why it didn't start. */
  | { ok: false; text: string };

export function useStartAutomation() {
  const { slug } = useBurrowBase();
  const { queries } = useWhombat();
  const qc = useQueryClient();
  const runNow = useApiMutation(api.automations.runNow);
  const mutate = runNow.mutateAsync;
  const start = useCallback(
    async (
      automationId: string,
      how: { test: boolean; tryIt: AutomationPlanView['tryIt'] },
    ): Promise<StartOutcome> => {
      const params = { burrow: slug, id: automationId };
      let sample: AutomationSample | null = null;
      if (how.test && how.tryIt === 'sample') {
        try {
          const data = await qc.fetchQuery({
            ...queries.endpoint(api.automations.samples, { params }),
            staleTime: SAMPLES_STALE_MS,
          });
          sample = newestSample(data.samples);
        } catch {
          // Nothing to try it on: it runs once as it is.
          sample = null;
        }
      }
      try {
        const result = await mutate({ params, body: runNowBody(how.test, sample) });
        if (result.status === 'ok') return { ok: true, runNumber: result.data.run.number, sample };
        return { ok: false, text: outcomeText(result)?.body ?? errorText(null) };
      } catch (error) {
        return { ok: false, text: errorText(error) };
      }
    },
    [slug, queries, qc, mutate],
  );
  return { start, busy: runNow.isPending };
}
