import type { SettledLine as SettledLineText } from '@whombat/client';
import type { ReactNode } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import styles from './RunLine.module.css';

export const LINE_TONE = {
  live: styles.live,
  warn: styles.warn,
  ok: styles.ok,
  bad: styles.bad,
  // The dot is grey unless a tone colours it.
  mut: undefined,
} as const;

/** The expand control's names (docs/decisions/card-settle.md AP-730). */
export const SHOW_CARD = 'Show card';
export const HIDE_CARD = 'Hide card';

/**
 * The control on the right of a settled line that opens its card in place (AP-730): a real button with the chevron,
 * `aria-expanded`, and the app's focus ring.
 */
export function ExpandCard({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={styles.expand}
      aria-expanded={expanded}
      aria-label={expanded ? HIDE_CARD : SHOW_CARD}
      title={expanded ? HIDE_CARD : SHOW_CARD}
      onClick={onToggle}
    >
      <Icon name="chevronDown" size={14} />
    </button>
  );
}

export interface SettledLineProps {
  /** The lead, detail and tone (`approvalLine`, `skillLine`, … in `@whombat/client`). */
  line: SettledLineText;
  /** The region's name (“Approval: Deploy feat/invoice-pdf to staging”). */
  label: string;
  /** `data-card` (the card kind), as the card itself has. */
  card: string;
  /** `sm`: a line inside its run (AP-732). */
  size?: 'md' | 'sm';
  /** The message id a line inside its run answers to, so links and jumps to that message land here. */
  id?: string;
  /** Actions the card had that still apply (Undo, Cancel), before the expand control. */
  controls?: ReactNode;
  /** The expand control's state; without `onToggle` there is none. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Under the line: the opened card, a problem. */
  children?: ReactNode;
}

/**
 * A card that is done, as one line (docs/decisions/card-settle.md AP-731): the run line's anatomy (a status dot in the
 * tone, a bold lead, a muted detail, controls on the right) and the control that opens the card under it.
 */
export function SettledLine({
  line,
  label,
  card,
  size = 'md',
  id,
  controls,
  expanded = false,
  onToggle,
  children,
}: SettledLineProps) {
  const { lead, detail, tone } = line;
  return (
    <section
      id={id}
      className={cx(styles.line, LINE_TONE[tone], size === 'sm' && styles.small)}
      aria-label={label}
      data-card={card}
      data-variant="line"
    >
      <div className={styles.row}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.text} title={detail ? `${lead} · ${detail}` : lead}>
          <span className={styles.lead}>{lead}</span>
          {detail && <span className={styles.detail}> · {detail}</span>}
        </span>
        {controls}
        {onToggle && <ExpandCard expanded={expanded} onToggle={onToggle} />}
      </div>
      {children}
    </section>
  );
}
