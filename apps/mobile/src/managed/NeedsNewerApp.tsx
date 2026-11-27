/**
 * A security view this app can't read (AP-266): devices, passkeys — “This needs a newer version of the app.” and the way
 * to get one (the app downloads and installs it itself, AP-813; the Mobile app page on the iPhone, AP-537), or, while
 * no newer build is out, that it is on its way (AP-701). Never a list with something left out.
 */

import { NEEDS_NEWER_APP } from '@whombat/client';
import { View } from 'react-native';
import { useI18n } from '../i18n';
import { QuietText } from '../ui/primitives';
import { useManaged } from './context';
import { managedCopy } from './copy';
import { UpdateAppButton } from './UpdateAppButton';
import { useAppUpdate } from './useAppUpdate';

export function NeedsNewerApp({ inline }: { inline?: boolean }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const newer = useAppUpdate(useManaged()?.updates) !== null;
  return (
    <View
      style={
        inline
          ? { padding: 16, gap: 12 }
          : { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 }
      }
    >
      <QuietText style={{ paddingVertical: 0 }}>
        {`${NEEDS_NEWER_APP} ${newer ? managedCopyHere.update.phoneTooOld : managedCopyHere.update.soon}`}
      </QuietText>
      {newer ? <UpdateAppButton variant="secondary" withNote /> : null}
    </View>
  );
}
