/**
 * The delegation card in a Chat row (Whombat docs/decisions/delegate.md): the card (`ui/delegationCard.tsx`) with what
 * makes it act. A tick shows at once and goes back if the Whombat refused it; Hand over sends the ticked tasks to T3
 * Code; Change something puts the cursor in this thread's reply box; Not now stops the checklist without asking; Stop,
 * for all of them or one task (from its ⋯), asks first, since it stops work on the person's computer. The working
 * tasks' times tick on the app clock. A task's AI chip, and Hand over's arrow for every task, open the AI menu
 * (`DelegationAiSheet.tsx`), which asks T3 Code what it runs as it opens; the choice shows at once and goes back if the
 * Whombat refused it. The card itself follows by `message.updated`.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  type CommitResult,
  type DelegationTaskView,
  delegationAiChoice,
  delegationAiOf,
  delegationAiWords,
  delegationCardView,
  delegationWords,
  sameDelegationAi,
} from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { queryHook, useApiMutation } from '@whombat/client/react';
import { api, type DelegationAi, type DelegationAiBody, type DelegationPickBody } from '@whombat/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import {
  type DelegationAiHolds,
  type DelegationItem,
  type DelegationPicks,
  delegationActionProblem,
  delegationAfter,
  delegationAiHeading,
  delegationNextTick,
  EVERY_TASK,
  NO_AI_HOLDS,
  NO_PICKS,
  pendingPicks,
  withAiHolds,
  withPicks,
} from '../data/delegation';
import type { FileAccess } from '../data/fileAccess';
import type { MessageFileActions } from '../data/useFiles';
import { useI18n } from '../i18n';
import { DelegationCardPanel } from '../ui/delegationCard';
import { haptic } from '../ui/haptics';
import { DelegationAiSheet } from './DelegationAiSheet';
import { outcomeText, showFailure, showHeldBack } from './feedback';

/** `delegations.models`: what T3 Code runs now, asked for when the AI menu opens. */
const useDelegationModels = queryHook(api.delegations.models);

/** The app clock while a task works: the next time a shown time changes, then again. */
function useDelegationClock(item: DelegationItem, clock: () => number): number {
  const [, setTick] = useState(0);
  const nowMs = clock();
  const wait = item.ticking ? delegationNextTick(item.card, nowMs) : null;
  useEffect(() => {
    if (wait === null) return;
    const timer = setTimeout(() => setTick((t) => t + 1), wait);
    return () => clearTimeout(timer);
  });
  return nowMs;
}

