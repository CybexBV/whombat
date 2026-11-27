import {
  canSendNote,
  customerReads,
  FEATURE_CARD_TEXT,
  FEATURE_NOTE_MAX,
  type FeatureForm,
  featureRequestLabel,
  featureValueLabel,
} from '@whombat/client';
import {
  type FeatureDecisionChoice,
  type FeatureRequestView,
  featureRequestFrom,
  featureRequestOutcome,
  featureRequestWords,
  featureValueText,
} from '@whombat/core';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useLocaleWords } from '../../i18n/words';
import cardStyles from './Card.module.css';
import styles from './FeatureRequestCard.module.css';

const TONE = {
  ok: styles.ok,
  bad: styles.bad,
  mut: styles.mut,
  warn: styles.warn,
} as const;

/** What the customer would read, folded: each draft under its label, line breaks kept. */
function CustomerReads({ request }: { request: FeatureRequestView }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const reads = customerReads(request);
  if (!reads.length) return null;
  return (
    <div className={styles.fold} data-feature-fold={open ? 'open' : 'closed'}>
      <button
        type="button"
        className={styles.foldTitle}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevronDown" size={15} className={styles.chevron} />
        {FEATURE_CARD_TEXT.reads}
      </button>
      <div id={regionId} className={styles.reads} hidden={!open}>
        {reads.map((r) => (
          <div key={r.id} className={styles.read} data-feature-read={r.id}>
            <span className={styles.readLabel}>{r.label}</span>
            <blockquote className={styles.quote}>{r.text}</blockquote>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Decline's reason or Ask's question, in place of the buttons. */
function NoteForm({
  form,
  agent,
  initial,
  busy,
  onSend,
  onCancel,
}: {
  form: FeatureForm;
  agent: string;
  initial: string;
  busy: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const FEATURE_REQUEST_WORDS = useLocaleWords(featureRequestWords);
  const id = useId();
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  const decline = form === 'decline';
  // The form replaces the button just pressed: the keyboard goes to the box, after the agent's reason when there is one.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy && canSendNote(text)) onSend(text);
  };
  return (
    <form className={styles.form} onSubmit={submit} data-feature-form={form}>
      <label className={styles.formLabel} htmlFor={`${id}-note`}>
        {decline ? FEATURE_REQUEST_WORDS.declineLabel : FEATURE_REQUEST_WORDS.askLabel}
      </label>
      <textarea
        id={`${id}-note`}
        className={styles.textarea}
        value={text}
        rows={3}
        maxLength={FEATURE_NOTE_MAX}
        aria-describedby={`${id}-hint`}
        ref={area}
        onChange={(e) => setText(e.target.value)}
      />
      <span id={`${id}-hint`} className={styles.formHint}>
        {decline ? FEATURE_REQUEST_WORDS.declineHint(agent) : FEATURE_REQUEST_WORDS.askHint(agent)}
      </span>
      <div className={styles.actions}>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !canSendNote(text)}
          aria-busy={busy || undefined}
        >
          {decline ? FEATURE_REQUEST_WORDS.declineSend : FEATURE_REQUEST_WORDS.askSend}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {FEATURE_REQUEST_WORDS.cancel}
        </Button>
      </div>
    </form>
  );
}

export interface FeatureRequestCardProps {
  request: FeatureRequestView;
  /** Who decided (“John”), for the outcome once it doesn't wait; null: “you”. */
  decider: string | null;
  /** The answer being sent: every button waits, its own says so. */
  busy?: FeatureDecisionChoice | null;
  /** Why the answer didn't go, in plain words. */
  problem?: string | null;
  onDecide?: (choice: FeatureDecisionChoice, note?: string) => void;
}

/**
 * A tracker customer's feature request put to the person: the label with
 * the agent's value, the request and where it comes from, what is asked and why it is worth that much, what the
 * customer reads either way (folded), and while it waits Approve, Approve and build (when the automation builds), Decline
 * with a reason and Ask the customer, the last two as a form in place of the buttons. Once it doesn't wait, how it
 * was decided in place of the buttons.
 */
export function FeatureRequestCard({
  request,
  decider,
  busy = null,
  problem = null,
  onDecide,
}: FeatureRequestCardProps) {
  const FEATURE_REQUEST_WORDS = useLocaleWords(featureRequestWords);
  const [form, setForm] = useState<FeatureForm | null>(null);
  const openers = useRef<Partial<Record<FeatureForm, HTMLButtonElement | null>>>({});
  const waiting = request.state === 'waiting';
  const outcome = featureRequestOutcome(request, decider);
  const sending = busy !== null;
  const words = FEATURE_REQUEST_WORDS;

  // Cancel puts the keyboard back on the button that opened the form.
  const cancel = () => {
    const was = form;
    setForm(null);
    if (was) requestAnimationFrame(() => openers.current[was]?.focus());
  };
  const button = (choice: FeatureDecisionChoice, label: string, primary = false) => (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      disabled={sending}
      aria-busy={busy === choice || undefined}
      data-feature-choice={choice}
      ref={
        choice === 'decline' || choice === 'ask'
          ? (el) => {
              openers.current[choice] = el;
            }
          : undefined
      }
      onClick={() => (choice === 'decline' || choice === 'ask' ? setForm(choice) : onDecide?.(choice))}
    >
      {label}
    </Button>
  );

  return (
    <section
      className={cx(cardStyles.card, styles.card)}
      aria-label={featureRequestLabel(request)}
      data-card="feature_request"
      data-request-state={request.state}
    >
      <div className={styles.header}>
        <span className={cx(styles.status, waiting ? styles.warn : TONE[outcome?.tone ?? 'mut'])}>
          {words.label}
        </span>
        {/* “Value 7 of 10” to a screen reader, in reading order; “7 of 10” on screen. */}
        <span className={styles.value} data-feature-value={request.value ?? ''}>
          <span className={cardStyles.srOnly}>{featureValueLabel(request.value)}</span>
          <span aria-hidden="true">{featureValueText(request.value)}</span>
        </span>
      </div>
      <h3 className={cx(cardStyles.title, styles.title)}>{request.title}</h3>
      <p className={styles.from}>{featureRequestFrom(request)}</p>
      {request.summary && <p className={styles.summary}>{request.summary}</p>}
      {request.valueWhy && <p className={styles.why}>{request.valueWhy}</p>}
      <CustomerReads request={request} />
      {waiting && form === null && (
        <div className={styles.actions}>
          {button('approve', words.approve, true)}
          {request.canBuild && button('build', words.build)}
          {button('decline', words.decline)}
          {button('ask', words.ask)}
        </div>
      )}
      {waiting && form !== null && (
        <NoteForm
          form={form}
          agent={request.agent}
          initial={form === 'decline' ? request.declineReason : ''}
          busy={sending}
          onSend={(text) => onDecide?.(form, text)}
          onCancel={cancel}
        />
      )}
      {!waiting && outcome && (
        <p className={cx(styles.outcome, TONE[outcome.tone])} data-feature-outcome="">
          <span className={styles.outcomeLead}>{outcome.lead}</span>
          {outcome.detail && <span className={styles.outcomeDetail}> · {outcome.detail}</span>}
        </p>
      )}
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      {waiting && <p className={styles.hint}>{words.askAgent(request.agent)}</p>}
    </section>
  );
}
