/**
 * The rows of “Everything I did” on the phone (`screens/DoneScreen.tsx`; Whombat home-redesign HR-03, HR-05, HR-08;
 * home-redesign-mobile.md AP-2259…AP-2262; Home has no Done recently since home-simplify.md AP-2269). A row is a check,
 * what changed and when (and who, when it was a person), then Undo while it can be undone, Review where there is
 * something to look at (the chat it was made in, else the thing's page), or “Undone”. Undo's outcome is said in a
 * short note.
 */
import { type DoneRow, doneRows, undoOutcome } from '@whombat/client';
import { useUndoChange, useUndoRequests } from '@whombat/client/react';
import type { ChangeEntry } from '@whombat/core';
import { useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { doneCopy } from '../../data/done';
import { useTheAgentHere } from '../../data/useAgent';
import { useI18n } from '../../i18n';
import { openHref } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Check, Undo2 } from '../../ui/icons';
import { Touchable } from '../../ui/Touchable';
import { showNotice, useDecisionFeedback } from '../feedback';

/**
 * Undo with its outcome said in a short note (the shared `undoOutcome`: “Undone.”, “Undoing this needs an approval
 * first.”, or for a change the assistant reported, contracts 0.91 `requested`, “Asked Neo to undo this.” — its row
 * then says so, with its chat, for 10 minutes); a refusal in the server's words (“I’m already undoing this.”).
 */
export function useUndo() {
  const { rawLocale } = useI18n();
  const { slug } = useBurrowBase();
  const undo = useUndoChange(slug);
  const feedback = useDecisionFeedback();
  const assistantName = useTheAgentHere()?.name ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const run = (change: Pick<ChangeEntry, 'id'>) => {
    if (busy) return;
    setBusy(change.id);
    undo
      .mutateAsync(change.id)
      .then((result) => {
        if (result.status !== 'ok') return feedback.onResult(result);
        const outcome = undoOutcome(result.data, assistantName, rawLocale);
        showNotice(outcome.message);
        // The assistant puts it back in its chat: that opens, where it says so (backup-places.md BPL-15).
        if (outcome.kind === 'requested' && outcome.href) openHref(outcome.href);
      }, feedback.onError)
      .finally(() => setBusy(null));
  };
  return { busy, run };
}

/**
 * The rows of a list of changes as the viewer sees them now: who made a person's change (“You”), and an Undo this
 * session asked of the assistant (`useUndoRequests`), which replaces Undo with “Asked Neo to undo this”.
 */
export function useDoneRows(changes: readonly ChangeEntry[]): DoneRow[] {
  const { rawLocale } = useI18n();
  const { slug, me, timeZone } = useBurrowBase();
  const now = useNow();
  const requests = useUndoRequests(slug);
  const assistantName = useTheAgentHere()?.name ?? null;
  return useMemo(
    () => doneRows(changes, now, timeZone, { viewerId: me.id, requests, assistantName, locale: rawLocale }),
    [changes, now, timeZone, me.id, requests, assistantName, rawLocale],
  );
}

/**
 * One change: a check in `ok` (muted once undone), the title (two lines) and its detail, the time
 * (and who, for a person's change) in mono; then Undo, Review or “Undone”. The words are one element for TalkBack, the button another.
 */
export function DoneItem({
  row,
  busy,
  onUndo,
  first = false,
}: {
  row: DoneRow;
  busy: boolean;
  onUndo: () => void;
  first?: boolean;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const DONE_COPY = doneCopy(rawLocale);
  const meta = [row.when, row.by].filter(Boolean).join(' · ');
  const spoken = [row.title, row.requested?.text ?? row.detail, meta, row.undone ? DONE_COPY.undone : null]
    .filter(Boolean)
    .join('. ');
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 11,
        paddingLeft: 14,
        paddingRight: 8,
        minHeight: 52,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        style={{ width: 20, alignItems: 'center', alignSelf: 'flex-start', paddingTop: 2 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Check size={16} color={row.undone ? theme.colors.mut : theme.colors.ok} strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }} accessible accessibilityLabel={spoken}>
        <Text
          size={15}
          weight={600}
          numberOfLines={2}
          color={row.undone ? theme.colors.mut : theme.colors.ink}
        >
          {row.title}
        </Text>
        {row.requested ? (
          <Text size={13} color={theme.colors.brand} numberOfLines={1}>
            {row.requested.text}
          </Text>
        ) : row.detail ? (
          <Text size={13} color={theme.colors.mut} numberOfLines={2}>
            {row.detail}
          </Text>
        ) : null}
        <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ marginTop: 2 }}>
          {meta}
        </Text>
      </View>
      {row.action === 'undo' ? (
        <RowAction label={DONE_COPY.undo} hint={row.title} busy={busy} icon onPress={onUndo} />
      ) : row.action === 'review' && row.href ? (
        <RowAction label={DONE_COPY.review} hint={row.title} onPress={() => openHref(row.href as string)} />
      ) : row.requested?.href ? (
        <RowAction
          label={DONE_COPY.openChat}
          hint={row.requested.text}
          onPress={() => openHref(row.requested?.href as string)}
        />
      ) : row.undone ? (
        <Text size={12} mono color={theme.colors.mut} style={{ paddingRight: 6 }}>
          {DONE_COPY.undone}
        </Text>
      ) : null}
    </View>
  );
}

/** A row's Undo or Review: `brand` words (with Undo's arrow), 44dp tall, read with the change it acts on. */
function RowAction({
  label,
  hint,
  busy = false,
  icon = false,
  onPress,
}: {
  label: string;
  hint: string;
  busy?: boolean;
  icon?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={busy}
      feedback="fade"
      ringRadius={10}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${hint}`}
      accessibilityState={{ busy }}
      style={{
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 6,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.brand} />
      ) : (
        <>
          {icon ? <Undo2 size={15} color={theme.colors.brand} strokeWidth={2} /> : null}
          <Text size={13.5} weight={600} color={theme.colors.brand}>
            {label}
          </Text>
        </>
      )}
    </Touchable>
  );
}
