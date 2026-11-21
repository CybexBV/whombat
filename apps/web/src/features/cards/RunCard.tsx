import { CARD_FRAME_WORDS, RUN_ATTENTION_LABEL, runAttention, runFrame } from '@whombat/client';
import type { Run } from '@whombat/core/domain';
import { formatAdditions, formatDeletions, formatTestsPassing, plural } from '@whombat/core/text';
import { cx } from '../../components/cx';
import { runControls } from '../runs/runModel';
import { CardFrame, FrameButton, frameStyles as f } from './CardFrame';
import { runBranchHref, runHref } from './links';
import { CardLink, DiffStatText, type NavigateHandler } from './parts';
import run from './RunCard.module.css';

export interface RunCardProps {
  run: Run;
  onNavigate?: NavigateHandler;
  /** The branch room's link with its repo (`usePrHref`, AP-497); by default the PR number alone. */
  branchHref?: string | null;
  /** Try again on a failed run, as on its page (AP-699): the run page's `runs.retry` (`useRunControl`). */
  onRetry?: () => void;
  /** The retry was sent and hasn't answered yet. */
  retrying?: boolean;
}

/**
 * Run card, in the cards' one layout (docs/decisions/chat-threads-cards.md): its status (Working, Paused, Done, Didn’t
 * finish, Taken over) with when it started or ended, its title, what it does now (“Now: …”) or how it ended, the 6px bar
 * (width transition .6s), why a live run needs a person (`Run.attention`, CT-197; AP-597), then Watch run, Branch room
 * and Try again on a failed run where the run page offers it (`runControls`, AP-699). The run's number, branch, tests and
 * changes are under Details. Realtime `run.updated` events patch the embedded run, so the card streams.
 */
export function RunCard({
  run: r,
  onNavigate,
  branchHref: givenBranchHref,
  onRetry,
  retrying = false,
}: RunCardProps) {
  const branchHref = givenBranchHref === undefined ? runBranchHref(r) : givenBranchHref;
  const retry = runControls(r.status).retry && onRetry !== undefined;
  const passing = r.tests !== null && r.tests.total > 0 && r.tests.passed >= r.tests.total;
  const progress = Math.max(0, Math.min(100, r.progress));
  const attention = runAttention(r);
  const frame = runFrame(r);
  return (
    <CardFrame
      card="run"
      frame={frame}
      className={run.card}
      data={{ 'data-status': r.status }}
      content={
        <>
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
          {attention && (
            <p className={run.attention} data-testid="run-attention">
              <span className={run.attentionLabel}>{RUN_ATTENTION_LABEL}</span> · {attention}
            </p>
          )}
        </>
      }
      actions={
        <>
          <CardLink href={runHref(r)} onNavigate={onNavigate} className={cx(f.button, f.main)}>
            Watch run
          </CardLink>
          {branchHref && (
            <CardLink href={branchHref} onNavigate={onNavigate} className={cx(f.button, f.other)}>
              Branch room
            </CardLink>
          )}
          {retry && (
            <FrameButton disabled={retrying} aria-busy={retrying || undefined} onClick={onRetry}>
              Try again
            </FrameButton>
          )}
        </>
      }
      details={
        <dl className={f.facts}>
          <dt>{CARD_FRAME_WORDS.runTerm}</dt>
          <dd>#{r.number}</dd>
          <dt>{CARD_FRAME_WORDS.branch}</dt>
          <dd>{r.branch}</dd>
          {r.tests && (
            <>
              <dt>Tests</dt>
              <dd className={cx(run.tests, passing && run.testsPassing)}>{formatTestsPassing(r.tests)}</dd>
            </>
          )}
          <dt>Changes</dt>
          <dd>
            <DiffStatText
              add={formatAdditions(r.diff.add)}
              del={formatDeletions(r.diff.del)}
              suffix={<span className={run.files}>· {plural(r.diff.files, 'file')}</span>}
            />
          </dd>
        </dl>
      }
    />
  );
}
