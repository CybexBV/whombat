/** One passkey setup and sign-in key delivery for the web. */
import { deliverBackupKey, passkeyName } from '@whombat/client/managed';
import { type BackupPasskeyTap, useOnePasskeySetup } from '@whombat/client/managed/react';
import type { ApplianceSession } from '@whombat/client/session';
import { useEffect } from 'react';
import { useAppServices } from '../app/providers';
import { browserLabel } from './keys';
import { PASSKEYS } from './passkeyEnv';

export function useBackupPasskeyTap(): BackupPasskeyTap | null {
  const { session, managed } = useAppServices();
  const s = session.state();
  return useOnePasskeySetup(
    managed?.control && managed.passkeys && !managed.page
      ? {
          session,
          control: managed.control,
          platform: PASSKEYS,
          appliance: managed.appliancePeerId,
          me: s.status === 'open' ? (s.info.account?.id ?? null) : null,
          name: passkeyName(browserLabel()),
          whombats: managed.whombats,
        }
      : null,
  );
}

/** Hands the Whombat the backup key a passkey sign-in held for it, once its app is open. */
export function useDeliverBackupKey(session: ApplianceSession, device: string): void {
  useEffect(() => {
    void deliverBackupKey(session, device);
  }, [session, device]);
}
