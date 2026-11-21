import type { CommitResult } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { usePlanWrite, useTheAgent } from '@whombat/client/react';
import { PLAN_MAX_STEPS, type Plan } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { type FormEvent, useId, useState } from 'react';
import { Button, IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import styles from './CreatePlanModal.module.css';
import { planErrorText, planTitleFrom } from './planModel';

export interface CreatePlanSource {
  messageId: string;
  /** The message's text: the title starts as its first line. */
  text: string;
}

export interface CreatePlanModalProps {
  burrow: string;
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** “Make a plan” on a message: the plan remembers it and its card goes into the message's thread. */
  source?: CreatePlanSource | null;
  /** After the plan is made (the caller opens the plan pane). */
  onCreated: (plan: Plan) => void;
}

interface DraftStep {
  key: number;
  title: string;
}

/**
 * “Make a plan” (work-supervision WS-01, WS-09): a title (from the message), its steps, an optional due date and “Also
 * create a plan canvas”. The steps are the agent's (Whombat one-agent.md OA-14; app one-agent.md AP-4952): nobody is
 * picked for one. Making a plan starts nothing; the plan pane opens on it.
 */
export function CreatePlanModal(props: CreatePlanModalProps) {
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} width="md">
      {props.open && <CreatePlanForm {...props} />}
    </Modal>
  );
}

function CreatePlanForm({ burrow, conversationId, onOpenChange, source, onCreated }: CreatePlanModalProps) {
  const ids = useId();
  const toast = useToast();
  const viewer = useBurrowViewer(burrow);
  // The contract still names a step's owner: the agent's (OA-14).
  const { agent } = useTheAgent(burrow);
  const ownerId = agent?.id ?? viewer.me?.id ?? '';
  const [title, setTitle] = useState(() => (source ? planTitleFrom(source.text) : ''));
  const [due, setDue] = useState('');
  const [canvas, setCanvas] = useState(false);
  const [nextKey, setNextKey] = useState(2);
  const [steps, setSteps] = useState<DraftStep[]>([{ key: 1, title: '' }]);
  const [error, setError] = useState<string | null>(null);
  const create = usePlanWrite(api.plans.create);

  const filled = steps.filter((s) => s.title.trim());
  const setStep = (key: number, patch: Partial<DraftStep>) =>
    setSteps((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const t = title.trim();
    if (!t) return setError('Give the plan a title.');
    setError(null);
    let result: CommitResult<{ plan: Plan }>;
    try {
      result = await create.mutateAsync({
        params: { burrow },
        body: {
          conversationId,
          title: t,
          due: due || null,
          steps: filled.map((s) => ({ title: s.title.trim(), ownerId })),
          canvas,
          ...(source ? { sourceMessageId: source.messageId } : {}),
        },
      });
    } catch (err) {
      setError(licenceRefusalText(err) ?? planErrorText(err));
      return;
    }
    if (result.status !== 'ok') {
      setError(result.status === 'blocked' ? result.message : 'That needs a person to approve first.');
      return;
    }
    toast.show(source ? 'Plan made. Its card is in the thread.' : 'Plan made.');
    onOpenChange(false);
    onCreated(result.data.plan);
  };

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      <div className={styles.heading}>
        <SectionLabel tone="mut">NEW PLAN</SectionLabel>
        <ModalTitle className={styles.title}>Make a plan</ModalTitle>
        <ModalDescription className={styles.description}>
          A shared checklist in this conversation. Nothing starts until someone starts a step.
        </ModalDescription>
      </div>

      <div className={styles.field}>
        <SectionLabel as="label" htmlFor={`${ids}-title`}>
          TITLE
        </SectionLabel>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={160}
          invalid={error === 'Give the plan a title.'}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <fieldset className={styles.fieldset}>
        <SectionLabel as="legend">STEPS</SectionLabel>
        <ol className={styles.steps}>
          {steps.map((s, i) => (
            <li key={s.key} className={styles.stepRow}>
              <span className={styles.stepNumber} aria-hidden="true">
                {i + 1}
              </span>
              <input
                className={styles.stepInput}
                value={s.title}
                maxLength={160}
                placeholder={i === 0 ? 'What needs doing first?' : 'Next step'}
                aria-label={`Step ${i + 1}`}
                onChange={(e) => setStep(s.key, { title: e.target.value })}
              />
              <IconButton
                label={`Remove step ${i + 1}`}
                className={styles.remove}
                disabled={steps.length === 1}
                onClick={() => setSteps((list) => list.filter((x) => x.key !== s.key))}
              >
                <Icon name="close" size={14} />
              </IconButton>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.addStep}
          disabled={steps.length >= PLAN_MAX_STEPS}
          onClick={() => {
            setSteps((list) => [...list, { key: nextKey, title: '' }]);
            setNextKey((k) => k + 1);
          }}
        >
          + Add a step
        </Button>
      </fieldset>

      <div className={styles.row}>
        <div className={styles.field}>
          <SectionLabel as="label" htmlFor={`${ids}-due`}>
            DUE (OPTIONAL)
          </SectionLabel>
          <input
            id={`${ids}-due`}
            type="date"
            className={styles.dateInput}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
        <div className={styles.toggle}>
          <Toggle id={`${ids}-canvas`} checked={canvas} onCheckedChange={setCanvas} />
          <label htmlFor={`${ids}-canvas`}>Also create a plan canvas</label>
        </div>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <ModalClose asChild>
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </ModalClose>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Making…' : 'Make plan'}
        </Button>
      </div>
    </form>
  );
}
