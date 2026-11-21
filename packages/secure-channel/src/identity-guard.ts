import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Strict checks on the peer's libp2p Noise handshake payload, run by our crypto wrapper as soon as the payload
 * is decrypted — before @libp2p/noise parses the identity key and verifies its signature. They are
 * independent of (and in addition to) the library's own verification:
 *
 * - The payload is exactly `NoiseHandshakePayload {identity_key = 1, identity_sig = 2, extensions = 4}` with no
 *   other or repeated field, and extensions (if present) are empty (no early data).
 * - The identity key is a libp2p `PublicKey {Type = Ed25519, Data = 32 bytes}`. Other key types (RSA, ECDSA,
 *   secp256k1) are refused before any DER parse or signature verification (review L-5).
 * - The Ed25519 key is canonically encoded and not of small order (review L-1), and the signature over
 *   `"noise-libp2p-static-key:" || remote static X25519 key` verifies under RFC 8032 without ZIP-215 leniency:
 *   the same rules as `verifyEd25519Strict` in `@whombat/core/audit` (CT-15), implemented here on the same
 *   `@noble/curves` so browsers and Hermes do not load the core domain modules.
 * - If an identity is pinned, the key equals it.
 */

const SIGNATURE_PREFIX = new TextEncoder().encode('noise-libp2p-static-key:');
const KEY_TYPE_ED25519 = 1;

export class IdentityRejected extends Error {
  constructor(
    message: string,
    readonly kind: 'key-type' | 'weak-key' | 'signature' | 'pin' | 'payload' | 'early-data',
  ) {
    super(message);
    this.name = 'IdentityRejected';
  }
}

interface Field {
  field: number;
  wire: number;
  value: Uint8Array | number;
}

function readVarint(buf: Uint8Array, at: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (at.i >= buf.length) throw new IdentityRejected('truncated varint', 'payload');
    const b = buf[at.i++] as number;
    if (shift === 28 && b > 0x0f) throw new IdentityRejected('varint too large', 'payload');
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return result;
    shift += 7;
  }
}

/** Minimal protobuf reader: varint (wire type 0) and length-delimited (wire type 2) fields only. */
function readFields(buf: Uint8Array): Field[] {
  const fields: Field[] = [];
  const at = { i: 0 };
  while (at.i < buf.length) {
    const tag = readVarint(buf, at);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) fields.push({ field, wire, value: readVarint(buf, at) });
    else if (wire === 2) {
      const len = readVarint(buf, at);
      if (len > buf.length - at.i) throw new IdentityRejected('truncated field', 'payload');
      fields.push({ field, wire, value: buf.subarray(at.i, at.i + len) });
      at.i += len;
    } else throw new IdentityRejected(`unsupported wire type ${wire}`, 'payload');
  }
  return fields;
}

function single(fields: Field[], field: number, wire: number, required: boolean): Field | undefined {
  const found = fields.filter((f) => f.field === field);
  if (found.length > 1) throw new IdentityRejected(`repeated field ${field}`, 'payload');
  const f = found[0];
  if (!f) {
    if (required) throw new IdentityRejected(`missing field ${field}`, 'payload');
    return undefined;
  }
  if (f.wire !== wire) throw new IdentityRejected(`field ${field} has wire type ${f.wire}`, 'payload');
  return f;
}

/** Canonical, not small-order Ed25519 public key (CT-15 key rules). */
export function isStrongEd25519PublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) return false;
  try {
    return !ed25519.Point.fromBytes(publicKey, false).isSmallOrder();
  } catch {
    return false;
  }
}

/** RFC 8032 verification without ZIP-215 leniency, refusing weak keys (same rules as core `verifyEd25519Strict`). */
export function verifyEd25519StrictLocal(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || !isStrongEd25519PublicKey(publicKey)) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Validate a decrypted handshake payload against the remote static X25519 key it must sign. Returns the raw
 * Ed25519 identity key. Throws `IdentityRejected`.
 */
export function checkHandshakePayload(
  payload: Uint8Array,
  remoteStatic: Uint8Array,
  pinnedPublicKey?: Uint8Array,
): Uint8Array {
  const fields = readFields(payload);
  for (const f of fields) {
    if (f.field !== 1 && f.field !== 2 && f.field !== 4) {
      throw new IdentityRejected(`unexpected handshake payload field ${f.field}`, 'early-data');
    }
  }
  const keyField = single(fields, 1, 2, true)?.value as Uint8Array;
  const sig = single(fields, 2, 2, true)?.value as Uint8Array;
  const ext = single(fields, 4, 2, false);
  if (ext && (ext.value as Uint8Array).length > 0) {
    throw new IdentityRejected('handshake extensions are not accepted (no early data)', 'early-data');
  }
  const keyFields = readFields(keyField);
  const type = single(keyFields, 1, 0, true)?.value as number;
  const data = single(keyFields, 2, 2, true)?.value as Uint8Array;
  if (keyFields.length !== 2) throw new IdentityRejected('unexpected fields in the identity key', 'payload');
  if (type !== KEY_TYPE_ED25519)
    throw new IdentityRejected(`identity key type ${type} is not Ed25519`, 'key-type');
  if (data.length !== 32) throw new IdentityRejected('Ed25519 identity key is not 32 bytes', 'key-type');
  if (!isStrongEd25519PublicKey(data)) {
    throw new IdentityRejected('identity key is non-canonical or of small order', 'weak-key');
  }
  if (pinnedPublicKey && !data.every((b, i) => b === pinnedPublicKey[i])) {
    throw new IdentityRejected('identity key is not the pinned key', 'pin');
  }
  const message = new Uint8Array(SIGNATURE_PREFIX.length + remoteStatic.length);
  message.set(SIGNATURE_PREFIX);
  message.set(remoteStatic, SIGNATURE_PREFIX.length);
  if (!verifyEd25519StrictLocal(sig, message, data)) {
    throw new IdentityRejected('identity signature over the static key is invalid', 'signature');
  }
  return data.slice();
}
