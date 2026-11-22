/**
 * “Update available” (Whombat settings-simplify.md SS-71): a newer build of this app is out (`useAppUpdate`), though
 * nothing needs it yet — the notices that say an update is needed stay as they were (AP-701). A calm card at the top
 * of the Settings tab and of This Whombat: the version and size, and Update, which downloads the APK control hands
 * out inside the app and opens Android's installer on it (AP-813; the sign-in stays). The line under the title follows
 * the download: the progress, allowing installs, “Install”, or why it didn't work. Nothing while this build is the
 * newest. The same row sits under “This app” in the VERSION card (AP-2972).
 */
import type { AndroidDownload } from '@whombat/client/managed';
import { Linking } from 'react-native';
import { installView } from '../managed/appInstall';
import { useManaged } from '../managed/context';
import { COPY } from '../managed/copy';
import { Card, Row } from '../managed/ui';
import { useAppInstall } from '../managed/useAppInstall';
import { useAppUpdate } from '../managed/useAppUpdate';
import { Button } from '../ui/primitives';

export function UpdateRow({ update, first = false }: { update: AndroidDownload; first?: boolean }) {
  const install = useAppInstall();
  const view = install ? installView(install.state, update, COPY.update.install) : null;
  return (
    <Row
      first={first}
      dot="ok"
      dotLabel={COPY.update.available}
      title={COPY.update.available}
      meta={view?.meta ?? COPY.update.availableMeta(update.version, update.size)}
      action={
        <Button
          label={view?.label ?? COPY.update.install}
          variant="secondary"
          busy={view?.busy}
          onPress={() =>
            install ? void install.start(update) : void Linking.openURL(update.url).catch(() => {})
          }
        />
      }
    />
  );
}

export function UpdateCard() {
  const update = useAppUpdate(useManaged()?.updates);
  if (!update) return null;
  return (
    <Card>
      <UpdateRow first update={update} />
    </Card>
  );
}
