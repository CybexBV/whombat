import { useQueryClient } from '@tanstack/react-query';
import { problemText } from '@whombat/client';
import { applyRealtimeEvent } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Modal, ModalDescription, ModalTitle } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { currentLocale } from '../../i18n/provider';
import styles from './Automations.module.css';

export interface DeleteTarget {
  id: string;
  name: string;
}

/** Delete's confirmation (automation-recipes.md AP-973), from the automation's “…” and from a row's. */
export function DeleteAutomationDialog({
  burrow,
  target,
  onClose,
  onDeleted,
}: {
  burrow: string;
  /** The automation being asked about; null: closed. */
  target: DeleteTarget | null;
  onClose: () => void;
  onDeleted?: (target: DeleteTarget) => void;
}) {
  const remove = useApiMutation(api.automations.delete);
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setError(null);
    onClose();
  };

  const confirm = () => {
    if (!target) return;
    setError(null);
    remove.mutate(
      { params: { burrow, id: target.id } },
      {
        onSuccess: (res) => {
          if (res.status !== 'ok') {
            setError(res.status === 'blocked' ? res.message : 'That needs a person to approve first.');
            return;
          }
          // What the `automation.deleted` frame does, at once: out of the lists, its pages told (AP-972).
          applyRealtimeEvent(qc, { type: 'automation.deleted', automationId: target.id });
          toast.show(`“${target.name}” is deleted.`);
          close();
          onDeleted?.(target);
        },
        onError: (err) => setError(problemText(err, undefined, currentLocale())),
      },
    );
  };

  return (
    <Modal open={target !== null} onOpenChange={(open) => !open && close()}>
      <ModalTitle className={styles.confirmTitle}>Delete “{target?.name}”?</ModalTitle>
      <ModalDescription className={styles.confirmText}>
        It stops now, and runs in progress stop too. Its past runs stay in the audit log.
      </ModalDescription>
      {error && (
        <p className={`${styles.note} ${styles.noteBad}`} role="alert">
          {error}
        </p>
      )}
      <div className={styles.modalActions}>
        <Button variant="secondary" size="xl" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="xl"
          className={styles.dangerPrimary}
          disabled={remove.isPending}
          onClick={confirm}
        >
          Delete
        </Button>
      </div>
    </Modal>
  );
}
