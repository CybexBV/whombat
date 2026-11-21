import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import styles from './Conversations.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mono kicker: “ARCHIVE CHANNEL”. */
  kicker: string;
  /** The question: “Archive #billing-v2?”. */
  title: string;
  /** What happens, on the sf2 explainer. */
  children: ReactNode;
  confirmLabel: string;
  /** The button that keeps things as they are. Default “Cancel”. */
  cancelLabel?: string;
  onConfirm: () => void;
  busy?: boolean;
  /** Why it didn't go through, next to the buttons. */
  error?: string | null;
}

/**
 * Asking before a change that is hard to take back (archive a channel, leave a private one; AP-472, AP-473). Not in the
 * mock: the take-over dialog's language (560px, mono kicker, 23px question, sf2 explainer, Cancel / primary action).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  kicker,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  busy = false,
  error = null,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} width="md">
      <div className={styles.confirmHeading}>
        <SectionLabel tone="mut">{kicker}</SectionLabel>
        <ModalTitle className={styles.confirmTitle}>{title}</ModalTitle>
      </div>
      <ModalDescription className={styles.explainer}>{children}</ModalDescription>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <ModalClose asChild>
          <Button variant="secondary" size="xl">
            {cancelLabel}
          </Button>
        </ModalClose>
        <Button variant="primary" size="xl" padX={20} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
