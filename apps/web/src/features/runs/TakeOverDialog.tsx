import { WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceOf } from '@whombat/client';
import type { AgentFace } from '@whombat/core';
import { Button } from '../../components/Button';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import styles from './TakeOverDialog.module.css';

export interface TakeOverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: { name: string; face?: AgentFace | null };
  branch: string;
  onConfirm: () => void;
}

/**
 * Confirm before taking over a run. Not in the mock: built in the approval modal's language (560px,
 * 64px avatar, mono kicker, 23px question, sf2 explainer, Cancel / primary action).
 */
export function TakeOverDialog({ open, onOpenChange, agent, branch, onConfirm }: TakeOverDialogProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} width="md">
      <div className={styles.head}>
        <WhombatAvatar face={agentFaceOf(agent)} size={64} />
        <div className={styles.heading}>
          <SectionLabel tone="mut">TAKE OVER</SectionLabel>
          <ModalTitle className={styles.title}>Take over {agent.name}’s run?</ModalTitle>
        </div>
      </div>
      <ModalDescription className={styles.explainer}>
        {agent.name} stops now and hands you <span className={styles.branch}>{branch}</span>. The steps and
        log so far stay on this page, and {agent.name} won’t push to the branch again.
      </ModalDescription>
      <div className={styles.actions}>
        <ModalClose asChild>
          <Button variant="secondary" size="xl">
            Cancel
          </Button>
        </ModalClose>
        <Button variant="primary" size="xl" padX={20} onClick={onConfirm}>
          Take over
        </Button>
      </div>
    </Modal>
  );
}
