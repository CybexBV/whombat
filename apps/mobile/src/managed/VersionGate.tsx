/**
 * The one version check (HE-52; hermes-engine-app.md AP-5375): a box on another protocol major refused this app — the
 * app is behind (“This app needs an update”, with the app's own update) or the box is (“This Whombat needs an update”).
 * The words are the contracts' (`VERSION_REFUSAL_COPY`, in `COPY.connection`).
 */

import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { managedCopy } from './copy';
import { GateScreen } from './screens';
import { UpdateAppButton } from './UpdateAppButton';

export function VersionGate({ who, back }: { who: 'client' | 'appliance'; back: ReactNode }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  if (who === 'appliance')
    return (
      <GateScreen
        title={managedCopyHere.connection.applianceTooOldTitle}
        text={managedCopyHere.connection.applianceTooOld}
        actions={back}
      />
    );
  return (
    <GateScreen
      title={managedCopyHere.connection.clientTooOldTitle}
      text={managedCopyHere.connection.clientTooOld}
      actions={
        <>
          <UpdateAppButton size="lg" withNote />
          {back}
        </>
      }
    />
  );
}
