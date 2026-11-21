import { type Activity, type ActivityStatus, auditLinkLabel, formatClock, type LinkRef } from '@whombat/core';
import { Check, ChevronRight, CircleDashed, Hourglass, X } from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import { cx } from '../../components/cx';
import { ICON_STROKE } from '../../components/Icon';
import { EmptyNote } from '../../components/ListState';
import { cap } from '../plans/StepMarker';
import styles from './ActivityFeed.module.css';
import { activityFeed, hiddenEntries, objectText, STATUS_LABEL, STATUS_TONE } from './activityModel';

export interface ActivityFeedProps {
  activities: readonly Activity[];
  timeZone: string;
  /** Where a row's link opens (an approval, a run); rows without links have none. */
  linkHref?: (link: LinkRef) => string;
  onNavigate?: (href: string) => void;
  /** A tighter feed (the Inbox's NEEDS YOU rows): no times, smaller rows. */
  compact?: boolean;
  className?: string;
}

/**
 * Observed activity (work-supervision WS-13…WS-17): one row per action, outcome first. Failures, edits, commands,
 * permissions and Whombat actions stay single rows; consecutive finished reads and searches of a turn fold into a
 * group (“Read 4 files”) that opens. A row with evidence opens to its redacted input and output tail in a code
 * block. Interrupted rows are muted, never shown as done.
 */
export function ActivityFeed({
  activities,
  timeZone,
  linkHref,
  onNavigate,
  compact = false,
  className,
}: ActivityFeedProps) {
  const { entries, empty } = activityFeed(activities);
  const [all, setAll] = useState(false);
  if (empty) return <EmptyNote className={cx(styles.empty, className)}>{empty}</EmptyNote>;
  // A long turn shows its latest entries; the earlier ones one click away (WS-17 noise, AP-95).
  const hidden = all ? 0 : hiddenEntries(entries.length);
  const shown = hidden ? entries.slice(hidden) : entries;
  return (
    <ol className={cx(styles.feed, compact && styles.compact, className)} aria-label="Activity">
      {hidden > 0 && (
        <li>
          <button type="button" className={styles.earlier} onClick={() => setAll(true)}>
            {`Show ${hidden} earlier`}
          </button>
        </li>
      )}
      {shown.map((entry) =>
        entry.type === 'row' ? (
          <li key={entry.activity.id}>
            <ActivityRow
              activity={entry.activity}
              timeZone={timeZone}
              linkHref={linkHref}
              onNavigate={onNavigate}
              compact={compact}
            />
          </li>
        ) : (
          <li key={`group:${entry.items[0]?.id}`}>
            <details className={styles.group}>
              <summary className={styles.summary}>
                <StatusMark status="done" />
                <span className={styles.main}>
                  <span className={styles.title}>{entry.title}</span>
                </span>
                <ChevronRight
                  className={styles.chevron}
                  size={14}
                  strokeWidth={ICON_STROKE}
                  aria-hidden="true"
                />
                {!compact && entry.items[0] && (
                  <time className={styles.time} dateTime={entry.items[0].startedAt}>
                    {formatClock(entry.items[0].startedAt, timeZone)}
                  </time>
                )}
              </summary>
              <ol className={styles.groupItems}>
                {entry.items.map((a) => (
                  <li key={a.id}>
                    <ActivityRow activity={a} timeZone={timeZone} compact />
                  </li>
                ))}
              </ol>
            </details>
          </li>
        ),
      )}
    </ol>
  );
}

function StatusMark({ status }: { status: ActivityStatus }) {
  const tone = STATUS_TONE[status];
  const icon =
    status === 'done' ? (
      <Check size={13} strokeWidth={2.25} aria-hidden="true" />
    ) : status === 'failed' ? (
      <X size={13} strokeWidth={2.25} aria-hidden="true" />
    ) : status === 'waiting' ? (
      <Hourglass size={12} strokeWidth={2} aria-hidden="true" />
    ) : status === 'interrupted' ? (
      <CircleDashed size={13} strokeWidth={2} aria-hidden="true" />
    ) : (
      <span className={styles.liveDot} />
    );
  return (
    <span
      className={cx(styles.mark, styles[`tone${cap(tone)}`])}
      role="img"
      aria-label={STATUS_LABEL[status]}
    >
      {icon}
    </span>
  );
}

function ActivityRow({
  activity: a,
  timeZone,
  linkHref,
  onNavigate,
  compact,
}: {
  activity: Activity;
  timeZone: string;
  linkHref?: (link: LinkRef) => string;
  onNavigate?: (href: string) => void;
  compact: boolean;
}) {
  const object = objectText(a.object);
  const href = a.link && linkHref ? linkHref(a.link) : null;
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || !href || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    event.preventDefault();
    onNavigate(href);
  };
  const head = (
    <>
      <StatusMark status={a.status} />
      <span className={styles.main}>
        <span className={styles.line}>
          <span className={styles.title}>{a.title}</span>
          {a.detail && (
            <span className={cx(styles.detail, styles[`tone${cap(STATUS_TONE[a.status])}`])}>{a.detail}</span>
          )}
        </span>
        {object && object !== a.detail && <span className={styles.object}>{object}</span>}
      </span>
      {a.evidence && (
        <ChevronRight className={styles.chevron} size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      )}
      {!compact && (
        <time className={styles.time} dateTime={a.startedAt}>
          {formatClock(a.startedAt, timeZone)}
        </time>
      )}
    </>
  );
  const link =
    href && a.link ? (
      <a href={href} className={styles.link} onClick={follow}>
        {auditLinkLabel(a.link)}
      </a>
    ) : null;
  const rowClass = cx(
    styles.row,
    a.status === 'interrupted' && styles.interrupted,
    a.important && styles.important,
  );

  if (!a.evidence)
    return (
      <div className={rowClass} data-status={a.status}>
        <div className={styles.summary}>{head}</div>
        {link && <div className={styles.after}>{link}</div>}
      </div>
    );
  return (
    <details className={rowClass} data-status={a.status}>
      <summary className={styles.summary}>{head}</summary>
      <div className={styles.evidence}>
        <pre className={styles.code}>
          {a.evidence.input && (
            <span className={styles.codeInput}>
              {a.kind === 'command' ? '$ ' : ''}
              {a.evidence.input}
              {'\n'}
            </span>
          )}
          {a.evidence.output && <span className={styles.codeOutput}>{a.evidence.output}</span>}
          {!a.evidence.output && <span className={styles.codeQuiet}>No output reported.</span>}
        </pre>
        {a.evidence.truncated && (
          <span className={styles.truncated}>Shortened: this is the end of the output.</span>
        )}
      </div>
      {link && <div className={styles.after}>{link}</div>}
    </details>
  );
}
