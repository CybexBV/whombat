/**
 * Pause, Resume and Remove on one of the agent's schedules, wherever it shows: Settings → Agent → Schedules and the
 * Automations list's “only tells you” rows. Remove asks first; what went through is a toast, a refusal a line in the
 * server's words.
 */
import { ApiError, scheduleText, splitConfirm } from '@whombat/client';
import { useScheduleAction } from '@whombat/client/react';
import { api, scheduleCopy } from '@whombat/core';
import { useState } from 'react';
import { Alert } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import {
  type ScheduleAction,
  type ScheduleRow,
  scheduleActionLabel,
  scheduleDoneText,
} from '../../data/schedules';
import { useI18n } from '../../i18n';
import { RowButtons } from '../../ui/facts';
import { Button } from '../../ui/primitives';
import { showNotice } from '../feedback';

export function useScheduleActions(agentName: string) {
  const { rawLocale } = useI18n();
  const scheduleTextHere = scheduleText(rawLocale);
  const { slug } = useBurrowBase();
  const pause = useScheduleAction(api.schedules.pause);
  const resume = useScheduleAction(api.schedules.resume);
  const remove = useScheduleAction(api.schedules.remove);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = pause.isPending || resume.isPending || remove.isPending;

  const act = (action: ScheduleAction, row: ScheduleRow) => {
    setProblem(null);
    const mutation = action === 'pause' ? pause : action === 'resume' ? resume : remove;
    mutation.mutate(
      { params: { burrow: slug, scheduleId: row.id } },
      {
        onSuccess: (result) => {
          if (result.status === 'ok') showNotice(scheduleDoneText(action, agentName, rawLocale));
          else setProblem(result.status === 'blocked' ? result.message : scheduleTextHere.failed);
        },
        onError: (error) =>
          setProblem(error instanceof ApiError && error.message ? error.message : scheduleTextHere.failed),
      },
    );
  };
  const press = (action: ScheduleAction, row: ScheduleRow) => {
    if (action !== 'remove') return act(action, row);
    const copy = scheduleCopy(agentName, rawLocale);
    const confirm = splitConfirm(copy.removeConfirm);
    Alert.alert(confirm.title, confirm.text, [
      { text: copy.cancel, style: 'cancel' },
      { text: copy.remove, style: 'destructive', onPress: () => act('remove', row) },
    ]);
  };
  return { press, busy, problem };
}

/** A schedule's buttons under its row: Pause or Resume, then Remove (quiet). */
export function ScheduleButtons({
  row,
  agentName,
  busy,
  onPress,
}: {
  row: ScheduleRow;
  agentName: string;
  busy: boolean;
  onPress: (action: ScheduleAction, row: ScheduleRow) => void;
}) {
  const { rawLocale } = useI18n();
  if (!row.actions.length) return null;
  return (
    <RowButtons>
      {row.actions.map((action) => (
        <Button
          key={action}
          label={scheduleActionLabel(action, agentName, rawLocale)}
          variant={action === 'remove' ? 'quiet' : 'secondary'}
          disabled={busy}
          accessibilityHint={`${scheduleActionLabel(action, agentName, rawLocale)}: ${row.what}`}
          onPress={() => onPress(action, row)}
          style={{ paddingHorizontal: 18 }}
        />
      ))}
    </RowButtons>
  );
}
