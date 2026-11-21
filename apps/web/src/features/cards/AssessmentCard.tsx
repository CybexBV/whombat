import { assessmentVerdict, DECISION_ACTION_HINTS } from '@whombat/client';
import {
  type AssessmentCard as AssessmentCardData,
  assessmentCardLabel,
  assessmentDetailRows,
  assessmentHeadline,
  evidenceLine,
} from '@whombat/core/domain';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { StatusPill } from '../../components/StatusDot';
import assessment from './AssessmentCard.module.css';
import styles from './Card.module.css';

export interface AssessmentCardProps {
  card: AssessmentCardData;
  /** Whether the viewer may pick an option now (a person, on a runtime with `feedback.decisions`). */
  canDecide: boolean;
  /** The option being sent (its index), until the runtime answers. */
  deciding?: number | null;
  onDecide?: (option: number) => void;
  /** “Mara chose “Won’t fix” · closed · 16:10”, once picked. */
  decidedText?: string | null;
  /** Starts with the full assessment open (stories, the visual suite). */
  defaultExpanded?: boolean;
  /** Anything under the options (a refusal). */
  note?: ReactNode;
}

/**
 * The assessor's card under its reply (Whombat docs/decisions/feedback.md FB-32; contracts CT-193; not in the mocks,
 * built in the report card's language): `ASSESSMENT · FB-…` with the verdict as a status pill (bug reports: Bug, Not a
 * bug, Unsure), the assessor's question with its options — the recommended one primary — or who picked what, and the
 * full assessment folded behind “Full assessment”. Everything the assessor wrote is plain text (React text nodes).
 */
export function AssessmentCard({
  card,
  canDecide,
  deciding = null,
  onDecide,
  decidedText = null,
  defaultExpanded = false,
  note,
}: AssessmentCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const regionId = useId();
  const hintId = useId();
  const label = assessmentCardLabel(card);
  const verdict = assessmentVerdict(card);
  const a = card.assessment;
  const decision = card.decision;
  return (
    <section
      className={cx(styles.card, assessment.card)}
      aria-label={`${label}: ${verdict.text}`}
      data-card="assessment"
      data-verdict={card.bugVerdict ?? undefined}
    >
      <div className={cx(styles.header, assessment.header)}>
        <span className={styles.label}>{label}</span>
        <StatusPill tone={verdict.tone} className={assessment.verdict}>
          {verdict.text}
        </StatusPill>
      </div>

      {decision && (
        <div className={assessment.decision}>
          {card.decided ? (
            <>
              <p className={assessment.question}>{decision.question}</p>
              <p className={assessment.decided}>{decidedText}</p>
            </>
          ) : (
            <>
              <fieldset className={assessment.fieldset}>
                <legend className={assessment.question}>{decision.question}</legend>
                <div className={assessment.options}>
                  {decision.options.map((o, i) => (
                    <Button
                      key={o.label}
                      variant={o.recommended ? 'primary' : 'secondary'}
                      size="md"
                      disabled={!canDecide || deciding !== null}
                      title={DECISION_ACTION_HINTS[o.action]}
                      aria-describedby={`${hintId}-${i}`}
                      onClick={() => onDecide?.(i)}
                    >
                      {deciding === i ? `${o.label}…` : o.label}
                    </Button>
                  ))}
                </div>
                {decision.options.map((o, i) => (
                  <span key={o.label} id={`${hintId}-${i}`} className={styles.srOnly}>
                    {`${o.recommended ? 'Recommended. ' : ''}${DECISION_ACTION_HINTS[o.action]}`}
                  </span>
                ))}
              </fieldset>
              {note}
            </>
          )}
        </div>
      )}

      <button
        type="button"
        className={assessment.toggle}
        aria-expanded={expanded}
        aria-controls={expanded ? regionId : undefined}
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon name="chevronDown" size={14} className={cx(assessment.chevron, expanded && assessment.open)} />
        <span className={assessment.toggleLabel}>Full assessment</span>
        <span className={assessment.headline}>{assessmentHeadline(a)}</span>
      </button>
      {expanded && (
        <section
          id={regionId}
          className={assessment.details}
          aria-label={`Full assessment of ${card.reference}`}
        >
          <dl className={assessment.rows}>
            {assessmentDetailRows(a).map((row) => (
              <div key={row.label} className={assessment.row}>
                <dt className={assessment.rowLabel}>{row.label}</dt>
                <dd className={assessment.rowText}>{row.text}</dd>
              </div>
            ))}
          </dl>
          {a.evidence.length > 0 && (
            <div className={assessment.evidence}>
              <span className={styles.label}>EVIDENCE</span>
              <ul className={assessment.evidenceList}>
                {a.evidence.map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: evidence is positional and never reorders
                  <li key={i} className={assessment.evidenceItem}>
                    {evidenceLine(e)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
