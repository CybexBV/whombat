/**
 * What Home's buttons do (one-whombat.md ONE-05, ONE-08, ONE-10, ONE-24; app one-whombat-shell.md AP-1266, AP-1269): the
 * Inbox's intents (`needsYouIntent`) carried out — approve, approve later, decline, snooze, open, look into it, the
 * 1Password guard's answer (onepassword-sync.md) —, the
 * step the assistant offers on a look it looked into (look-research-web.md AP-5903), and Undo on a change.
 * Each says what happened in a short toast, as a person would.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  atText,
  lookFixOutcomeText,
  type NeedsYouIntent,
  ONEPASSWORD_APP_TEXT,
  onePasswordAnsweredText,
  onePasswordSetChanged,
  startedChatPath,
  threadToOpen,
  undoOutcome,
  withNeedsYouListItem,
} from '@whombat/client';
import { patchEndpoint, queryKeys } from '@whombat/client/query';
import {
  useDecideApproval,
  useFixLook,
  useOnePasswordWrite,
  useSnoozeNeedsYou,
  useStartChat,
  useTheAgent,
  useUndoChange,
} from '@whombat/client/react';
import type { ChangeEntry, HomeOverview, HomeRef, LookResearch } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { formatClock } from '@whombat/core/text';
import { useCallback, useState } from 'react';
import { useNavigateHref, useSearchUpdate } from '../../app/routing/navigation';
import { useToast } from '../../components/Toast';
import { useWebI18n } from '../../i18n/provider';
import { markIfUnknown } from '../approvals/unknownAnswer';

const SOMETHING_WENT_WRONG = 'That didn’t work. Try again in a moment.';

/** Carry out a Needs you intent; `busy` is the item being acted on. */
export function useNeedsYouActions(burrow: string, timeZone: string) {
  const { tag: uiLocale } = useWebI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const navigateHref = useNavigateHref();
  const decide = useDecideApproval(burrow);
  const snooze = useSnoozeNeedsYou(burrow);
  const start = useStartChat(burrow);
  const answerRemovals = useOnePasswordWrite(api.connections.onePasswordRemovals, burrow);
  const [busy, setBusy] = useState<string | null>(null);
  // The card says “I’m on it.” at once and its thread opens, where the step is taken (backup-places.md BPL-15); a
  // toast only when the step didn't go through.
  const { mutate: fixLook } = useFixLook(burrow, (outcome, thread) => {
    setBusy(null);
    const text = lookFixOutcomeText(outcome);
    if (text) toast.show(text);
    const open = threadToOpen(thread);
    if (open) navigateHref(open);
  });

  // A decision takes the item out of the list at once; the server's answer then takes over.
  const leave = useCallback(
    (ref: HomeRef) =>
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => withNeedsYouListItem(d, ref, 'gone')),
    [qc],
  );

  const run = useCallback(
    async (itemId: string, ref: HomeRef, intent: NeedsYouIntent) => {
      if (intent.type === 'none') return;
      if (intent.type === 'open') {
        navigateHref(intent.href);
        return;
      }
      setBusy(itemId);
      try {
        // An answer that may have gone through says so on the approval instead of a failure (command-safety.md).
        if (intent.type === 'approve' || intent.type === 'approveLater' || intent.type === 'decline') {
          const answered = await decide
            .mutateAsync({
              number: intent.number,
              decision: intent.type === 'decline' ? 'decline' : 'approve',
              ...(intent.type === 'approveLater' ? { executeAt: intent.executeAt } : {}),
            })
            .catch((error: unknown) => {
              if (markIfUnknown(burrow, intent.number, error)) return null;
              throw error;
            });
          if (answered === null) return;
          if (answered.status !== 'ok') {
            toast.show(answered.status === 'blocked' ? 'You can’t decide this one.' : SOMETHING_WENT_WRONG);
            return;
          }
          leave(ref);
          void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
          toast.show(
            intent.type === 'approveLater'
              ? `Approved. It runs at ${formatClock(intent.executeAt, timeZone)}.`
              : intent.type === 'decline'
                ? 'Declined.'
                : 'Approved. It runs now.',
          );
          return;
        }
        switch (intent.type) {
          case 'snooze': {
            const result = await snooze.mutateAsync({ ref: intent.ref, until: intent.until });
            if (result.status !== 'ok') toast.show(SOMETHING_WENT_WRONG);
            else toast.show(`I’ll remind you ${atText(intent.until, Date.now(), timeZone, uiLocale)}.`);
            return;
          }
          case 'investigate': {
            const result = await start.mutateAsync({ text: intent.text, subject: intent.subject });
            if (result.status !== 'ok') {
              toast.show(SOMETHING_WENT_WRONG);
              return;
            }
            // Its thread in Chat, or before Chat the new task chat (chat-channel.md AP-2406).
            navigateHref(startedChatPath(result.data));
            return;
          }
          case 'onePasswordRemovals': {
            // The answer for the set the card showed; the Inbox reads again either way (the hook does).
            const result = await answerRemovals.mutateAsync({
              params: { burrow, connectionId: intent.connectionId },
              body: { answer: intent.answer, token: intent.token },
            });
            if (result.status !== 'ok') {
              toast.show(result.status === 'blocked' ? result.message : SOMETHING_WENT_WRONG);
              return;
            }
            leave(ref);
            toast.show(onePasswordAnsweredText(intent.answer));
            return;
          }
        }
      } catch (error) {
        // The set changed since the card was drawn: nothing was removed, and the card comes back with the new set.
        toast.show(onePasswordSetChanged(error) ? ONEPASSWORD_APP_TEXT.changed : SOMETHING_WENT_WRONG);
      } finally {
        setBusy(null);
      }
    },
    [burrow, decide, snooze, start, answerRemovals, navigateHref, toast, leave, qc, timeZone, uiLocale],
  );

  /**
   * The step the assistant offers (“Restart Zigbee”): the person's go-ahead for that one step (LR-08); `itemId` waits
   * until its thread opens.
   */
  const fix = useCallback(
    (research: LookResearch, itemId?: string) => {
      if (itemId) setBusy(itemId);
      fixLook(research);
    },
    [fixLook],
  );

  return { run, fix, busy };
}

