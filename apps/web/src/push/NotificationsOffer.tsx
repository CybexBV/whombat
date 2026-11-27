import { useTheAgent } from '@whombat/client/react';
import { Bell } from 'lucide-react';
import { useId } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import styles from './NotificationsOffer.module.css';
import { useWebPush } from './useWebPush';

/** The Chat's one question about notifications, in words a person reads in a glance. */
export const NOTIFICATIONS_OFFER_TEXT = {
  title: (agent: string) => `Get a ping when ${agent} needs you?`,
  line: 'Only for things that need you, like an approval or a backup that failed. You can change this in Settings.',
  turnOn: 'Turn on',
  notNow: 'Not now',
} as const;

/**
 * Asks once, in the Chat, where this browser has never asked about notifications: one reason, Turn on (the browser's
 * own question follows the click) and Not now, which this browser remembers. Nothing shows where notifications can't
 * work here, are on, are blocked, or the person already answered.
 */
export function NotificationsOffer({ burrow }: { burrow: string }) {
  const push = useWebPush();
  const { words } = useTheAgent(burrow);
  const titleId = useId();
  if (!push.offer || push.status !== 'off') return null;
  return (
    <section className={styles.offer} aria-labelledby={titleId} data-notifications-offer="">
      <span className={styles.bell} aria-hidden="true">
        <Icon icon={Bell} size={16} />
      </span>
      <div className={styles.body}>
        <h2 id={titleId} className={styles.title}>
          {NOTIFICATIONS_OFFER_TEXT.title(words.name)}
        </h2>
        <p className={styles.line}>{NOTIFICATIONS_OFFER_TEXT.line}</p>
        <div className={styles.actions}>
          <Button variant="primary" size="sm" onClick={() => void push.enable()}>
            {NOTIFICATIONS_OFFER_TEXT.turnOn}
          </Button>
          <Button variant="secondary" size="sm" onClick={push.dismiss}>
            {NOTIFICATIONS_OFFER_TEXT.notNow}
          </Button>
        </div>
      </div>
    </section>
  );
}
