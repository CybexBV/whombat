import { scheduleStatusText, scheduleText, scheduleTimeText } from '@whombat/client';
import {
  type AgentScheduleView,
  describeScheduleWhen,
  SCHEDULE_COPY,
  SCHEDULE_STATUS_LABELS,
  type ScheduleCard as ScheduleCardData,
  scheduleActions,
  scheduleCardTitle,
  type Tone,
} from '@whombat/core';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { StatusDot } from '../../components/StatusDot';
import { currentLocale } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import cardStyles from '../cards/Card.module.css';
import { TONE_CLASS } from '../cards/parts';
import { SCHEDULE_TONES } from './model';
import styles from './Schedules.module.css';

/** The card's label tone: an active schedule ok, a paused one waiting, an ended one quiet. */
const LABEL_TONE: Readonly<Record<AgentScheduleView['status'], Tone>> = {
  active: 'ok',
  paused: 'warn',
  ended: 'neutral',
};

export interface ScheduleCardProps {
  card: Pick<ScheduleCardData, 'schedule'>;
  /** The agent that made it: “Neo scheduled: …”. */
  agentName: string;
  timeZone: string;
  /** The viewer may cancel it here (`canChange`, the runtime has `agents.schedules`). */
  canCancel: boolean;
  onCancel?: () => void;
  busy?: boolean;
  /** Why the cancel didn't go through. */
  problem?: string | null;
}

/**
 * A turn an agent scheduled for itself, in the room where it did (Whombat resourceful-agents.md RA-30; contracts 0.44
 * `ScheduleCard`; AP-684): `SCHEDULE · ACTIVE` in its tone with the person it runs for on the right, “Neo scheduled:
 * Check last night’s backups…” (`scheduleCardTitle`), when it runs with the state's dot and when next, and **Cancel**
 * for the person it is for and people who may configure the agent (core's `scheduleActions(…).remove`). A viewer who
 * can't read the room it runs in sees “A private schedule”. Not in the mocks: the skill card's frame and header.
 */
export function ScheduleCard({
  card,
  agentName,
  timeZone,
  canCancel,
  onCancel,
  busy = false,
  problem,
}: ScheduleCardProps) {
  const SCHEDULE_TEXT = useLocaleWords(scheduleText);
  const s = card.schedule;
  if (!s)
    return (
      <section
        className={cx(cardStyles.card, styles.card)}
        aria-label={SCHEDULE_TEXT.gone}
        data-card="schedule"
      >
        <div className={cardStyles.header}>
          <span className={cardStyles.label}>SCHEDULE</span>
        </div>
        <p className={styles.cardHidden}>{SCHEDULE_TEXT.gone}</p>
      </section>
    );
  const title = scheduleCardTitle(agentName, s);
  const label = `SCHEDULE · ${SCHEDULE_STATUS_LABELS[s.status].toUpperCase()}`;
  return (
    <section
      className={cx(cardStyles.card, styles.card)}
      aria-label={title}
      data-card="schedule"
      data-schedule-status={s.status}
    >
      <div className={cardStyles.header}>
        <span className={cx(cardStyles.label, TONE_CLASS[LABEL_TONE[s.status]])}>{label}</span>
      </div>
      <span className={cardStyles.title}>{title}</span>
      <p className={styles.cardWhen}>
        <StatusDot tone={SCHEDULE_TONES[s.status]} size={8} label={null} />
        <span>
          {describeScheduleWhen(s.when, timeZone, Date.now())}
          {s.status === 'ended'
            ? ` · ${scheduleStatusText(s, currentLocale())}`
            : s.nextAt
              ? ` · next ${scheduleTimeText(s.nextAt, timeZone, Date.now(), currentLocale())}`
              : ` · ${scheduleStatusText(s, currentLocale())}`}
        </span>
      </p>
      {canCancel && scheduleActions(s).remove && (
        <div className={cardStyles.actions}>
          <Button variant="secondary" size="lg" disabled={busy} onClick={onCancel}>
            {SCHEDULE_COPY.cancel}
          </Button>
        </div>
      )}
      {problem && (
        <p className={styles.cardProblem} role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
