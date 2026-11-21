import { runChips, runLiveText } from '@whombat/client';
import type { Run } from '@whombat/core/domain';
import { cx } from '../../components/cx';
import { useNow } from '../messaging/useRoom';
import styles from './Card.module.css';
import { runHref } from './links';
import { CardLink, type NavigateHandler } from './parts';
import run from './RunCard.module.css';
import { RunChipList } from './RunLine';
import line from './RunLine.module.css';
import live from './RunLiveCard.module.css';
import { ExpandCard } from './SettledLine';

export interface RunLiveCardProps {
  run: Run;
  onNavigate?: NavigateHandler;
  /** Where `PR #3` goes (the branch room, `usePrHref`). */
  prHref?: string | null;
  /** The control that opens the full run card in place. */
  expanded?: boolean;
  onToggle?: () => void;
}

/**
 * A run that changed something, while it works (docs/decisions/card-settle.md AP-733): its title, the run card's 6px
 * bar, `Now: …` and how long it has run (ticking), the `PR #3` and `+12 −8` chips, Watch run, and the control that
 * opens the full card. It becomes the full card by itself when it needs a person, and a line once it is done.
 */
export function RunLiveCard({ run: r, onNavigate, prHref, expanded = false, onToggle }: RunLiveCardProps) {
  const now = useNow(1000);
  const text = runLiveText(r, now);
  const chips = runChips(r);
  const progress = Math.max(0, Math.min(100, r.progress));
  return (
    <section
      className={cx(styles.card, live.card, line.live)}
      aria-label={`Run #${r.number}: ${r.title}`}
      data-card="run"
      data-variant="live"
      data-status={r.status}
    >
      <div className={live.head}>
        <span className={line.dot} role="img" aria-label="Live" />
        <span className={live.title} title={text.title}>
          {text.title}
        </span>
        <span className={live.elapsed}>{text.elapsed}</span>
      </div>
      <div
        className={run.track}
        role="progressbar"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div className={run.bar} style={{ width: `${progress}%` }} />
      </div>
      <div className={live.foot}>
        <span className={live.now} title={text.now ?? undefined}>
          {text.now}
        </span>
        <RunChipList chips={chips} prHref={prHref} onNavigate={onNavigate} />
        <CardLink className={line.link} href={runHref(r)} onNavigate={onNavigate}>
          Watch run
        </CardLink>
        {onToggle && <ExpandCard expanded={expanded} onToggle={onToggle} />}
      </div>
    </section>
  );
}
