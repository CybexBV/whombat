/**
 * The pop-up for a newer app (update-check.md): when the app finds a newer APK than this build, a sheet says so once
 * for that version, with Update (the same in-app download and install as the Settings card) and Later. Later, or
 * closing it, holds until the next version; the Settings card and the tab's dot stay. Showing it also clears the
 * notification the background check may have posted for that version. Android only, and only in a build that
 * remembers what it showed (`whombat-updater`).
 */

import type { AndroidDownload } from '@whombat/client/managed';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { WhombatUpdater } from '../../modules/whombat-updater';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { installView } from './appInstall';
import { type AppUpdateSource, updateToAnnounce } from './appUpdate';
import { managedCopy } from './copy';
import { useAppInstall } from './useAppInstall';
import { useAppUpdate } from './useAppUpdate';

export function AppUpdatePrompt({ control }: { control: AppUpdateSource }) {
  const update = useAppUpdate(control);
  const [shown, setShown] = useState<AndroidDownload | null>(null);
  useEffect(() => {
    if (shown) return;
    const next = updateToAnnounce(update, WhombatUpdater.updateSeen());
    if (!next) return;
    WhombatUpdater.markUpdateSeen(next.versionCode);
    setShown(next);
  }, [update, shown]);
  return shown ? <UpdateSheet update={shown} onClose={() => setShown(null)} /> : null;
}

function UpdateSheet({ update, onClose }: { update: AndroidDownload; onClose: () => void }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const theme = useTheme();
  const install = useAppInstall();
  const view = install ? installView(install.state, update, managedCopyHere.update.install, rawLocale) : null;
  const going = view !== null && view.label !== managedCopyHere.update.install;
  return (
    <Sheet
      visible
      onClose={onClose}
      label={managedCopyHere.update.newTitle}
      closeLabel={managedCopyHere.update.later}
    >
      <View style={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}>
        <View style={{ gap: 4 }}>
          <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
            {managedCopyHere.update.newTitle}
          </Text>
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {going ? view.meta : managedCopyHere.update.newLead(update.version, update.size)}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={managedCopyHere.update.later}
            variant="secondary"
            onPress={onClose}
            style={{ flex: 1 }}
          />
          <Button
            label={view?.label ?? managedCopyHere.update.install}
            busy={view?.busy}
            onPress={() => void install?.start(update)}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Sheet>
  );
}
