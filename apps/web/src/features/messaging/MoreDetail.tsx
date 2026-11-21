import { useRequestMore } from '@whombat/client/react';
import { useToast } from '../../components/Toast';
import styles from './QuickReplies.module.css';

export interface MoreDetailProps {
  burrow: string;
  /** The agent's short reply that offered more (`Message.more`). */
  messageId: string;
}

/**
 * “More detail” under an agent's short reply (docs/decisions/concise-replies.md): a quick reply's chip that asks
 * the agent for what it left out. It goes once someone asked; the agent's “is thinking” takes over.
 */
export function MoreDetail({ burrow, messageId }: MoreDetailProps) {
  const toast = useToast();
  const failed = () => toast.show('Couldn’t ask for more detail. Try again.');
  const ask = useRequestMore(burrow, {
    onSuccess: (result) => {
      if (result.status !== 'ok') failed();
    },
    onError: failed,
  });
  return (
    <div className={styles.replies}>
      <button
        type="button"
        className={styles.reply}
        disabled={ask.isPending}
        onClick={() => ask.mutate({ messageId })}
      >
        More detail
      </button>
    </div>
  );
}
