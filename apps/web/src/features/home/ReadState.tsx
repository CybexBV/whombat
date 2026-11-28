/**
 * How a page says what it read (docs/decisions/overview-server-connection-final.md), shared by a server's page, a
 * connection's page and a pinned widget: each reading's own time (“Read 12 min ago”, the moment in full for a screen
 * reader), the note after a refresh failed (the saved readings stay under it) or the first read failed (nothing saved
 * to show), with Try again — which only reads again — and what the app said folded under More detail.
 */
import { readingTime } from '@whombat/client';
import { hostErrorInfo } from '@whombat/client/hosts';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { MoreDetail } from '../../components/MoreDetail';
import { currentLocale } from '../../i18n/provider';
import { useOverviewWords } from '../../i18n/words';
import styles from './ReadState.module.css';

/** “Read 12 min ago” with a clock, from the thing's own report; “Reading time unknown” without one. */
export function ReadTime({
  at,
  now,
  timeZone,
  className,
}: {
  at: string | null | undefined;
  now: number;
  timeZone: string;
  className?: string;
}) {
  const t = readingTime(at, now, timeZone, currentLocale());
  return (
    <span className={cx(styles.readTime, className)} title={t.known ? t.exact : undefined}>
      <Icon icon={Clock} size={13} />
      <span aria-hidden={t.known ? true : undefined}>{t.text}</span>
      {t.known ? <span className={styles.srOnly}>{t.exact}</span> : null}
    </span>
  );
}

/**
 * The note when a read failed: its title in the warn colour (a failed read isn't a broken thing), what is shown under
 * it, Try again and, when there is one, Ask {assistant}; what the app said under More detail.
 */
export function ReadNote({
  title,
  body,
  error,
  onRetry,
  ask,
  busy = false,
  className,
}: {
  title: string;
  body: ReactNode;
  error?: unknown;
  onRetry: () => void;
  ask?: { label: string; onAsk: () => void } | null;
  busy?: boolean;
  className?: string;
}) {
  const OVERVIEW_WORDS = useOverviewWords();
  const detail = error ? hostErrorInfo(error, currentLocale()).message : null;
  return (
    <section className={cx(styles.note, className)} role="alert" aria-label={title}>
      <h2 className={styles.noteTitle}>{title}</h2>
      <p className={styles.noteBody}>{body}</p>
      <div className={styles.noteActs}>
        <Button variant="primary" onClick={onRetry} disabled={busy}>
          {OVERVIEW_WORDS.tryAgain}
        </Button>
        {ask ? <Button onClick={ask.onAsk}>{ask.label}</Button> : null}
      </div>
      <MoreDetail detail={detail} className={styles.noteMore} />
    </section>
  );
}
