import {
  TURN_FAILURE_LABELS,
  TURN_RETRY_LABEL,
  type TurnFailedCard as TurnFailedCardData,
  turnRetriedText,
} from '@whombat/core';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import styles from './Card.module.css';
import { CardAction, type NavigateHandler, TONE_CLASS } from './parts';
import turn from './TurnFailedCard.module.css';

export interface TurnFailedCardProps {
  card: TurnFailedCardData;
  /** The agent's name, for the card's accessible name (“Dusty couldn’t finish”). */
  agentName: string;
  /** Show the reason sentence (false when the message's own text already says it). */
  showReason?: boolean;
  /** The viewer may press Try again (`canRetryTurn` and the runtime has `dispatches.retry`). */
  canRetry: boolean;
  /** The retry was sent and hasn't answered yet. */
  retrying?: boolean;
  onRetry?: () => void;
  /** The reader's zone, for “Tried again · 14:32”. */
  timeZone: string;
  /** A way to fix what failed (Settings → AI for `signin`), shown beside Try again. */
  fix?: { href: string; label: string } | null;
  onNavigate?: NavigateHandler;
  /** Anything under the actions (a problem with the retry). */
  note?: ReactNode;
}

/**
 * A turn that failed for good (Whombat essentials item 4; contracts CT-167; AP-480): on the agent's failure message,
 * the failure's short state in the bad tone (`TURN_FAILURE_LABELS`: “NOT SIGNED IN”, “USAGE LIMIT”…), its safe sentence,
 * and “Try again” for people who may wake that agent there. Once someone pressed it, the label quietens and the row says
 * “Tried again · 14:32” for everyone. Not in the mocks: the skill and approval cards' frame and header.
 */
export function TurnFailedCard({
  card,
  agentName,
  showReason = true,
  canRetry,
  retrying = false,
  onRetry,
  timeZone,
  fix,
  onNavigate,
  note,
}: TurnFailedCardProps) {
  const retried = card.retriedAt !== null;
  const label = TURN_FAILURE_LABELS[card.code] ?? TURN_FAILURE_LABELS.internal;
  const action = retried ? (
    <span className={turn.retried}>{turnRetriedText(card.retriedAt as string, timeZone)}</span>
  ) : canRetry ? (
    <Button
      variant="primary"
      size="md"
      disabled={retrying}
      aria-label={`${TURN_RETRY_LABEL}: ${agentName}`}
      onClick={onRetry}
    >
      {retrying ? `${TURN_RETRY_LABEL}…` : TURN_RETRY_LABEL}
    </Button>
  ) : null;
  const fixLink =
    fix && !retried ? (
      <CardAction href={fix.href} onNavigate={onNavigate}>
        {fix.label}
      </CardAction>
    ) : null;
  return (
    <section
      className={cx(styles.card, turn.card)}
      aria-label={`${agentName} couldn’t finish`}
      data-card="turn_failed"
      data-code={card.code}
      data-retried={retried || undefined}
    >
      <div className={styles.header}>
        <span className={cx(styles.label, retried ? TONE_CLASS.neutral : TONE_CLASS.bad)}>{label}</span>
      </div>
      {showReason && <p className={turn.reason}>{card.reason}</p>}
      {(action || fixLink) && (
        <div className={cx(styles.actions, turn.actions)}>
          {action}
          {fixLink}
        </div>
      )}
      {note}
    </section>
  );
}
