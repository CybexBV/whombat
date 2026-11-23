/**
 * The Mac's one link to its Find My (docs/implementation/macos/findmy-connection.md §1.5): on a Mac's Summary, a row
 * “Find My” to the page of the Find My connection that reads this Mac (its `mac` field), with that connection's line
 * from Overview (“4 people · read 5 min ago”); nothing when no Find My connection uses the Mac.
 */
import { BrandMark } from '@whombat/brand/react';
import { FIND_MY_WORDS } from '@whombat/client/hosts';
import { useFindMyConnectionOf } from '@whombat/client/hosts/react';
import { useHomeOverview } from '@whombat/client/react';
import { thingId } from '@whombat/core';
import { ChevronRight } from 'lucide-react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { AppLink, Card } from '../parts';
import { useThingLinkProps } from '../prefetch';
import styles from '../Things.module.css';
import fm from './FindMy.module.css';

export function FindMyLink({ burrow, serverId }: { burrow: string; serverId: string }) {
  const link = useFindMyConnectionOf(burrow, serverId);
  const { data } = useHomeOverview({ params: { burrow } }, { retry: false });
  // Its page is read while the pointer rests on the row (page-speed.md AP-2660).
  const linkProps = useThingLinkProps(burrow);
  if (!link) return null;
  const line = data?.things.find((t) => t.id === thingId('connection', link.connectionId))?.line ?? null;
  return (
    <Card id="mac-findmy-link" className={fm.linkCard}>
      <AppLink
        href={link.href}
        className={cx(styles.row, fm.link)}
        aria-label={line ? `${FIND_MY_WORDS.linkTitle}: ${line}` : FIND_MY_WORDS.linkTitle}
        title={FIND_MY_WORDS.linkHint}
        {...linkProps(link.href)}
      >
        <span className={fm.linkMark} aria-hidden="true">
          <BrandMark mark="findmy" size={20} />
        </span>
        <span className={styles.rowMain}>
          <b>{FIND_MY_WORDS.linkTitle}</b>
          {line ? <small>{line}</small> : null}
        </span>
        <Icon icon={ChevronRight} size={16} className={fm.linkChevron} />
      </AppLink>
    </Card>
  );
}
