import { INBOX_WORDS, newCountLabel, type InboxRow as Row, SETTLE_WORDS } from '@whombat/client';
import { Check, Mail, MailOpen } from 'lucide-react';
import { type MouseEvent, memo } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import styles from './ChatRoomScreen.module.css';
import { ThreadIcon } from './ThreadIcon';

/**
 * A row's name for screen readers: its title, its repository when the title doesn't say it, how much is new, whether it
 * waits for the person and whether the assistant is at it (the icon's corners say the last two to the eye).
 */
export function rowLabel(
  row: Pick<Row, 'title' | 'unread' | 'waiting'> & Partial<Pick<Row, 'working' | 'repoName' | 'titleTail'>>,
): string {
  return [
    row.title,
    row.repoName && !row.titleTail ? row.repoName : null,
    row.unread > 0 ? newCountLabel(row.unread) : null,
    row.waiting ? INBOX_WORDS.waitingForYou.toLowerCase() : null,
    row.working && !row.waiting ? INBOX_WORDS.working.toLowerCase() : null,
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
}

/**
 * One thread in Chat's or Feedback's list (Whombat chat-inbox.md CIB-01, CIB-04; app chat-inbox-web.md): an icon that
 * says what the thread is about, with a blue dot on it when something is new and a small turning ring while the
 * assistant works; then its title (a repository's name at its end quieter) and time, and up to two lines of the newest
 * reply (“You: …”, a reporter's name; none before the assistant's own) with “Waiting for you” in front when something
 * waits, and the count of new messages. Something new: a bold title, the time in blue and the count. On hover or
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
}: InboxRowProps) {
  const unread = row.unread > 0;
  const lineId = `inbox-line-${row.rootId}`;
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
        aria-describedby={row.waiting || row.line ? lineId : undefined}
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
        <ThreadIcon burrow={burrow} row={row} fresh={unread} working={row.working} />
        <span className={styles.words}>
          <span className={styles.r1}>
            <span className={styles.title}>
              {row.titleHead}
              {row.titleTail ? <span className={styles.tail}>{row.titleTail}</span> : null}
            </span>
            <span className={styles.time}>{row.when}</span>
          </span>
          {row.waiting || row.line || unread ? (
            <span className={styles.r2}>
              <span className={styles.line} id={row.waiting || row.line ? lineId : undefined}>
                {row.waiting ? <span className={styles.waiting}>{INBOX_WORDS.waitingForYou}</span> : null}
                {row.waiting && row.line ? ' ' : null}
                {row.line && row.who ? (
                  // The assistant's own replies go without its name for the eye (its face is on the row); a screen
                  // reader still hears who wrote.
                  <b className={row.shownWho ? styles.who : styles.srOnly}>{row.who}: </b>
                ) : null}
                {row.line}
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
