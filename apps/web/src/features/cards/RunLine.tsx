import { type RunChips, runLineControls, runLineText } from '@whombat/client';
import type { Run } from '@whombat/core/domain';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import cardStyles from './Card.module.css';
import { runHref } from './links';
import { CardLink, type NavigateHandler } from './parts';
import styles from './RunLine.module.css';
import { ExpandCard, LINE_TONE } from './SettledLine';

export interface RunLineProps {
  run: Run;
  onNavigate?: NavigateHandler;
  /** Try again on a failed line (AP-699): the run page's `runs.retry` (`useRunControl`). */
  onRetry?: () => void;
  /** The retry was sent and hasn't answered yet. */
  retrying?: boolean;
  /**
   * Pause while it works, Resume while paused (docs/decisions/web-messages.md WX-10): the run page's `runs.pause` /
   * `runs.resume` (`useRunControl`), on the line itself. Without it there is none.
   */
  toggle?: { action: 'pause' | 'resume'; busy: boolean; onAct: () => void } | null;
  /** A settled run that changed something (AP-731): its `PR #3` and `+12 −8` chips (`runChips`). */
  chips?: RunChips | null;
  /** Where `PR #3` goes (the branch room, `usePrHref`). */
  prHref?: string | null;
  /** The control that opens the run card in place (AP-730); without `onToggle` there is none. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Under the line: the opened card. */
  children?: ReactNode;
}

/** `PR #3` (a link to its branch room when there is one) and `+12 −8`, in the run card's diff font. */
export function RunChipList({
  chips,
  prHref,
  onNavigate,
}: {
  chips: RunChips;
  prHref?: string | null;
  onNavigate?: NavigateHandler;
}) {
  if (chips.prNumber === null && !chips.diff) return null;
  const pr = chips.prNumber === null ? null : `PR #${chips.prNumber}`;
  const [add, del] = chips.diff?.split(' ') ?? [];
  return (
    <span className={styles.chips}>
      {pr &&
        (prHref ? (
          <CardLink className={styles.chip} href={prHref} onNavigate={onNavigate}>
            {pr}
          </CardLink>
        ) : (
          <span className={styles.chip}>{pr}</span>
        ))}
      {chips.diff && (
        <span className={styles.chip} title={chips.files ?? undefined}>
          <span className={cardStyles.add}>{add}</span> <span className={cardStyles.del}>{del}</span>
        </span>
      )}
    </span>
  );
}

/**
 * A run that hasn't changed anything yet, as one line under its message (docs/decisions/run-line.md AP-668): a
 * pulsing dot, `Checking · {step}` and a thin bar that sweeps while it is live; `Run #6 · Done in 1m 12s · {summary}`
 * once it ends. Watch run opens the live run, Open run one that has stopped, and a failed one offers Try again where
 * the Whombat can (AP-699). The run's first changed file or pull request turns it into the `RunCard`; once that run is
 * done it is this line again, with its `PR #3` and `+12 −8` chips and a control that opens the card (AP-731).
 */
export function RunLine({
  run: r,
  onNavigate,
  onRetry,
  retrying = false,
  toggle = null,
  chips,
  prHref,
  expanded = false,
  onToggle,
  children,
}: RunLineProps) {
  const { lead, detail, tone } = runLineText(r);
  const controls = runLineControls(r);
  const { link } = controls;
  const retry = controls.retry && onRetry !== undefined;
  const live = r.status === 'live';
  const progress = Math.max(0, Math.min(100, r.progress));
  return (
    <section
      className={cx(styles.line, LINE_TONE[tone])}
      aria-label={`Run #${r.number}: ${r.title}`}
      data-card="run"
      data-variant="line"
      data-status={r.status}
    >
      <div className={styles.row}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.text} title={detail ? `${lead} · ${detail}` : lead}>
          <span className={styles.lead}>{lead}</span>
          {detail && <span className={styles.detail}> · {detail}</span>}
        </span>
        {chips && <RunChipList chips={chips} prHref={prHref} onNavigate={onNavigate} />}
        {toggle && (
          <Button
            variant="link"
            className={styles.retry}
            disabled={toggle.busy}
            aria-busy={toggle.busy || undefined}
            aria-label={`${toggle.action === 'pause' ? 'Pause' : 'Resume'} run #${r.number}`}
            onClick={toggle.onAct}
            data-run-toggle=""
          >
            {toggle.action === 'pause' ? 'Pause' : 'Resume'}
          </Button>
        )}
        {retry && (
          <Button
            variant="link"
            className={styles.retry}
            disabled={retrying}
            aria-busy={retrying || undefined}
            onClick={onRetry}
          >
            Try again
          </Button>
        )}
        <CardLink className={styles.link} href={runHref(r)} onNavigate={onNavigate}>
          {link}
        </CardLink>
        {onToggle && <ExpandCard expanded={expanded} onToggle={onToggle} />}
      </div>
      {live && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Run progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div className={styles.bar} style={{ width: `${Math.max(progress, 8)}%` }} />
        </div>
      )}
      {children}
    </section>
  );
}
