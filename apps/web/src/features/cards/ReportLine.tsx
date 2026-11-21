import type { ReportLine as ReportLineText } from '@whombat/client';
import { type ReactNode, useId } from 'react';
import { cx } from '../../components/cx';
import styles from './Card.module.css';
import report from './ReportLine.module.css';
import lineStyles from './RunLine.module.css';
import { LINE_TONE } from './SettledLine';

export interface ReportLineProps {
  /** What the row says (`reportLine` in `@whombat/client`). */
  line: ReportLineText;
  /** The message id a jump to this report lands on. */
  id?: string;
  /** Whether the whole report is open under the row (Details / Hide details). */
  expanded?: boolean;
  /** Omit for the row without a Details control. */
  onToggle?: () => void;
  /** The whole report, under the row while `expanded`. */
  children?: ReactNode;
}

/**
 * A Whombat Feedback report in its conversation, as one row (docs/decisions/report-rows.md RR-01, RR-02; John: the
 * report cards took too much room): the settled line's anatomy — the dot in the assessment's tone, the outcome in 600
 * and one sentence (the assessment's summary, else the visitor's words), at most two lines — over the reference in
 * mono and the muted facts, with Details on the right. Details opens the whole report in place; Hide details folds it
 * back. Everything here is plain text: the visitor's words never become Markdown, links or mentions.
 */
export function ReportLine({ line, id, expanded = false, onToggle, children }: ReportLineProps) {
  const regionId = useId();
  const { lead, detail, tone, reference, meta, quiet, label } = line;
  return (
    <section
      id={id}
      className={cx(lineStyles.line, LINE_TONE[tone], report.line)}
      aria-label={label}
      data-card="report"
      data-variant="line"
    >
      <div className={report.row}>
        <span className={cx(lineStyles.dot, report.dot)} aria-hidden="true" />
        <div className={report.text}>
          <p className={report.sentence} title={detail ? `${lead} · ${detail}` : lead}>
            <span className={report.lead}>{lead}</span>
            {detail && (
              <>
                {' · '}
                <span className={cx(quiet && report.quiet)}>{detail}</span>
              </>
            )}
          </p>
          <p className={report.meta}>
            <span className={report.reference}>{reference}</span>
            {meta.map((m) => ` · ${m}`).join('')}
          </p>
        </div>
        {onToggle && (
          <button
            type="button"
            className={cx(styles.action, styles.actionSm, styles.secondary, report.toggle)}
            aria-expanded={expanded}
            aria-controls={expanded ? regionId : undefined}
            onClick={onToggle}
          >
            {expanded ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {expanded && children && (
        <div id={regionId} className={lineStyles.opened}>
          {children}
        </div>
      )}
    </section>
  );
}
