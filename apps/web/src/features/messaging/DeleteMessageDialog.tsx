import type { Message } from '@whombat/core';
import { Button } from '../../components/Button';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import styles from './DeleteMessageDialog.module.css';
import { deleteMessageText, messageExcerpt } from './messageActions';

export interface DeleteMessageDialogProps {
  message: Message | null;
  authorName: string;
  viewerId: string | undefined;
  /** “#billing-v2”, “Banjo”: where it is removed from. */
  where: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * “Delete this message?” (AP-442), in the channel modal's language: what goes and for whom, the message's first words,
 * Cancel and Delete. The dialog stays with the reason when the server refuses.
 */
export function DeleteMessageDialog({
  message,
  authorName,
  viewerId,
  where,
  pending,
  error,
  onConfirm,
  onClose,
}: DeleteMessageDialogProps) {
  const excerpt = message ? messageExcerpt(message.text) : '';
  return (
    <Modal open={message !== null} onOpenChange={(open) => !open && !pending && onClose()} width="md">
      {message && (
        <div className={styles.form}>
          <div className={styles.heading}>
            <ModalTitle className={styles.title}>Delete this message?</ModalTitle>
            <ModalDescription className={styles.description}>
              {deleteMessageText(message, viewerId, authorName, where)}
            </ModalDescription>
          </div>
          {excerpt && (
            <blockquote className={styles.excerpt}>
              <span className={styles.excerptAuthor}>{authorName}</span>
              {excerpt}
            </blockquote>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <ModalClose asChild>
              <Button variant="secondary" size="xl" disabled={pending}>
                Cancel
              </Button>
            </ModalClose>
            <Button variant="primary" size="xl" padX={20} onClick={onConfirm} disabled={pending}>
              {pending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
