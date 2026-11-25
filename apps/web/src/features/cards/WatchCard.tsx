import { FIND_MY_WATCH_WORDS } from '@whombat/client';
import {
  type FindMyWatchView,
  findMyWatchCardLines,
  type ThingWatchView,
  thingWatchCardLines,
} from '@whombat/core';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { StatusDot } from '../../components/StatusDot';
import scheduleStyles from '../schedules/Schedules.module.css';
import cardStyles from './Card.module.css';

export interface WatchCardProps {
  watch: FindMyWatchView | ThingWatchView;
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
 * While a watch runs, show what it waits for, until when, and Cancel.
 */
export function WatchCard({ watch, timeZone, nowMs, onCancel, busy = false, problem }: WatchCardProps) {
  const thing = 'event' in watch;
  const lines = thing
    ? thingWatchCardLines(watch, timeZone, nowMs)
    : findMyWatchCardLines(watch, timeZone, nowMs);
  return (
    <section
      className={cx(cardStyles.card, scheduleStyles.card)}
      aria-label={lines.title}
      data-card={thing ? 'thing_watch' : 'findmy_watch'}
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
            className={cardStyles.watchCancel}
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
