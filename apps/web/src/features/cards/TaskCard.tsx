import { BrandMark } from '@whombat/brand/react';
import { TASK_TONES, taskCardView, thingMark } from '@whombat/client';
import { useCachedThingHead } from '@whombat/client/react';
import { type TaskCard as TaskCardData, thingHref, thingId } from '@whombat/core';
import { Server } from 'lucide-react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useTicker } from '../messaging/useRoom';
import styles from './Card.module.css';
import { CardLink, type NavigateHandler } from './parts';
import line from './RunLine.module.css';
import live from './RunLiveCard.module.css';
import { LINE_TONE } from './SettledLine';
import task from './TaskCard.module.css';

export interface TaskCardProps {
  burrow: string;
  card: TaskCardData;
  onNavigate?: NavigateHandler;
}

/** How it went, in the state's colour; a lost task stays muted. */
const STATE_TONE: Record<TaskCardData['state'], string | undefined> = {
  running: undefined,
  ok: task.ok,
  warning: task.warn,
  error: task.bad,
  lost: undefined,
};

/**
 * A server task Whombat follows (contracts 0.116, CT-880; task-feedback.md TF-10, AP-4300). While it runs, the live run
 * card's frame: the pulsing dot, what it does (“Installing 23 updates on Home Assistant”) and how long it has run
 * (ticking), the run line's thin track with its sheen sweeping (nothing moves with reduced motion), and the server with
 * its mark, a link to its page. Once it ended the message shows its line (`taskLine`), which opens this card with the
 * runtime's full words, the time it took and how it went in the state's colour.
 */
export function TaskCard({ burrow, card, onNavigate }: TaskCardProps) {
  const running = card.state === 'running';
  const now = useTicker(running);
  const view = taskCardView(card, now);
  const head = useCachedThingHead(burrow, thingId('server', card.serverId));
  const mark = head ? thingMark(head) : null;
  return (
    <section
      className={cx(styles.card, live.card, LINE_TONE[TASK_TONES[card.state]])}
      aria-label={view.label}
      data-card="task"
      data-variant={running ? 'live' : 'full'}
      data-state={card.state}
    >
      <div className={live.head}>
        <span className={line.dot} role="img" aria-label={view.state} />
        <span className={live.title} title={view.title}>
          {view.title}
        </span>
        {view.elapsed && <span className={live.elapsed}>{view.elapsed}</span>}
      </div>
      {running && <div className={task.track} aria-hidden="true" />}
      {!running && card.result && <p className={task.result}>{card.result}</p>}
      <div className={live.foot}>
        <CardLink
          className={task.server}
          href={thingHref('server', card.serverId)}
          onNavigate={onNavigate}
          title={`Open ${card.server}`}
        >
          {mark ? (
            <BrandMark mark={mark} size={14} />
          ) : (
            <Icon icon={Server} size={14} className={task.glyph} />
          )}
          <span className={task.name}>{card.server}</span>
        </CardLink>
        {!running && <span className={cx(task.state, STATE_TONE[card.state])}>{view.state}</span>}
      </div>
    </section>
  );
}
