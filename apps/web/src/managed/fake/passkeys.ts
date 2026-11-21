/**
 * Passkeys in the fake world (passkeys.md AP-796): what control and the Whombat check, in the shapes they check it,
 * without the signature (the fake trusts the browser's authenticator, a CDP virtual one in the e2e suite). Both sides
 * read the client data (type and challenge) and the user handle; the Whombat also reads the backup-eligible flag of
 * the authenticator data a registration's JSON carries, for the PK-07 setting.
 */
import { base64urlDecode } from '@whombat/protocol';
import type { OwnerPasskeyRecord } from '@whombat/protocol/session';

export interface FakeControlPasskey {
  id: string;
  name: string;
  appliance: string | null;
  owner?: OwnerPasskeyRecord;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface FakeWhombatPasskey {
  id: string;
  name: string;
  accountId: string;
  createdAt: string;
  lastUsedAt: string | null;
  synced: boolean;
  removed: boolean;
  ownerHandle?: string;
  publicKey?: string;
  /** A box passkey's RP ID, the box's own host (4.3). */
  rpId?: string;
}

/** `clientDataJSON` as the verifiers read it; null when it isn't one. */
export function clientData(b64: unknown): { type: string; challenge: string; origin: string } | null {
  if (typeof b64 !== 'string') return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(base64urlDecode(b64))) as Record<string, unknown>;
    return typeof v.type === 'string' && typeof v.challenge === 'string' && typeof v.origin === 'string'
      ? { type: v.type, challenge: v.challenge, origin: v.origin }
      : null;
  } catch {
    return null;
  }
}

/** The BE flag (backup eligible: the passkey can sync) of the authenticator data, when the JSON carries it. */
export function backupEligible(authenticatorData: unknown): boolean {
  if (typeof authenticatorData !== 'string') return false;
  try {
    const bytes = base64urlDecode(authenticatorData);
    return ((bytes[32] ?? 0) & 0x08) !== 0;
  } catch {
    return false;
  }
}

/** A passkey as `passkeys.list` lists it. */
export function passkeySummary(
  p: FakeWhombatPasskey,
  personName: string,
  current: boolean,
): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    accountId: p.accountId,
    personName,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    synced: p.synced,
    current,
    ...(p.ownerHandle && { ownerHandle: p.ownerHandle, publicKey: p.publicKey }),
    ...(p.rpId && { rpId: p.rpId }),
  };
}
