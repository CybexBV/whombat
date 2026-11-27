import {
  FEEDBACK_OUTCOME_LABELS,
  type ReportCard as ReportCardData,
  reportCardLabel,
  reportCardState,
} from '@whombat/core/domain';
import { formatRecent, plural } from '@whombat/core/text';
import { type ReactNode, useId } from 'react';
import { cx } from '../../components/cx';
import { currentLocale } from '../../i18n/provider';
import styles from './Card.module.css';
import report from './ReportCard.module.css';

export interface ReportCardProps {
  card: ReportCardData;
  now: number | Date;
  timeZone: string;
  /** Whether the details region is open (Details / Hide details). */
  expanded?: boolean;
  /** Omit to show the card without a Details control (stories of the summary alone). */
  onToggleDetails?: () => void;
  /** The details region, rendered inside the card while `expanded`. */
  details?: ReactNode;
}

/** Tone of the state line: failed and blocked assessments need a person. */
function stateTone(card: ReportCardData): string | undefined {
  if (card.assessment.state === 'failed') return report.bad;
  if (card.assessment.state === 'blocked') return report.warn;
  return undefined;
}

/**
 * Whombat Feedback report card (docs/decisions/feedback.md FB-16; not in the mocks, built in the chat-card
 * language): `BUG REPORT · FB-7K3Q-9M2X` + when it arrived, the visitor's words as plain text (React text
 * nodes: never Markdown, links or mentions), the assessment's summary once there is one (plain text too), and
 * the state line `Burrow Billing · New · Likely bug` with the screenshot count. Details open the full report
 * inside the card. In a conversation a report is its row (`ReportLine`, docs/decisions/report-rows.md RR-01); this card
 * is what the row opens and the root of the report's thread (RR-07).
 */
export function ReportCard({
  card,
  now,
  timeZone,
  expanded = false,
  onToggleDetails,
  details,
}: ReportCardProps) {
  const regionId = useId();
  const label = reportCardLabel(card);
  const state = reportCardState(card);
  const assessed = card.assessment.state === 'done' && card.assessment.summary;
  return (
    <section
      className={cx(styles.card, report.card)}
      aria-label={`${label}: ${state}`}
      data-card="report"
      data-state={card.assessment.state}
    >
      <div className={cx(styles.header, report.header)}>
        <span className={styles.label}>{label}</span>
        <span className={styles.metaMono}>
          Received {formatRecent(card.submittedAt, now, timeZone, currentLocale())}
        </span>
      </div>
      {card.contentRemoved ? (
        <p className={report.removed}>Content removed</p>
      ) : (
        <p className={report.summary}>{card.summary}</p>
      )}
      {assessed && (
        <div className={report.assessment}>
          <span className={report.assessmentLabel}>
            {card.assessment.outcome ? FEEDBACK_OUTCOME_LABELS[card.assessment.outcome] : 'Assessment'}
          </span>
          <p className={report.assessmentText}>{card.assessment.summary}</p>
        </div>
      )}
      <div className={report.footer}>
        <span className={cx(report.state, stateTone(card))}>
          {state}
          {card.attachments > 0 && (
            <span className={report.files}> · {plural(card.attachments, 'screenshot')}</span>
          )}
        </span>
        {onToggleDetails && (
          <button
            type="button"
            className={cx(styles.action, styles.actionSm, styles.secondary, report.toggle)}
            aria-expanded={expanded}
            aria-controls={expanded ? regionId : undefined}
            onClick={onToggleDetails}
          >
            {expanded ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {expanded && details && (
        <section id={regionId} className={report.details} aria-label={`Details of ${card.reference}`}>
          {details}
        </section>
      )}
    </section>
  );
}
