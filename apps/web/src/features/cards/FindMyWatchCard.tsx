import { FIND_MY_WATCH_WORDS } from '@whombat/client';
import { type FindMyWatchView, findMyWatchCardLines } from '@whombat/core';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { StatusDot } from '../../components/StatusDot';
import scheduleStyles from '../schedules/Schedules.module.css';
import cardStyles from './Card.module.css';

export interface FindMyWatchCardProps {
  /** A watch that is still watching: an ended one is its line (`findMyWatchLine`). */
  watch: FindMyWatchView;
  timeZone: string;
  /** Now, for “Until 14:05” against “Until tomorrow at 14:05”. */
  nowMs: number;
  /** Without it there is no Cancel: a card shown as it was earlier. */
  onCancel?: () => void;
  busy?: boolean;
  /** Why the cancel didn't go through. */
  problem?: string | null;
}

/**
 * A one-time Find My watch while it watches (findmy-watch.md): what it waits for, until when, and Cancel. Not in the
 * mocks: it is drawn as the schedule card is, the other card an assistant posts about something still to come, so
 * the two read as one family. Every word is core's `findMyWatchCardLines`.
 */
export function FindMyWatchCard({
  watch,
  timeZone,
  nowMs,
  onCancel,
  busy = false,
  problem,
}: FindMyWatchCardProps) {
  const lines = findMyWatchCardLines(watch, timeZone, nowMs);
  return (
    <section
      className={cx(cardStyles.card, scheduleStyles.card)}
      aria-label={lines.title}
      data-card="findmy_watch"
      data-watch-status={watch.status}
    >
      <span className={cardStyles.title}>{lines.title}</span>
      {lines.detail && (
        <p className={scheduleStyles.cardWhen}>
          <StatusDot tone="ok" size={8} label={null} />
          <span>{lines.detail}</span>
        </p>
      )}
      {lines.canCancel && onCancel && (
        <div className={cardStyles.actions}>
          <Button
            variant="secondary"
            size="lg"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onCancel}
          >
            {FIND_MY_WATCH_WORDS.cancel}
          </Button>
        </div>
      )}
      {problem && (
        <p className={scheduleStyles.cardProblem} role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
