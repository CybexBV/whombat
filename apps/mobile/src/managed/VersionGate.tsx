/**
 * The one version check (HE-52; hermes-engine-app.md AP-5375): a box on another protocol major refused this app — the
 * app is behind (“This app needs an update”, with the app's own update) or the box is (“This Whombat needs an update”).
 * The words are the contracts' (`VERSION_REFUSAL_COPY`, in `COPY.connection`).
 */
import type { ReactNode } from 'react';
import { COPY } from './copy';
import { GateScreen } from './screens';
import { UpdateAppButton } from './UpdateAppButton';

export function VersionGate({ who, back }: { who: 'client' | 'appliance'; back: ReactNode }) {
  if (who === 'appliance')
    return (
      <GateScreen
        title={COPY.connection.applianceTooOldTitle}
        text={COPY.connection.applianceTooOld}
        actions={back}
      />
    );
  return (
    <GateScreen
      title={COPY.connection.clientTooOldTitle}
      text={COPY.connection.clientTooOld}
      actions={
        <>
          <UpdateAppButton size="lg" withNote />
          {back}
        </>
      }
    />
  );
}
