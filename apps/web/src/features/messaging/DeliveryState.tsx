/**
 * A message's delivery on a managed Whombat (MA-09, AP-14): under a message you just sent, quietly, what is
 * known about it — “Sending…” while it is on its way (after a second, so fast sends show nothing), and when its
 * answer was lost, “Not confirmed yet” with Check again (asks the Whombat; it is never sent twice by default).
 * If the Whombat never got it, Send again resends the same request (same id: it can't be applied twice). When a check
 * finds it still working on it, “Received · working on it” keeps Check again (AP-579), so it never gets stuck.
 */

import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@whombat/client/query';
import { sendRequestId, useWhombat } from '@whombat/client/react';
import {
  type CommandTracker,
  canCheck,
  commandStatusText,
  type TrackedCommand,
} from '@whombat/client/session';
import type { Message } from '@whombat/core';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '../../components/Button';
import styles from './MessageList.module.css';

export const DELIVERY_TEXT = {
  checkAgain: 'Check again',
  sendAgain: 'Send again',
} as const;

function useCommand(tracker: CommandTracker | null, requestId: string): TrackedCommand | undefined {
  return useSyncExternalStore(
    (l) => (tracker ? tracker.subscribe(l) : () => {}),
    () => tracker?.get(requestId),
    () => undefined,
  );
}

export function DeliveryState({ message, onResend }: { message: Message; onResend: (m: Message) => void }) {
  const { commands } = useWhombat();
  const qc = useQueryClient();
  const requestId = sendRequestId(message.clientId ?? '');
  const command = useCommand(commands, requestId);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 1000);
    return () => clearTimeout(t);
  }, []);
  if (!commands || !command || !message.clientId) return null;
  const text = commandStatusText(command.phase);
  if (!text || command.phase === 'completed' || (!shown && command.phase === 'pending_delivery')) return null;
  const check = async () => {
    const phase = await commands.check(requestId);
    if (phase === 'completed') {
      // It was applied: the list shows the stored message.
      void qc.invalidateQueries({
        queryKey: queryKeys.scope('messages.list', { conversationId: message.conversationId }),
      });
    }
  };
  return (
    <div className={styles.delivery} role="status">
      <span>{text}</span>
      {canCheck(command) && (
        <Button variant="link" size="xs" disabled={command.checking} onClick={() => void check()}>
          {DELIVERY_TEXT.checkAgain}
        </Button>
      )}
      {command.phase === 'not_delivered' && (
        <Button variant="link" size="xs" onClick={() => onResend(message)}>
          {DELIVERY_TEXT.sendAgain}
        </Button>
      )}
    </div>
  );
}