export function DelegationCard({
  item,
  clock,
  access,
  files,
  onChange,
  openUrl,
}: {
  item: DelegationItem;
  /** The app clock (ms). */
  clock: () => number;
  /** For its tasks' pictures and the image viewer they open. */
  access: FileAccess | null;
  files: MessageFileActions | null;
  /** Change something: the cursor in this thread's reply box. */
  onChange: () => void;
  openUrl: (url: string) => void;
}) {
  const { rawLocale } = useI18n();
  const delegationWordsHere = delegationWords(rawLocale);
  const delegationAiWordsHere = delegationAiWords(rawLocale);
  const { slug, timeZone } = useBurrowBase();
  const qc = useQueryClient();
  const nowMs = useDelegationClock(item, clock);
  const [picks, setPicks] = useState<DelegationPicks>(NO_PICKS);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(NONE);
  // The ticks the server has sent back (or a checklist that is gone) no longer need holding.
  const held = pendingPicks(item.card, picks);
  useEffect(() => {
    if (held !== picks) setPicks(held);
  }, [held, picks]);
  // The AIs chosen that the server hasn't sent back yet, by task id (EVERY_TASK: every task's).
  const [aiHolds, setAiHolds] = useState<DelegationAiHolds>(NO_AI_HOLDS);
  // The AI menu: for which task (EVERY_TASK: every task), whether it shows, and how many times it opened.
  const [aiMenu, setAiMenu] = useState({ target: EVERY_TASK, open: false, opening: 0 });
  const card = useMemo(() => withAiHolds(withPicks(item.card, held), aiHolds), [item.card, held, aiHolds]);
  const view = useMemo(
    () =>
      item.ticking || held.size || aiHolds.size
        ? delegationCardView(card, nowMs, item.lead, rawLocale)
        : item.view,
    [item, card, held, aiHolds, nowMs, rawLocale],
  );
  const after = useMemo(() => delegationAfter(item.card, rawLocale), [item.card, rawLocale]);

  const refresh = () =>
    // The card follows by `message.updated`; read the thread again in case that was missed.
    Promise.all(
      ['messages.list', 'messages.thread'].map((id) =>
        qc.invalidateQueries({ queryKey: queryKeys.scope(id, { burrow: slug }) }),
      ),
    );
  /** A press that went through, or was held back (a key, a person's OK). */
  const settled = (result: CommitResult<unknown>): boolean => {
    const text = outcomeText(result, rawLocale);
    if (text) {
      showHeldBack(text);
      return false;
    }
    refresh();
    return true;
  };
  const unpick = (body: DelegationPickBody) =>
    setPicks((now) => {
      if (now.get(body.taskId) !== body.picked) return now;
      const next = new Map(now);
      next.delete(body.taskId);
      return next;
    });
  const pick = useApiMutation(api.delegations.pick, {
    onSuccess: (result, input) => {
      if (!settled(result)) unpick(input.body);
    },
    onError: (error, input) => {
      unpick(input.body);
      showFailure(delegationActionProblem(error, delegationWordsHere.failed.pick, rawLocale), rawLocale);
    },
  });
  const start = useApiMutation(api.delegations.start, {
    onSuccess: (result) => {
      if (settled(result)) haptic('success');
    },
    onError: (error) =>
      showFailure(delegationActionProblem(error, delegationWordsHere.failed.start, rawLocale), rawLocale),
  });
  const stop = useApiMutation(api.delegations.stop, {
    onSuccess: (result) => {
      if (settled(result)) haptic('success');
    },
    onError: (error) =>
      showFailure(delegationActionProblem(error, delegationWordsHere.failed.stop, rawLocale), rawLocale),
  });
  const done = (taskId: string) =>
    setStopping((now) => {
      const next = new Set(now);
      next.delete(taskId);
      return next;
    });
  const stopTask = useApiMutation(api.delegations.stopTask, {
    onSuccess: (result, input) => {
      done(input.body.taskId);
      if (settled(result)) haptic('success');
    },
    onError: (error, input) => {
      done(input.body.taskId);
      showFailure(delegationActionProblem(error, delegationWordsHere.failed.stop, rawLocale), rawLocale);
    },
  });

  /** A held AI is let go once the server answered and the thread was read again, or at once when it was refused. */
  const unhold = (target: string, ai: DelegationAi | null) =>
    setAiHolds((now) => {
      if (!now.has(target) || now.get(target) !== ai) return now;
      const next = new Map(now);
      next.delete(target);
      return next;
    });
  // Each request's held AI, so an answer lets go of its own choice and not a newer one made since.
  const sentAi = useRef(new WeakMap<DelegationAiBody, DelegationAi | null>());
  const unholdFor = (body: DelegationAiBody) => {
    const ai = sentAi.current.get(body);
    if (ai !== undefined) unhold(body.taskId ?? EVERY_TASK, ai);
  };
  const setAi = useApiMutation(api.delegations.setAi, {
    onSuccess: (result, input) => {
      const text = outcomeText(result, rawLocale);
      if (text) {
        showHeldBack(text);
        unholdFor(input.body);
        return;
      }
      void refresh().finally(() => unholdFor(input.body));
    },
    onError: (error, input) => {
      unholdFor(input.body);
      showFailure(delegationActionProblem(error, delegationAiWordsHere.failed, rawLocale), rawLocale);
    },
  });

  const params = { burrow: slug };
  const delegationId = item.card.delegationId;
  const models = useDelegationModels({ params }, { enabled: aiMenu.open, retry: false });
  const heading = delegationAiHeading(view, aiMenu.target, rawLocale);
  const currentAi =
    (aiMenu.target === EVERY_TASK ? card.ai : card.tasks.find((t) => t.id === aiMenu.target)?.ai) ?? null;
  const closeAi = () => setAiMenu((m) => ({ ...m, open: false }));
  const all = delegationWordsHere.stopAsk;
  const one = delegationWordsHere.stopTaskAsk;
  return (
    <>
      <DelegationCardPanel
        card={card}
        timeZone={timeZone}
        view={view}
        after={after}
        pictures={item.pictures}
        access={access}
        files={files}
        actions={{
          busy: start.isPending ? 'start' : stop.isPending ? 'stop' : null,
          stopping,
          pick: (taskId, picked) => {
            setPicks((now) => new Map(now).set(taskId, picked));
            pick.mutate({
              params,
              body: { delegationId, taskId: taskId as DelegationPickBody['taskId'], picked },
            });
          },
          handOver: () => start.mutate({ params, body: { delegationId } }),
          chooseAi: (taskId) =>
            setAiMenu((m) => ({ target: taskId ?? EVERY_TASK, open: true, opening: m.opening + 1 })),
          change: onChange,
          notNow: () => stop.mutate({ params, body: { delegationId } }),
          stop: () =>
            Alert.alert(all.title, all.body, [
              { text: all.keep, style: 'cancel' },
              {
                text: delegationWordsHere.stop,
                style: 'destructive',
                onPress: () => stop.mutate({ params, body: { delegationId } }),
              },
            ]),
          stopTask: (task: DelegationTaskView) =>
            Alert.alert(one.title, one.body, [
              { text: one.keep, style: 'cancel' },
              {
                text: delegationWordsHere.stop,
                style: 'destructive',
                onPress: () => {
                  setStopping((now) => new Set(now).add(task.id));
                  stopTask.mutate({
                    params,
                    body: { delegationId, taskId: task.id as DelegationPickBody['taskId'] },
                  });
                },
              },
            ]),
          openUrl,
        }}
      />
      <DelegationAiSheet
        visible={aiMenu.open}
        opening={aiMenu.opening}
        title={heading.title}
        subtitle={heading.subtitle}
        first={heading.first}
        current={currentAi}
        models={models.data}
        error={models.error}
        onClose={closeAi}
        onDone={(draft, options) => {
          closeAi();
          const ai = delegationAiOf(options, draft);
          const choice = delegationAiChoice(draft, options);
          if (sameDelegationAi(ai, currentAi) && !!choice === !!currentAi) return;
          const target = aiMenu.target;
          const body: DelegationAiBody = {
            delegationId,
            ...(target === EVERY_TASK ? null : { taskId: target as DelegationPickBody['taskId'] }),
            ai: choice,
          };
          sentAi.current.set(body, ai);
          setAiHolds((now) => new Map(now).set(target, ai));
          setAi.mutate({ params, body });
        }}
      />
    </>
  );
}

const NONE: ReadonlySet<string> = new Set();
