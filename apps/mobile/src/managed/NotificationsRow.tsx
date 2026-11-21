/**
 * The push side of a managed Whombat, on its own row (assignment §12: push delivery is not the session): on,
 * off, not allowed in the system settings, not available in this build, or not set up yet — and when the last
 * notification arrived, whether or not the app was open. In the settings sheet's Notifications group it is labelled
 * ON THIS PHONE (SS-30), next to Do not disturb.
 */
import { Button } from '../ui/primitives';
import { communityNotificationsView } from './community';
import type { ManagedPush } from './context';
import { COPY } from './copy';
import { notificationsView } from './pushView';
import { Card, Row } from './ui';

/**
 * `community`: a box this phone joined without a cloud account sends its pushes through Whombat Link (LNK-36). While it
 * can't (Link off, or a box before Link) the row says so plainly and that the app checks when it opens, with nothing to
 * turn on (AP-5475); otherwise it is the usual row.
 */
export function NotificationsRow({
  push,
  label,
  community = false,
}: {
  push: ManagedPush;
  label?: string;
  community?: boolean;
}) {
  const noPush =
    community &&
    push.state.status === 'unavailable' &&
    (push.state.reason === 'link_off' || push.state.reason === 'community');
  const v = noPush ? communityNotificationsView() : notificationsView(push, Date.now());
  return (
    <Card label={label ?? COPY.notifications.label}>
      <Row
        first
        dot={v.dot}
        title={v.title}
        meta={v.meta}
        action={
          v.action === 'settings' ? (
            <Button label={COPY.notifications.openSettings} variant="secondary" onPress={push.openSettings} />
          ) : v.action === 'enable' ? (
            <Button label={COPY.notifications.turnOn} variant="secondary" onPress={push.enable} />
          ) : null
        }
      />
    </Card>
  );
}
