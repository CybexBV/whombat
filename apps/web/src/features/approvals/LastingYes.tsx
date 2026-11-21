import type { ApprovalLastingWords } from '@whombat/core/approvals';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import styles from './LastingYes.module.css';

/**
 * The lasting yes (“Don’t ask again for pve-02…”): apart from the answers under a line, and only after a confirmation,
 * so a quick tap never gives a standing permission. Confirmed, it is the same decision the card's old button made.
 */
export function LastingYes({
  words,
  busy,
  onConfirm,
  className,
}: {
  words: ApprovalLastingWords;
  busy: boolean;
  onConfirm: () => void;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <div className={cx(styles.lasting, className)}>
      <Button
        variant="link"
        className={styles.lastingLink}
        disabled={busy}
        aria-haspopup="dialog"
        onClick={() => setAsking(true)}
        data-always-allow=""
      >
        {words.link}
      </Button>
      <Modal open={asking} onOpenChange={setAsking} padded={false} className={styles.confirm}>
        <ModalTitle className={styles.confirmTitle}>{words.title}</ModalTitle>
        <ModalDescription className={styles.confirmBody}>{words.body}</ModalDescription>
        <div className={styles.confirmActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="md">
              {words.keep}
            </Button>
          </ModalClose>
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => {
              setAsking(false);
              onConfirm();
            }}
          >
            {words.confirm}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