/**
 * Undo a change from Everything I did or a thing's changes. A change an agent reported is put back by
 * the agent (contracts 0.91 `requested`): the toast says it was asked and the chat opens (app home-redesign.md AP-2217,
 * backup-places.md BPL-15).
 */
export function useUndo(burrow: string) {
  const toast = useToast();
  const updateSearch = useSearchUpdate();
  const navigateHref = useNavigateHref();
  const { agent: assistant } = useTheAgent(burrow);
  const undo = useUndoChange(burrow);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (change: Pick<ChangeEntry, 'id' | 'title'>) => {
      setBusy(change.id);
      try {
        const result = await undo.mutateAsync(change.id);
        if (result.status !== 'ok') {
          toast.show(result.status === 'blocked' ? 'You can’t undo this one.' : SOMETHING_WENT_WRONG);
          return;
        }
        const outcome = undoOutcome(result.data, assistant?.name);
        if (outcome.kind === 'asked') {
          const number = outcome.approvalNumber;
          toast.show(
            outcome.message,
            number
              ? {
                  action: {
                    label: 'Open',
                    onAction: () => void updateSearch((s) => ({ ...s, approval: number })),
                  },
                }
              : {},
          );
          return;
        }
        if (outcome.kind === 'requested') {
          // The assistant puts it back in its chat: that opens, where it says so (backup-places.md BPL-15).
          toast.show(outcome.message);
          if (outcome.href) navigateHref(outcome.href);
          return;
        }
        toast.show(outcome.message);
      } catch (error) {
        toast.show(error instanceof Error && error.message ? error.message : SOMETHING_WENT_WRONG);
      } finally {
        setBusy(null);
      }
    },
    [undo, toast, updateSearch, navigateHref, assistant?.name],
  );
  return { run, busy };
}
