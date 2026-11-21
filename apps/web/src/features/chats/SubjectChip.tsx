import { THING_STATUS_LABELS } from '@whombat/client';
import { useHomeOverview } from '@whombat/client/react';
import { type ChatSubject, thingHref, thingId } from '@whombat/core';
import { cx, variantClass } from '../../components/cx';
import { AppLink } from '../files/AppLink';
import { useThingLinkProps } from '../things/prefetch';
import styles from './SubjectChip.module.css';

/**
 * What a thread is about (Whombat chat-channel.md CHT-05; app chat-channel.md AP-2405): its name in a pill after the
 * first message's text and in the thread's head, with the thing's status dot as the sidebar draws it, linking to the
 * thing's page. A thing the Dashboard doesn't list (gone, not yet read) has a muted dot and no link.
 */
export function SubjectChip({
  burrow,
  subject,
  className,
  link = true,
}: {
  burrow: string;
  subject: ChatSubject;
  className?: string;
  /** False inside another link (a row of the Settled list): the pill alone. */
  link?: boolean;
}) {
  const { data } = useHomeOverview({ params: { burrow } }, { retry: false });
  const thing = data?.things.find((t) => t.id === thingId(subject.kind, subject.id));
  // Its page is read while the pointer rests on the pill (page-speed.md AP-2660).
  const linkProps = useThingLinkProps(burrow);
  const href = thingHref(subject.kind, subject.id);
  const status = thing?.status ?? null;
  const label = status ? THING_STATUS_LABELS[status] : null;
  const content = (
    <>
      <span className={cx(styles.dot, status && variantClass(styles, 'dot', status))} aria-hidden="true" />
      <span className={styles.name}>{subject.name}</span>
    </>
  );
  const title = label ? `About ${subject.name}, ${label.toLowerCase()}` : `About ${subject.name}`;
  return thing && link ? (
    <AppLink
      href={href}
      {...linkProps(href)}
      className={cx(styles.chip, className)}
      title={title}
      aria-label={title}
      data-subject-chip=""
    >
      {content}
    </AppLink>
  ) : (
    <span className={cx(styles.chip, className)} title={title} data-subject-chip="">
      {content}
    </span>
  );
}
