/**
 * What the Automations page, an automation's page and a plan card do without the agent: switch it on or off, start it
 * by hand or as a test run, and open the conversation it lives in. These never need the agent, so an automation can
 * always be stopped even when the AI is signed out or out of credit.
 */
import { useQueryClient } from '@tanstack/react-query';
import { type CommitResult, talkAboutText } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, useChatRooms, useWhombat } from '@whombat/client/react';
import { type Automation, type AutomationDetail, type AutomationTalk, chatThreadHref } from '@whombat/core';
import { type AutomationSample, api } from '@whombat/core/contracts';
import { useCallback, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { useToast } from '../../components/Toast';
import { newestSample, PLAN_TOASTS, sampleBody } from '../cards/automationPlan';
import { draftKey, writeDraft } from '../messaging/drafts';
import { automationPaths } from './hooks';

/** What a refusal says: the server's words, or that a person must approve first. */
export function refusalText(res: Exclude<CommitResult<unknown>, { status: 'ok' }>): string {
  return res.status === 'blocked' ? res.message : PLAN_TOASTS.needsYes;
}

/** An error's words: the server's (an `ApiError` carries them), else that Whombat couldn't be reached. */
export function errorWords(err: unknown): string {
  return err instanceof Error && err.message ? err.message : PLAN_TOASTS.failed;
}

/** Puts an automation as the server answered it where the list and its page read it. */
export function useApplyAutomation(burrow: string) {
  const qc = useQueryClient();
  return useCallback(
    (next: AutomationDetail) => {
      qc.setQueryData(queryKeys.automations.get({ params: { burrow, id: next.automation.id } }), next);
      qc.setQueryData(
        queryKeys.automations.list({ params: { burrow } }),
        (old: { automations: Automation[] } | undefined) =>
          old && {
            ...old,
            automations: old.automations.some((x) => x.id === next.automation.id)
              ? old.automations.map((x) => (x.id === next.automation.id ? next.automation : x))
              : [next.automation, ...old.automations],
          },
      );
    },
    [qc, burrow],
  );
}

/**
 * The On/Off switch (`automations.setEnabled`): the list and the page updated from the answer, “Switched on.” or
 * “Switched off.”; a refusal says why.
 */
export function useSwitch(burrow: string): {
  busy: string | null;
  set: (a: Pick<Automation, 'id'>, enabled: boolean) => void;
} {
  const toast = useToast();
  const apply = useApplyAutomation(burrow);
  const enable = useApiMutation(api.automations.setEnabled);
  const [busy, setBusy] = useState<string | null>(null);
  const set = (a: Pick<Automation, 'id'>, enabled: boolean) => {
    setBusy(a.id);
    enable.mutate(
      { params: { burrow, id: a.id }, body: { enabled } },
      {
        onSuccess: (res) => {
          if (res.status !== 'ok') {
            toast.show(refusalText(res));
            return;
          }
          apply(res.data);
          toast.show(enabled ? 'Switched on.' : 'Switched off.');
        },
        onError: (err) => toast.show(errorWords(err)),
        onSettled: () => setBusy(null),
      },
    );
  };
  return { busy, set };
}

/**
 * Starting an automation by hand (`automations.runNow`): Run now runs the live version; Try it runs the waiting plan
 * (or the live version) once as a test, on the newest issue, pull request or report when something like that starts
 * it — the one given, else looked up now. The toast opens the run.
 */
export function useStartRun(burrow: string) {
  const { client } = useWhombat();
  const toast = useToast();
  const navigate = useNavigateHref();
  const runNow = useApiMutation(api.automations.runNow);
  const [busy, setBusy] = useState<string | null>(null);

  const started = (number: number, words: string) =>
    toast.show(words, {
      action: { label: PLAN_TOASTS.open, onAction: () => navigate(automationPaths.run(number)) },
    });

  const send = async (
    automationId: string,
    body: { test: boolean; sample?: { number: number } | { reportId: string } },
    words: string,
  ): Promise<boolean> => {
    try {
      const res = await runNow.mutateAsync({ params: { burrow, id: automationId }, body });
      if (res.status !== 'ok') {
        toast.show(refusalText(res));
        return false;
      }
      started(res.data.run.number, words);
      return true;
    } catch (err) {
      toast.show(errorWords(err));
      return false;
    }
  };

  /** A test run; `sample` undefined with `tryIt: 'sample'` looks the newest one up first. */
  const tryIt = async (
    automationId: string,
    tryIt: 'sample' | 'now',
    sample?: AutomationSample | null,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(automationId);
    try {
      let on = sample ?? null;
      if (tryIt === 'sample' && sample === undefined) {
        const res = await client
          .request(api.automations.samples, { params: { burrow, id: automationId } })
          .catch(() => null);
        on = res?.status === 'ok' ? newestSample(res.data.samples) : null;
      }
      if (tryIt === 'sample' && !on) {
        toast.show('There’s nothing to try it on yet.');
        return false;
      }
      return await send(
        automationId,
        { test: true, ...(on ? { sample: sampleBody(on) } : {}) },
        PLAN_TOASTS.tried,
      );
    } finally {
      setBusy(null);
    }
  };

  const runLive = async (automationId: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(automationId);
    try {
      return await send(automationId, { test: false }, 'Started.');
    } finally {
      setBusy(null);
    }
  };

  return { busy, tryIt, runNow: runLive };
}

/**
 * “Talk about it”: the Chat thread of the automation's latest plan; without one, Chat with “About “Name”: ” in its box,
 * so the person's next message starts that conversation.
 */
export function useTalk(burrow: string) {
  const rooms = useChatRooms(burrow);
  const navigate = useNavigateHref();
  const hrefOf = useCallback(
    (talk: AutomationTalk) =>
      chatThreadHref(rooms.feedback?.id === talk.conversationId ? 'feedback' : 'chat', talk.threadRootId),
    [rooms.feedback?.id],
  );
  const go = useCallback((talk: AutomationTalk) => navigate(hrefOf(talk)), [hrefOf, navigate]);
  const open = useCallback(
    (automation: Pick<Automation, 'name' | 'talk'>) => {
      if (automation.talk) {
        go(automation.talk);
        return;
      }
      if (rooms.chat) writeDraft(draftKey(burrow, rooms.chat.id), talkAboutText(automation.name));
      // Chat's new chat, whose box holds the draft.
      navigate('/chat?new=1');
    },
    [burrow, go, navigate, rooms.chat],
  );
  return { hrefOf, go, open };
}
