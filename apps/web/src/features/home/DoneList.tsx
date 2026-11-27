import { type DoneRow, doneRows } from '@whombat/client';
import { useTheAgent, useUndoRequests } from '@whombat/client/react';
import type { ChangeEntry } from '@whombat/core';
import { Check, Undo2 } from 'lucide-react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useWebI18n } from '../../i18n/provider';
import { AppLink } from '../files/AppLink';
import { useBurrowContext } from '../messaging/useRoom';
import styles from './Home.module.css';
import { useUndo } from './useHomeActions';

/**
 * The rows of Everything I did and a thing page's “Changes here” (Home has no Done recently since AP-2269): a change
 * a person made says whose it is (“You”, or their name; Whombat HR-05, app home-redesign.md AP-2213). The time and the
 * action share one column of a fixed width, so the times line up whether a row has Undo, Review or nothing (AP-2214).
 */
export function DoneList({
  burrow,
  changes,
  now,
  timeZone,
  empty,
  here,
}: {
  burrow: string;
  changes: readonly ChangeEntry[];
  now: number;
  timeZone: string;
  empty: string;
  /** The page the list is on: a change linking to it gets no Review (AP-4573). */
  here?: string;
}) {
  const { tag: uiLocale } = useWebI18n();
  const undo = useUndo(burrow);
  const { me } = useBurrowContext(burrow);
  const { agent: assistant } = useTheAgent(burrow);
  const requests = useUndoRequests(burrow);
  const rows = doneRows(changes, now, timeZone, {
    locale: uiLocale,
    viewerId: me?.id,
    requests,
    assistantName: assistant?.name,
    here,
  });
  if (rows.length === 0) return <p className={styles.quiet}>{empty}</p>;
  return (
    <ul className={styles.list}>
      {rows.map((row) => (
        <DoneItem
          key={row.id}
          row={row}
          busy={undo.busy === row.id}
          onUndo={() => void undo.run(row.change)}
        />
      ))}
    </ul>
  );
}

function DoneItem({ row, busy, onUndo }: { row: DoneRow; busy: boolean; onUndo: () => void }) {
  return (
    <li className={cx(styles.did, row.undone && styles.didUndone)} data-change={row.id}>
      <span className={styles.ck} aria-hidden="true">
        <Icon icon={Check} size={15} />
      </span>
      <div className={styles.didText}>
        <b>{row.title}</b>
        {row.requested ? (
          <small>
            {row.requested.href ? (
              <AppLink href={row.requested.href} className={styles.requested}>
                {row.requested.text}
              </AppLink>
            ) : (
              row.requested.text
            )}
          </small>
        ) : row.by || row.detail ? (
          <small>{[row.by, row.detail].filter(Boolean).join(' · ')}</small>
        ) : null}
      </div>
      <span className={styles.r}>
        <time dateTime={row.change.at} className={styles.rWhen}>
          {row.when}
        </time>
        {row.action === 'undo' ? (
          <button
            type="button"
            className={styles.undo}
            onClick={onUndo}
            disabled={busy}
            aria-label={`Undo: ${row.title}`}
          >
            <Icon icon={Undo2} size={15} />
            Undo
          </button>
        ) : row.action === 'review' && row.href ? (
          <AppLink href={row.href} className={styles.undo} aria-label={`Review: ${row.title}`}>
            Review
          </AppLink>
        ) : row.undone ? (
          <span className={styles.undoneWord}>Undone</span>
        ) : null}
      </span>
    </li>
  );
}
