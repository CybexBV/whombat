import { phaseForError, startedChatPath } from '@whombat/client';
import { useStartChat, useTheAgent } from '@whombat/client/react';
import { APPROVAL_CARD_WORDS } from '@whombat/core/approvals';
import { useCallback, useSyncExternalStore } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { useToast } from '../../components/Toast';

/*
 * Answers that may have gone through (command-safety.md): the connection dropped after the answer left, so the
 * Whombat may have acted on it. Every place that shows the approval — its card, its Details, its Inbox row — shows
 * “Your answer may have gone through” instead of the answers until the approval says what happened, so nobody sends it
 * twice. Kept for this page's life only.
 */
const unknown = new Set<string>();
const listeners = new Set<() => void>();
const keyOf = (burrow: string, number: number) => `${burrow}:${number}`;
const changed = () => {
  for (const l of [...listeners]) l();
};

/** Remember an answer whose outcome is unknown; true when it was one (the caller then says nothing else). */
export function markIfUnknown(burrow: string, number: number, error: unknown): boolean {
  if (phaseForError(error) !== 'unknown') return false;
  unknown.add(keyOf(burrow, number));
  changed();
  return true;
}

/** Forget it (the approval was read again and says where it is). */
export function forgetUnknown(burrow: string, number: number): void {
  if (unknown.delete(keyOf(burrow, number))) changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether the answer to this approval may have gone through. */
export function useUnknownAnswer(burrow: string, number: number | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => number != null && unknown.has(keyOf(burrow, number)),
    () => false,
  );
}

/**
 * *Ask {assistant} to check*: a new thread where the person asks whether their answer went through — never a resend.
 * Returns the button's words and what it does.
 */
export function useAskToCheck(burrow: string, title: string, onStarted?: () => void) {
  const { words } = useTheAgent(burrow);
  const start = useStartChat(burrow);
  const navigateHref = useNavigateHref();
  const toast = useToast();
  const onCheck = useCallback(() => {
    void start.mutateAsync({ text: APPROVAL_CARD_WORDS.checkText(title) }).then(
      (result) => {
        if (result.status !== 'ok') return toast.show('That didn’t work. Try again in a moment.');
        onStarted?.();
        navigateHref(startedChatPath(result.data));
      },
      () => toast.show('That didn’t work. Try again in a moment.'),
    );
  }, [start, title, toast, navigateHref, onStarted]);
  return { checkLabel: APPROVAL_CARD_WORDS.check(words.name), onCheck };
}
