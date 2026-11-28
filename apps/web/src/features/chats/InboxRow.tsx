import { newCountLabel, type InboxRow as Row, rowStatusSpoken, rowStatusWords } from '@whombat/client';
import { Check, Mail, MailOpen } from 'lucide-react';
import { type MouseEvent, memo } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { INBOX_WORDS, SETTLE_WORDS } from '../../i18n/shared';
import styles from './ChatRoomScreen.module.css';
import { ThreadIcon } from './ThreadIcon';

/**
 * A row's name for screen readers: its title, its repository when the title doesn't say it, how much is new, and where
 * it stands (“waiting for you”, “T3 Code is working”, “done”; the icon's corner says it to the eye).
 */
export function rowLabel(
  row: Pick<Row, 'title' | 'unread' | 'waiting'> &
    Partial<Pick<Row, 'working' | 'repoName' | 'titleTail' | 'status'>>,
): string {
  const stands = row.status
    ? rowStatusSpoken(row.status)
    : row.waiting
      ? INBOX_WORDS.waitingForYou.toLowerCase()
      : row.working
        ? INBOX_WORDS.working.toLowerCase()
        : null;
  return [
    row.title,
    row.repoName && !row.titleTail ? row.repoName : null,
    row.unread > 0 ? newCountLabel(row.unread) : null,
    stands,
  ]
    .filter(Boolean)
    .join(', ');
}

export interface InboxRowProps {
  burrow: string;
  row: Row;
  /** Its thread is open beside the list. */
  selected: boolean;
  /** Settle shows on it: it may settle and the open threads have answered. */
  canSettle: boolean;
  /** Opening the row (a click or Enter on it). */
  onOpen: (row: Row, event: MouseEvent<HTMLAnchorElement>) => void;
  onSettle: (row: Row) => void;
  onMarkUnread: (row: Row) => void;
  onMarkRead: (row: Row) => void;
  /** The clock for a T3 Code job's minutes. */
  nowMs: number;
}

/**
 * One thread in Chat's or Feedback's list (Whombat chat-inbox.md CIB-01, CIB-04; app chat-inbox-web.md): an icon that
 * says what the thread is about, with a blue dot on it when something is new and its status's mark on its bottom corner;
 * then its title (a repository's name at its end quieter) and time, and up to two lines of the newest reply (“You: …”,
 * a reporter's name; none before the assistant's own), or what T3 Code does now, with where it stands in front
 * (“Waiting for you”, “T3 Code is working · 6m”, “Done”), and the count of new messages. Something new: a bold title, the time in blue and the count. On hover or
 * keyboard focus a small toolbar offers Settle and Mark as unread or read. The row is a real link to its thread.
 */
export const InboxRow = memo(function InboxRow({
  burrow,
  row,
  selected,
  canSettle,
  onOpen,
  onSettle,
  onMarkUnread,
  onMarkRead,
  nowMs,
}: InboxRowProps) {
  const unread = row.unread > 0;
  const lineId = `inbox-line-${row.rootId}`;
  const status = row.status;
  // What T3 Code does now (or what it asks the person to approve) stands in for the newest reply.
  const line = status?.line ?? row.line;
  const who = status?.line ? null : row.who;
  const shownWho = status?.line ? null : row.shownWho;
  return (
    <li
      className={cx(styles.row, unread && styles.unread, selected && styles.selected)}
      data-root-id={row.rootId}
      data-unread={unread || undefined}
    >
      <a
        href={row.href}
        className={styles.open}
        aria-label={rowLabel(row)}
        aria-describedby={status || line ? lineId : undefined}
        aria-current={selected ? 'true' : undefined}
        data-inbox-row=""
        data-selected={selected || undefined}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.button !== 0
          )
            return;
          event.preventDefault();
          onOpen(row, event);
        }}
      >
        <ThreadIcon burrow={burrow} row={row} fresh={unread} status={status?.kind ?? null} />
        <span className={styles.words}>
          <span className={styles.r1}>
            <span className={styles.title}>
              {row.titleHead}
              {row.titleTail ? <span className={styles.tail}>{row.titleTail}</span> : null}
            </span>
            <span className={styles.time}>{row.when}</span>
          </span>
          {status || line || unread ? (
            <span className={styles.r2}>
              <span className={styles.line} id={status || line ? lineId : undefined}>
                {status ? (
                  <span className={styles.status} data-status={status.kind} data-row-status={status.kind}>
                    {rowStatusWords(status, nowMs)}
                  </span>
                ) : null}
                {status && line ? ' ' : null}
                {line && who ? (
                  // The assistant's own replies go without its name for the eye (its face is on the row); a screen
                  // reader still hears who wrote.
                  <b className={shownWho ? styles.who : styles.srOnly}>{who}: </b>
                ) : null}
                {line}
              </span>
              {unread ? (
                <span className={styles.count} aria-hidden="true">
                  {row.unread > 99 ? '99+' : row.unread}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </a>
      {canSettle || row.markable ? (
        // biome-ignore lint/a11y/useSemanticElements: a small group of buttons, not a form's fieldset
        <div className={styles.acts} role="group" aria-label={`${row.title}: actions`}>
          {canSettle ? (
            <button
              type="button"
              className={styles.act}
              aria-label={SETTLE_WORDS.settle}
              title={`${SETTLE_WORDS.settle} (E)`}
              onClick={() => onSettle(row)}
              data-row-settle=""
            >
              <Icon icon={Check} size={15} />
            </button>
          ) : null}
          {row.markable ? (
            unread ? (
              <button
                type="button"
                className={styles.act}
                aria-label={INBOX_WORDS.markRead}
                title={`${INBOX_WORDS.markRead} (U)`}
                onClick={() => onMarkRead(row)}
                data-row-read=""
              >
                <Icon icon={MailOpen} size={15} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.act}
                aria-label={INBOX_WORDS.markUnread}
                title={`${INBOX_WORDS.markUnread} (U)`}
                onClick={() => onMarkUnread(row)}
                data-row-unread=""
              >
                <Icon icon={Mail} size={15} />
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
});
