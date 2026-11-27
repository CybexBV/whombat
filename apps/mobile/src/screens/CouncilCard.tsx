/**
 * The council card in a Chat row (Whombat docs/decisions/council.md): the card
 * (`ui/councilCard.tsx`) with what makes it act. Its members' times tick on the app clock while they work. Stop asks
 * first, then stops every member and its tasks; Council settings opens Settings → the assistant → Council; the rest
 * of a long answer opens its T3 Code thread. A Whombat from before the council answers `unknown_op`: a short note says
 * it needs an update. The card itself follows by `message.updated`.
 */
import { useQueryClient } from '@tanstack/react-query';
import { type CommitResult, councilMemberView, councilWords } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import { api } from '@whombat/core';
import { useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { type CouncilItem, councilActionProblem, councilNextTick } from '../data/council';
import type { FileAccess } from '../data/fileAccess';
import type { MessageFileActions } from '../data/useFiles';
import { useI18n } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { CouncilCardPanel } from '../ui/councilCard';
import { haptic } from '../ui/haptics';
import { outcomeText, showFailure, showHeldBack } from './feedback';

/** The app clock while a member works: the next time a shown time changes, then again. */
function useCouncilClock(item: CouncilItem, clock: () => number): number {
  const [, setTick] = useState(0);
  const nowMs = clock();
  const wait = item.ticking ? councilNextTick(item.card, nowMs) : null;
  useEffect(() => {
    if (wait === null) return;
    const timer = setTimeout(() => setTick((t) => t + 1), wait);
    return () => clearTimeout(timer);
  });
  return nowMs;
}

export function CouncilCard({
  item,
  clock,
  access,
  files,
  openUrl,
}: {
  item: CouncilItem;
  /** The app clock (ms). */
  clock: () => number;
  access: FileAccess | null;
  files: MessageFileActions | null;
  openUrl: (url: string) => void;
}) {
  const { rawLocale } = useI18n();
  const councilWordsHere = councilWords(rawLocale);
  const { slug, timeZone } = useBurrowBase();
  const navigation = useAppNavigation();
  const qc = useQueryClient();
  const nowMs = useCouncilClock(item, clock);
  const members = useMemo(
    () =>
      item.ticking ? item.card.members.map((m) => councilMemberView(m, nowMs, rawLocale)) : item.view.members,
    [item, nowMs, rawLocale],
  );
  const done = (result: CommitResult<unknown>) => {
    const text = outcomeText(result, rawLocale);
    if (text) return showHeldBack(text);
    haptic('success');
    // The card follows by `message.updated`; read the thread again in case that was missed.
    for (const id of ['messages.list', 'messages.thread'])
      void qc.invalidateQueries({ queryKey: queryKeys.scope(id, { burrow: slug }) });
  };
  const failed = (error: unknown) => showFailure(councilActionProblem(error, rawLocale), rawLocale);
  const stop = useApiMutation(api.councils.stop, { onSuccess: done, onError: failed });
  const input = { params: { burrow: slug }, body: { councilId: item.councilId } };
  const ask = councilWordsHere.stopAsk;
  return (
    <CouncilCardPanel
      item={item}
      members={members}
      access={access}
      files={files}
      timeZone={timeZone}
      actions={{
        busy: stop.isPending ? 'stop' : null,
        openUrl,
        changeCouncil: () => navigation.navigate('SettingsAgent', { part: 'council' }),
        stop: () =>
          Alert.alert(ask.title, ask.body, [
            { text: ask.keep, style: 'cancel' },
            { text: councilWordsHere.stop, style: 'destructive', onPress: () => stop.mutate(input) },
          ]),
      }}
    />
  );
}
