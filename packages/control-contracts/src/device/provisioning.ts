/**
 * Factory provisioning registration (MA-04 §1): the provisioning tool registers the device's management public
 * key, content identity (public key + PeerId) and hardware serial with the directory (unclaimed). `proof` and
 * `contentProof` are the management and content keys' signatures over the same `registrationSigningBytes(...)`,
 * proving possession of both. `contentPeerId` must be the PeerId of `contentPublicKey`. Authenticated by the
 * provisioning credential (not a device envelope: the device is unknown until this succeeds). Cross-language.
 */
import { canonicalJson, hexToBytes, signBytes, utf8ToBytes, verifyBytes } from '@whombat/core/audit';
import { peerIdFromEd25519PublicKey } from '@whombat/protocol';
import { PeerIdString } from '@whombat/protocol/session';
import { Environment, EpochSeconds, PublicKeyHex, SignatureHex } from '@whombat/release';
import { z } from 'zod';
import { ApplianceRouteId, DeviceId, HardwareModel, HardwareSerial } from '../common.js';

export const REGISTRATION_PURPOSE = 'whombat-device-registration/v1';

export const DeviceRegistration = z.strictObject({
  env: Environment,
  hardwareSerial: HardwareSerial,
  model: HardwareModel,
  managementPublicKey: PublicKeyHex,
  contentPeerId: PeerIdString,
  /** Raw Ed25519 public key of the content identity (its PeerId is `contentPeerId`). */
  contentPublicKey: PublicKeyHex,
  provisionedAt: EpochSeconds,
  /** Management key's signature over `registrationSigningBytes`. */
  proof: SignatureHex,
  /** Content key's signature over the same bytes. */
  contentProof: SignatureHex,
});
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;

export const DeviceRegistrationResponse = z.object({
  device: DeviceId,
  applianceRoute: ApplianceRouteId,
  env: Environment,
});
export type DeviceRegistrationResponse = z.infer<typeof DeviceRegistrationResponse>;

type Unsigned = Omit<DeviceRegistration, 'proof' | 'contentProof'>;

export function registrationSigningBytes(reg: Unsigned): Uint8Array {
  const { env, hardwareSerial, model, managementPublicKey, contentPeerId, contentPublicKey, provisionedAt } =
    reg;
  return utf8ToBytes(
    canonicalJson({
      purpose: REGISTRATION_PURPOSE,
      env,
      hardwareSerial,
      model,
      managementPublicKey,
      contentPeerId,
      contentPublicKey,
      provisionedAt,
    }),
  );
}

export function signRegistration(
  reg: Unsigned,
  keys: { managementSecretKeyHex: string; contentSecretKeyHex: string },
): DeviceRegistration {
  const bytes = registrationSigningBytes(reg);
  return {
    ...reg,
    proof: signBytes(bytes, keys.managementSecretKeyHex),
    contentProof: signBytes(bytes, keys.contentSecretKeyHex),
  };
}

/**
 * Both proofs verify (strict Ed25519: canonical encodings, no small-order keys) and `contentPeerId` is the PeerId
 * of `contentPublicKey`. The two keys must differ.
 */
export function verifyRegistration(reg: DeviceRegistration): boolean {
  if (reg.managementPublicKey === reg.contentPublicKey) return false;
  let peerId: string;
  try {
    peerId = peerIdFromEd25519PublicKey(hexToBytes(reg.contentPublicKey));
  } catch {
    return false;
  }
  if (peerId !== reg.contentPeerId) return false;
  const bytes = registrationSigningBytes(reg);
  return (
    verifyBytes(reg.proof, bytes, reg.managementPublicKey) &&
    verifyBytes(reg.contentProof, bytes, reg.contentPublicKey)
  );
}
