/** Recovery shared by every device: check the identity before opening a session or sending a signature. */
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import { pinnedRecord, trustDecision } from './pin';
import {
  type RecoveryEnrollRequest,
  type RecoveryErrorKey,
  recoveryEnrollRequest,
  recoveryErrorKey,
} from './recovery';
import type { KnownAppliance } from './registry';

export type RecoveryResult =
  | { kind: 'recovered'; known: KnownAppliance }
  | { kind: 'changed' | 'mismatch' | 'missing' }
  | { kind: 'error'; error: RecoveryErrorKey };

export async function recoverAppliance(input: {
  device: string;
  orgId: string;
  name: string | null;
  directoryPeerId: string;
  known: KnownAppliance | null;
  namedPeerId: string | null;
  secretKeyHex: string;
  accountId: string;
  endpointPeerId: string;
  endpoint: RecoveryEnrollRequest['endpoint'];
  openSession: (peerId: string) => Promise<ApplianceSession>;
}): Promise<RecoveryResult> {
  const decision = trustDecision({
    pinned: input.known?.peerId ?? null,
    named: input.namedPeerId,
    directory: input.directoryPeerId,
  });
  if (decision.kind !== 'pin') return { kind: decision.kind };
  let session: ApplianceSession | null = null;
  try {
    session = await input.openSession(decision.peerId);
    const enrolled = await sessionOps.recoveryEnroll(
      session,
      recoveryEnrollRequest({
        secretKeyHex: input.secretKeyHex,
        appliancePeerId: decision.peerId,
        endpointPeerId: input.endpointPeerId,
        accountId: input.accountId,
        endpoint: input.endpoint,
      }),
    );
    const known = decision.isNew
      ? pinnedRecord({
          device: input.device,
          orgId: input.orgId,
          name: input.name,
          peerId: decision.peerId,
          source: 'kit',
        })
      : (input.known as KnownAppliance);
    return { kind: 'recovered', known: { ...known, enrolled: true, accountId: enrolled.accountId } };
  } catch (error) {
    return { kind: 'error', error: recoveryErrorKey(error) };
  } finally {
    session?.close();
  }
}
