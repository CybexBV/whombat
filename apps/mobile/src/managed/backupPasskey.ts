/** One passkey setup and sign-in key delivery for the phone. */
import { deliverBackupKey, passkeyName } from '@whombat/client/managed';
import { type BackupPasskeyTap, useOnePasskeySetup } from '@whombat/client/managed/react';
import type { ApplianceSession } from '@whombat/client/session';
import { useEffect } from 'react';
import { useManaged } from './context';
import { phoneLabel } from './env';
import { PASSKEYS } from './passkeyEnv';

export function useBackupPasskeyTap(): BackupPasskeyTap | null {
  const managed = useManaged();
  const s = managed?.session.state();
  return useOnePasskeySetup(
    managed?.control && PASSKEYS?.prf && !managed.community
      ? {
          session: managed.session,
          control: managed.control,
          platform: PASSKEYS,
          appliance: managed.appliancePeerId,
          me: s?.status === 'open' ? (s.info.account?.id ?? null) : null,
          name: passkeyName(phoneLabel()),
          whombats: managed.whombats,
        }
      : null,
  );
}

/** Hands the Whombat the backup key a passkey sign-in held for it, once its session is open. */
export function useDeliverBackupKey(session: ApplianceSession, device: string, open: boolean): void {
  useEffect(() => {
    if (open) void deliverBackupKey(session, device);
  }, [session, device, open]);
}
