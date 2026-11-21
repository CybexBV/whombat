import { useQueryClient } from '@tanstack/react-query';
import { ApiError, type CommitResult, problemText } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, useTheAgent } from '@whombat/client/react';
import { api, type Canvas } from '@whombat/core';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import styles from './NewCanvasDialog.module.css';

/** Longest canvas title (`canvases.create`). */
export const CANVAS_TITLE_MAX = 160;

export interface NewCanvasDialogProps {
  burrow: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The new canvas (the list opens it). */
  onCreated: (canvas: Canvas) => void;
}

/**
 * “New canvas” (docs/decisions/essentials-messages.md AP-449): a title (no channel to file it under: one-agent.md
 * OA-04). `canvases.create`, then the canvas opens.
 */
export function NewCanvasDialog({ burrow, open, onOpenChange, onCreated }: NewCanvasDialogProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} width="md">
      {open && <NewCanvasForm burrow={burrow} onClose={() => onOpenChange(false)} onCreated={onCreated} />}
    </Modal>
  );
}

function NewCanvasForm({
  burrow,
  onClose,
  onCreated,
}: {
  burrow: string;
  onClose: () => void;
  onCreated: (canvas: Canvas) => void;
}) {
  const ids = useId();
  const qc = useQueryClient();
  const { words } = useTheAgent(burrow);
  const create = useApiMutation(api.canvases.create);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trimmed = title.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || create.isPending) return;
    setError(null);
    try {
      const result = await create.mutateAsync({
        params: { burrow },
        body: { title: trimmed },
      });
      if (result.status !== 'ok') return setError(outcomeText(result));
      void qc.invalidateQueries({ queryKey: queryKeys.scope('canvases.list') });
      onClose();
      onCreated(result.data.canvas);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.heading}>
        <SectionLabel tone="mut">NEW CANVAS</SectionLabel>
        <ModalTitle className={styles.title}>Start a canvas</ModalTitle>
        <ModalDescription className={styles.description}>
          A shared document people and {words.name} write in together. It opens as soon as it’s made.
        </ModalDescription>
      </div>
      <div className={styles.field}>
        <SectionLabel as="label" htmlFor={`${ids}-title`}>
          TITLE
        </SectionLabel>
        <Input
          id={`${ids}-title`}
          size="md"
          value={title}
          placeholder="Invoice PDF launch notes"
          maxLength={CANVAS_TITLE_MAX}
          autoComplete="off"
          aria-describedby={error ? `${ids}-error` : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      {error && (
        <p id={`${ids}-error`} className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <ModalClose asChild>
          <Button variant="secondary" size="xl">
            Cancel
          </Button>
        </ModalClose>
        <Button type="submit" variant="primary" size="xl" padX={20} disabled={!trimmed || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create canvas'}
        </Button>
      </div>
    </form>
  );
}

function outcomeText(result: Exclude<CommitResult<unknown>, { status: 'ok' }>): string {
  if (result.status === 'pending_approval') return 'That needs a person to approve it first. We’ve asked.';
  return `Blocked: that needs the “${result.keyNeeded.label}” key.`;
}

function errorText(err: unknown): string {
  const licence = licenceRefusalText(err);
  if (licence) return licence;
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You can’t create canvases on this Whombat.';
    return problemText(err, 'Couldn’t create that canvas. Try again.');
  }
  return 'Couldn’t create that canvas. Try again.';
}
