import { SETTLED_PAGE, settledMeta, type ThreadRow, threadIconFields, threadRows } from '@whombat/client';
import { useChatPreferences, useChatRooms, useChatThreads } from '@whombat/client/react';
import type { ChatRoom } from '@whombat/core';
import { Undo2 } from 'lucide-react';
import type { MouseEvent } from 'react';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { CHAT_WORDS, SETTLE_WORDS } from '../../i18n/shared';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import styles from './SettledPane.module.css';
import { SubjectChip } from './SubjectChip';
import { ThreadIcon } from './ThreadIcon';
import { useSettle } from './useSettle';

/**
 * A room's settled threads (Whombat chat-settle.md CHS-10; app chat-settle.md AP-6153, AP-6250, AP-6252): the head's
 * “Settled”, in the right pane, since the room itself shows only open threads. The latest settled first, ten at a time
 * with “Show more”. Each row is the icon it has in the list (its repository's, the thing it is about, else the
 * assistant's face), its first line, its subject chip and how it settled; hovering it offers ↶ Open again, which puts
 * it back in the room. A row opens its thread in the same place.
 */
export function SettledPane({
  burrow,
  room,
  onOpen,
  onClose,
}: {
  burrow: string;
  room: ChatRoom;
  onOpen: (rootId: string) => void;
  onClose: () => void;
}) {
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const rooms = useChatRooms(burrow);
  const ref = rooms[room];
  const shelf = useChatThreads(burrow, room, {
    conversationId: ref?.id,
    enabled: rooms.known && !!ref,
    state: 'settled',
    limit: SETTLED_PAGE,
  });
  const { settleQuietDays } = useChatPreferences(burrow);
  const { openAgain } = useSettle(burrow);
  const open = (rootId: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onOpen(rootId);
  };

  const iconOf = new Map(shelf.threads.map((t) => [t.rootId, threadIconFields(t)]));
  const row = (r: ThreadRow) => {
    const icon = iconOf.get(r.rootId);
    return (
      <li key={r.rootId} className={styles.item}>
        <a href={r.href} className={styles.row} onClick={open(r.rootId)} data-thread-row={r.rootId}>
          {icon ? <ThreadIcon burrow={burrow} row={icon} size={32} /> : null}
          <span>
            <span className={styles.text}>
              <span className={styles.words}>{r.text || 'A thread'}</span>
              {r.subject && <SubjectChip burrow={burrow} subject={r.subject} link={false} />}
            </span>
            <span className={styles.meta}>
              {r.settled ? settledMeta(r.settled, now, timeZone, settleQuietDays) : r.when}
            </span>
          </span>
        </a>
        <button
          type="button"
          className={styles.act}
          aria-label={SETTLE_WORDS.openAgain}
          title={SETTLE_WORDS.openAgain}
          onClick={() => openAgain(room, r.rootId)}
          data-thread-open-again=""
        >
          <Icon icon={Undo2} size={15} />
        </button>
      </li>
    );
  };

  return (
    <div className={styles.pane} data-screen="settled">
      <div className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>{SETTLE_WORDS.settled}</h2>
          <span className={styles.context}>{CHAT_WORDS[room]}</span>
        </div>
        <IconButton label="Close settled threads" onClick={onClose}>
          <Icon name="close" size={16} />
        </IconButton>
      </div>
      <div className={styles.body}>
        {shelf.error && !shelf.threads.length ? (
          <ErrorNote message="Couldn’t load the settled threads. Try again." onRetry={shelf.refetch} />
        ) : !rooms.known || shelf.isLoading ? (
          <SkeletonRows count={5} avatarSize={28} lines={2} />
        ) : !shelf.threads.length ? (
          <p className={styles.empty}>{SETTLE_WORDS.noneSettled}</p>
        ) : (
          <>
            <ul className={styles.list} aria-label={`${SETTLE_WORDS.settled} in ${CHAT_WORDS[room]}`}>
              {threadRows(shelf.threads, now, timeZone).map(row)}
            </ul>
            {shelf.hasMore && (
              <button
                type="button"
                className={styles.showMore}
                disabled={shelf.loadingMore}
                onClick={shelf.loadMore}
              >
                {shelf.loadingMore ? 'Loading…' : SETTLE_WORDS.showMore}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
