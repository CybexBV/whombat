import { Link } from '@tanstack/react-router';
import { cx } from '../../components/cx';
import { PLACES_WORDS } from '../../i18n/shared';
import { INBOX_PATH } from './location';
import styles from './NeedsYouBarLink.module.css';

/**
 * The narrow screen's top bar (final-shell-web.md): while the sidebar is the Places drawer its Inbox badge can't be
 * seen, so the bar's end says “3 need you ›”, a 44px link to the Inbox, its full name said once (“3 things need you,
 * open Inbox”). Red only when one of them isn't working. Nothing when nothing does.
 */
export function NeedsYouBarLink({ count, broken }: { count: number | null; broken: boolean }) {
  if (!count) return null;
  return (
    <Link
      to={INBOX_PATH}
      className={cx(styles.link, broken && styles.bad)}
      aria-label={PLACES_WORDS.needYouLabel(count)}
      data-needs-you-bar=""
    >
      <span className={styles.count}>{count}</span>
      <span>{PLACES_WORDS.needYou}</span>
      <span aria-hidden="true">›</span>
    </Link>
  );
}
