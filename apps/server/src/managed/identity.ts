/**
 * Ed25519 identities as the secure channel sees them (MA-03, MA-07): libp2p PeerIds of endpoint keys and of the
 * appliance content identity, the content key file (`@whombat/secure-channel`'s format: a libp2p protobuf private
 * key), and strict Ed25519 verification (CT-15). Thin wrappers over the contracts' implementations.
 */
import { readFileSync } from 'node:fs';
import { hexToBytes, verifyEd25519Strict as verifyStrict } from '@whombat/core';
import { deserializeIdentity, type Identity, peerIdFromEd25519PublicKey } from '@whombat/secure-channel';

export { peerIdFromEd25519PublicKey };

/** The appliance content identity from its key file (the runtime reads it; the manager never does). */
export function loadContentIdentity(file: string): Identity {
  return deserializeIdentity(new Uint8Array(readFileSync(file)));
}

/** Strict Ed25519 verification (no ZIP-215 leniency), matching the Go side (CT-15). */
export function verifyEd25519Strict(
  signatureHex: string,
  message: Uint8Array,
  publicKeyHex: string,
): boolean {
  try {
    return verifyStrict(hexToBytes(signatureHex), message, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
