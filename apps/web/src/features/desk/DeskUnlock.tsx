/**
 * The desk screen's unlock request (Whombat desk-display.md DK-04; desk-display-web.md AP-3008, AP-3009): someone at the
 * screen pressed “Confirm on your phone”, so for 2 minutes the paired person sees “Your desk screen wants to unlock.”
 * with **Unlock** and **No** — as a line above every screen (the shell's notice slot, as the passkey notices), and as a
 * NEEDS YOU row on This Whombat's Overview, where the line steps aside. It goes when answered here or elsewhere
 * (`desk.changed`) or when its time is up. What the answer did is a toast. The row is `DeskSection.tsx`'s.
 */
import { type DeskUnlockRequest, deskUnlockAnswerText } from '@whombat/client/desk';
import { useDeskActions } from '@whombat/client/desk/react';
import { useState } from 'react';
import shell from '../../app/shell/ShellLayout.module.css';
import { cx } from '../../components/cx';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { DESK_TEXT } from '../../i18n/clientWords';
import { currentLocale } from '../../i18n/provider';
import { type DeskHere, useDeskUnlockHere } from './useDeskHere';

const U = DESK_TEXT.unlock;

/** Unlock or No, and a toast with what it did. */
export function useDeskUnlockAnswer(here: DeskHere, request: DeskUnlockRequest | null) {
  const actions = useDeskActions(here.api);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const answer = async (unlock: boolean) => {
    if (!request) return;
    setBusy(true);
    try {
      await actions.answerUnlock({ id: request.id, unlock });
      toast.show(deskUnlockAnswerText(unlock, undefined, currentLocale()));
    } catch (error) {
      toast.show(deskUnlockAnswerText(unlock, error, currentLocale()));
    } finally {
      setBusy(false);
    }
  };
  return { busy, answer };
}

/** The line above the screen; `hidden` where This Whombat's Overview shows the row instead. */
export function DeskUnlockNotice({ burrow, hidden }: { burrow: string; hidden: boolean }) {
  const { here, request } = useDeskUnlockHere(burrow);
  const { busy, answer } = useDeskUnlockAnswer(here, request);
  if (!request || hidden) return null;
  return (
    <div className={shell.notice} role="status" data-testid="desk-unlock-notice">
      <StatusDot tone="warn" size={7} label={null} />
      <span className={shell.noticeText}>{U.notice}</span>
      <button
        type="button"
        className={cx(shell.noticeButton, shell.noticeLink)}
        disabled={busy}
        onClick={() => void answer(true)}
      >
        {U.unlock}
      </button>
      <button
        type="button"
        className={cx(shell.noticeButton, shell.noticeQuiet)}
        disabled={busy}
        onClick={() => void answer(false)}
      >
        {U.no}
      </button>
    </div>
  );
}
