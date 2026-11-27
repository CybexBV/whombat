/**
 * The push side of a managed Whombat, on its own row (assignment §12: push delivery is not the session): on,
 * off, not allowed in the system settings, not available in this build, or not set up yet — and when the last
 * notification arrived, whether or not the app was open. On Android it also says what Android holds back although
 * notifications are allowed (a channel turned off, the app's battery use restricted), with a button to the page that
 * turns it back on (`useDelivery.ts`). In the settings sheet's Notifications group it is labelled ON THIS PHONE (SS-30),
 * next to Do not disturb.
 */
import { useI18n } from '../i18n';
import { Button } from '../ui/primitives';
import { communityNotificationsView } from './community';
import type { ManagedPush } from './context';
import { managedCopy } from './copy';
import { notificationsView } from './pushView';
import { Card, Row } from './ui';
import { useDeliveryStatus } from './useDelivery';

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
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const noPush =
    community &&
    push.state.status === 'unavailable' &&
    (push.state.reason === 'link_off' || push.state.reason === 'community');
  const delivery = useDeliveryStatus();
  const v = noPush
    ? communityNotificationsView(rawLocale)
    : notificationsView(push, Date.now(), delivery.status, rawLocale);
  const page = 'page' in v ? v.page : undefined;
  return (
    <Card label={label ?? managedCopyHere.notifications.label}>
      <Row
        first
        dot={v.dot}
        title={v.title}
        meta={v.meta}
        action={
          v.action === 'settings' ? (
            <Button
              label={managedCopyHere.notifications.openSettings}
              variant="secondary"
              onPress={push.openSettings}
            />
          ) : v.action === 'delivery' && page ? (
            <Button
              label={managedCopyHere.notifications.openSettings}
              variant="secondary"
              onPress={() => delivery.open(page)}
            />
          ) : v.action === 'enable' ? (
            <Button label={managedCopyHere.notifications.turnOn} variant="secondary" onPress={push.enable} />
          ) : v.action === 'alerts' ? (
            <Button
              label={managedCopyHere.notifications.turnOnAlerts}
              variant="secondary"
              onPress={push.enable}
            />
          ) : null
        }
      />
    </Card>
  );
}
