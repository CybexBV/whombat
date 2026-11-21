import type {
  AutomationPlanChange,
  AutomationPlanPrompt,
  AutomationPlanSection,
  AutomationPlanView,
} from '@whombat/core';
import { type ReactNode, useId } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import styles from './AutomationPlanCard.module.css';
import { CHANGE_MARKS, cardSections, planCardWords } from './automationPlan';
import cardStyles from './Card.module.css';

const TONE = { warn: styles.warn, ok: styles.ok, neutral: styles.quiet } as const;
const MARK = { added: styles.added, removed: styles.removed, changed: styles.changed } as const;

/**
 * What an automation does, as label and value rows: WHEN, the agent, ASKS YOU, POSTS, LIMIT, each line with its detail
 * under it. Whombat writes them from the definition (core `planSections`); the card and the automation's page show
 * them alike.
 */
export function PlanSections({
  sections,
  label,
}: {
  sections: readonly AutomationPlanSection[];
  label?: string;
}) {
  return (
    <dl className={styles.rows} aria-label={label}>
      {sections.map((s) => (
        <div key={s.id} className={styles.row} data-plan-section={s.id}>
          <dt className={styles.key}>{s.label}</dt>
          <dd className={styles.value}>
            {s.lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same; their order is their identity
              <p key={i} className={styles.line}>
                {l.text}
                {l.detail && <small className={styles.detail}>{l.detail}</small>}
              </p>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A folded block on the sf2 ground: “How I thought about it”, “What Dusty is asked”. */
function Fold({
  title,
  open,
  children,
  data,
}: {
  title: string;
  open: boolean;
  children: ReactNode;
  data: string;
}) {
  return (
    <details className={styles.fold} open={open} data-plan-fold={data}>
      <summary className={styles.foldTitle}>
        <Icon name="chevronDown" size={15} className={styles.chevron} />
        {title}
      </summary>
      {children}
    </details>
  );
}

/** What the agent is asked in each of its steps, word for word, folded. */
export function PlanPrompts({ prompts, title }: { prompts: readonly AutomationPlanPrompt[]; title: string }) {
  if (!prompts.length) return null;
  return (
    <Fold title={title} open={false} data="prompts">
      <div className={styles.prompts}>
        {prompts.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps may share a name
          <div key={i} className={styles.prompt}>
            <span className={styles.promptStep}>{p.step}</span>
            <p className={styles.promptText}>{p.text}</p>
          </div>
        ))}
      </div>
    </Fold>
  );
}

function PlanChanges({ changes, label }: { changes: readonly AutomationPlanChange[]; label: string }) {
  const id = useId();
  return (
    <div className={styles.changes}>
      <span id={id} className={styles.changesLabel}>
        {label}
      </span>
      <ul className={styles.changeList} aria-labelledby={id}>
        {changes.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the server's list, in its order
          <li key={i} className={styles.change} data-plan-change={c.change}>
            <span className={cx(styles.mark, MARK[c.change])} aria-hidden="true">
              {CHANGE_MARKS[c.change].mark}
            </span>
            <span>
              <span className={cardStyles.srOnly}>{CHANGE_MARKS[c.change].said} </span>
              {c.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface AutomationPlanCardProps {
  plan: AutomationPlanView;
  /** The agent's name: “What Dusty is asked”. */
  agentName: string;
  /** Try it's label (“Try it on #12”); null: no Try it (no sample to try it on, or the plan is decided). */
  tryLabel: string | null;
  /** What is being sent: its button waits, the others too. */
  busy?: 'accept' | 'decline' | 'try' | null;
  onAccept?: () => void;
  onDecline?: () => void;
  onTry?: () => void;
}

/**
 * A plan for an automation the agent proposed (Whombat automation-chat.md; app automation-chat.md): its state in the
 * label, the agent's name and sentence for it, then what it does in Whombat's words — for a change WHAT CHANGES, what
 * still asks first and its limits, with the whole automation folded — the agent's “How I thought about it” (open while
 * it waits) and what the agent is asked (folded). While it waits: Turn it on, Try it and Not now, or reply in the
 * thread to change it.
 */
export function AutomationPlanCard({
  plan,
  agentName,
  tryLabel,
  busy = null,
  onAccept,
  onDecline,
  onTry,
}: AutomationPlanCardProps) {
  const titleId = useId();
  const words = planCardWords(plan, agentName);
  const waiting = plan.state === 'waiting';
  const shown = cardSections(plan);
  return (
    <section
      className={cx(cardStyles.card, styles.card)}
      aria-labelledby={titleId}
      data-card="automation_plan"
      data-plan-state={plan.state}
    >
      <span className={cx(styles.status, TONE[words.tone])}>{words.status}</span>
      <h3 id={titleId} className={cx(cardStyles.title, styles.title)}>
        {plan.name}
      </h3>
      {plan.description && <p className={styles.description}>{plan.description}</p>}
      {plan.change && plan.changes.length > 0 && <PlanChanges changes={plan.changes} label={words.changes} />}
      {shown.length > 0 && <PlanSections sections={shown} />}
      {plan.thinking.length > 0 && (
        <Fold title={words.thinking} open={waiting} data="thinking">
          <ul className={styles.thinking}>
            {plan.thinking.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the agent's points, in its order
              <li key={i}>{t}</li>
            ))}
          </ul>
        </Fold>
      )}
      {plan.change && plan.sections.length > 0 && (
        <Fold title={words.whole} open={false} data="whole">
          <div className={styles.whole}>
            <PlanSections sections={plan.sections} />
          </div>
        </Fold>
      )}
      <PlanPrompts prompts={plan.prompts} title={words.prompts} />
      {waiting && (
        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={busy !== null}
            aria-busy={busy === 'accept' || undefined}
            onClick={onAccept}
            data-plan-accept=""
          >
            {words.accept}
          </Button>
          {tryLabel && (
            <Button
              variant="secondary"
              disabled={busy !== null}
              aria-busy={busy === 'try' || undefined}
              onClick={onTry}
            >
              {tryLabel}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy !== null}
            aria-busy={busy === 'decline' || undefined}
            onClick={onDecline}
          >
            {words.decline}
          </Button>
          <span className={styles.hint}>{words.hint}</span>
        </div>
      )}
    </section>
  );
}
