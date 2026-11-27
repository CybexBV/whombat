/**
 * “Update the app” where an update is needed (AP-261, AP-266, AP-701): with a newer APK published and the native
 * updater in this build, the app downloads and installs it itself (AP-813), the button showing the progress, then
 * “Allow installs” or “Install” or “Try again”; `withNote` says why under it. Otherwise (the iPhone, nothing newer
 * published, a build without the updater) it opens the hosted UI's Mobile app page (AP-537).
 */

import { Linking, View } from 'react-native';
import { useI18n } from '../i18n';
import { Button, QuietText } from '../ui/primitives';
import { installView } from './appInstall';
import { UPDATE_URL } from './config';
import { useManaged } from './context';
import { managedCopy } from './copy';
import { useAppInstall } from './useAppInstall';
import { useAppUpdate } from './useAppUpdate';

export function UpdateAppButton({
  variant = 'primary',
  size,
  withNote,
}: {
  variant?: 'primary' | 'secondary' | 'quiet';
  size?: 'lg';
  withNote?: boolean;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const update = useAppUpdate(useManaged()?.updates);
  const install = useAppInstall();
  const view = update && install ? installView(install.state, update, managedCopyHere.update.label) : null;
  const button = (
    <Button
      label={view?.label ?? managedCopyHere.update.label}
      variant={variant}
      {...(size ? { size } : {})}
      busy={view?.busy}
      onPress={() =>
        update && install ? void install.start(update) : void Linking.openURL(UPDATE_URL).catch(() => {})
      }
    />
  );
  if (!withNote || !view?.note) return button;
  return (
    <View style={{ gap: 8 }}>
      {button}
      <QuietText style={{ paddingVertical: 0 }}>{view.note}</QuietText>
    </View>
  );
}
