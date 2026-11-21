/**
 * The Automations list's rows (docs/decisions/automations-final.md): each row is one link to the automation's page — the
 * real mark of what starts it and the whole name, then one line joined with “ · ”: On, Off or Not on yet, its last run in
 * words and when, its next run, and a plan that waits for the person. It wraps only when it must, and one chevron sits
 * at the end. Off and not on yet read as clearly as on. The agent's own schedules are rows under Only tells you, with
 * their switch and buttons (`ScheduleRow`).
 */

import type { AutomationListRow, AutomationStateTone, AutomationTileView, RunBarTone } from '@whombat/client';
import {
  type AgentScheduleView,
  describeScheduleWhen,
  formatRecent,
  schedulePromptLine,
} from '@whombat/core';
import { ChevronRight } from 'lucide-react';
import { Fragment, type MouseEvent } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Toggle } from '../../components/Toggle';
import styles from './Automations.module.css';
import { nextRunWords } from './automationModel';
import { automationPaths } from './hooks';
import { SourceTile } from './SourceTile';

/** Follows a link inside the app unless the person asked for a new tab or window. */
export function follow(onOpen: (href: string) => void, href: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpen(href);
  };
}

const DOT = {
  on: styles.dotOn,
  waiting: styles.dotWaiting,
  off: styles.dotRing,
  draft: styles.dotRing,
} as const;

/** A 7px dot: filled for on and waiting, a ring for off and not on yet. */
export function StateDot({ tone }: { tone: AutomationStateTone }) {
  return <i className={cx(styles.stateDot, DOT[tone])} aria-hidden="true" />;
}

const BAR: Record<RunBarTone, string | undefined> = {
  ok: styles.barOk,
  bad: styles.barBad,
  warn: styles.barWarn,
  brand: styles.barBrand,
  quiet: styles.barQuiet,
};

/** Its last few runs as small bars, oldest left: 4px wide, 11px tall, a stopped or skipped one shorter. */
export function RunBars({ bars }: { bars: readonly { key: string; tone: RunBarTone }[] }) {
  if (!bars.length) return null;
  return (
    <span className={styles.bars} aria-hidden="true">
      {bars.map((b) => (
        <i key={b.key} className={BAR[b.tone]} />
      ))}
    </span>
  );
}

/** One automation on the list. */
export function AutomationRow({
  burrow,
  row,
  onOpen,
}: {
  burrow: string;
  row: AutomationListRow;
  onOpen: (href: string) => void;
}) {
  const href = automationPaths.one(row.id);
  return (
    <a
      className={styles.listRow}
      href={href}
      onClick={follow(onOpen, href)}
      aria-label={row.accessibilityLabel}
      data-automation-row={row.id}
      data-automation-state={row.state.tone}
    >
      <span className={styles.listMain}>
        <span className={styles.listHead}>
          <SourceTile burrow={burrow} tile={row.tile} size="mark" />
          <span className={styles.listName}>{row.name}</span>
        </span>
        <span className={styles.rowLine}>
          {row.line.map((part, i) => (
            <Fragment key={part.key}>
              {i > 0 ? ' · ' : null}
              <span
                className={
                  part.key === 'state' ? styles.rowState : part.key === 'plan' ? styles.rowPlan : undefined
                }
              >
                {part.text}
              </span>
            </Fragment>
          ))}
        </span>
      </span>
      <Icon icon={ChevronRight} size={18} className={styles.listChevron} />
    </a>
  );
}

const SCHEDULE_TILE: AutomationTileView = { source: 'schedule', owner: null, label: 'Schedule' };

/** A schedule's words: its first line as the name, when it runs, and when next. */
export function scheduleRowWords(schedule: AgentScheduleView, timeZone: string, now: Date) {
  const when = describeScheduleWhen(schedule.when, timeZone, now);
  return {
    name: schedulePromptLine(schedule.prompt, 120),
    when,
    state:
      schedule.status === 'active' ? 'On' : schedule.status === 'paused' ? 'Paused' : 'Ended after 90 days',
    next:
      schedule.status === 'active' && schedule.nextAt ? nextRunWords(schedule.nextAt, now, timeZone) : null,
    last: schedule.lastRunAt ? `Last ran ${formatRecent(schedule.lastRunAt, now, timeZone)}` : null,
  };
}

/**
 * One of the agent's own schedules, under Only tells you: it only tells the person something, on at once. The switch
 * pauses and resumes it (renews one that ran its 90 days); Remove ends it, after asking.
 */
export function ScheduleRow({
  schedule,
  timeZone,
  now,
  busy,
  onSwitch,
  onRemove,
  onTalk,
}: {
  schedule: AgentScheduleView;
  timeZone: string;
  now: Date;
  busy: boolean;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
  /** Its thread, where it was made; absent: none. */
  onTalk?: () => void;
}) {
  const words = scheduleRowWords(schedule, timeZone, now);
  const on = schedule.status === 'active';
  return (
    <div
      className={styles.scheduleRow}
      data-schedule-row={schedule.id}
      data-schedule-status={schedule.status}
    >
      <div className={styles.listMain}>
        <span className={styles.listHead}>
          <SourceTile burrow="" tile={SCHEDULE_TILE} size="mark" />
          <span className={styles.listName}>{words.name}</span>
        </span>
        <span className={styles.listWhen}>{words.when}</span>
        <span className={styles.stateLine}>
          <StateDot tone={on ? 'on' : 'off'} />
          <span className={styles.stateLabel}>{words.state}</span>
          {[words.next, words.last].flatMap((w) =>
            w
              ? [
                  <span key={`${w}-sep`} className={styles.stateSep}>
                    ·
                  </span>,
                  <span key={w} className={styles.stateText}>
                    {w}
                  </span>,
                ]
              : [],
          )}
        </span>
        <div className={styles.rowActions}>
          {onTalk && (
            <Button
              variant="secondary"
              size="sm"
              className={styles.target}
              onClick={onTalk}
              aria-label={`Talk about it: ${words.name}`}
            >
              Talk about it
            </Button>
          )}
          {schedule.status !== 'ended' && (
            <Button
              variant="secondary"
              size="sm"
              className={styles.target}
              disabled={busy}
              onClick={onRemove}
              aria-label={`Remove: ${words.name}`}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <Toggle size="sm" checked={on} disabled={busy} onCheckedChange={onSwitch} aria-label={words.name} />
    </div>
  );
}
