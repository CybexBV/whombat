import { SETTLE_UNDO_MS, settleFinishedToast, settleRefusalText, wentThrough } from '@whombat/client';
import { useSettleFinished, useSettleThread } from '@whombat/client/react';
import type { ChatRoom } from '@whombat/core';
import { useCallback } from 'react';
import { useToast } from '../../components/Toast';
import { SETTLE_WORDS } from '../../i18n/shared';

/**
 * Settling a thread of Chat or Feedback, and opening it again (Whombat chat-settle.md CHS-01, CHS-05; app chat-settle.md
 * AP-6150, AP-6151): no question, the room and the threads lists change at once, and “Thread settled.” offers Undo for
 * five seconds. A refusal (“Neo is still working on this.”) puts things back and says so in a toast.
 */
export function useSettle(burrow: string) {
  const toast = useToast();
  const { mutate, mutateAsync } = useSettleThread(burrow, { onRefused: (text) => toast.show(text) });
  const settle = useCallback(
    (room: ChatRoom, rootId: string) => {
      // Said at once, as the room changes at once; a refusal takes it back and says why instead.
      const id = toast.show(SETTLE_WORDS.settledToast, {
        duration: SETTLE_UNDO_MS,
        action: { label: SETTLE_WORDS.undo, onAction: () => mutate({ room, rootId, settled: false }) },
      });
      mutateAsync({ room, rootId, settled: true })
        .then((result) => result.status !== 'ok' && toast.dismiss(id))
        .catch((error: unknown) => !wentThrough(error) && toast.dismiss(id));
    },
    [mutate, mutateAsync, toast],
  );
  const openAgain = useCallback(
    (room: ChatRoom, rootId: string) => mutate({ room, rootId, settled: false }),
    [mutate],
  );
  return { settle, openAgain };
}

/**
 * Settle finished threads (CHS-09; AP-6155), from the sidebar's right-click menu of Chat and Feedback: no question, the
 * toast says how many.
 */
export function useSettleFinishedThreads(burrow: string) {
  const toast = useToast();
  const { mutate } = useSettleFinished(burrow);
  return useCallback(
    (room: ChatRoom) =>
      mutate(room, {
        onSuccess: (result) =>
          toast.show(
            result.status === 'ok'
              ? settleFinishedToast(result.data.settled)
              : settleRefusalText(result, true),
          ),
        onError: (error) => toast.show(settleRefusalText(error, true)),
      }),
    [mutate, toast],
  );
}
