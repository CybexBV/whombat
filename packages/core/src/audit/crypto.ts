/**
 * Hashing and Ed25519 signing (`@noble/curves`, `@noble/hashes`; pure JS, works in browsers, Node and
 * React Native). Keys, hashes and signatures travel as lowercase hex.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export interface Keypair {
  /** 32-byte Ed25519 secret key (seed), hex. Keep server-side (encrypted at rest, DECISIONS D-06). */
  secretKey: string;
  /** 32-byte public key, hex. */
  publicKey: string;
}

export { bytesToHex, hexToBytes, utf8ToBytes };

/** sha256 of UTF-8 text or bytes, as hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

export function sha256Bytes(data: string | Uint8Array): Uint8Array {
  return sha256(typeof data === 'string' ? utf8ToBytes(data) : data);
}

/** New random keypair (uses `crypto.getRandomValues`). */
export function generateKeypair(): Keypair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey: bytesToHex(secretKey), publicKey: bytesToHex(publicKey) };
}

/** Public key for a secret key. */
export function publicKeyOf(secretKeyHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secretKeyHex)));
}

/** Domain separator for seed keys. */
export const SEED_KEY_CONTEXT = 'whombat/seed-key/v1';

/**
 * Deterministic keypair for seeded principals so fingerprints are stable across machines and reseeds.
 * `secretKey = sha256("whombat/seed-key/v1\0" + seed + "\0" + principalId)`. Only for seed / demo data.
 */
export function deriveSeedKeypair(principalId: string, seed = 'whombat-demo'): Keypair {
  const secret = sha256(utf8ToBytes(`${SEED_KEY_CONTEXT}\u0000${seed}\u0000${principalId}`));
  return { secretKey: bytesToHex(secret), publicKey: bytesToHex(ed25519.getPublicKey(secret)) };
}

/** Ed25519 signature (64 bytes, hex) over `message`. */
export function signBytes(message: Uint8Array, secretKeyHex: string): string {
  return bytesToHex(ed25519.sign(message, hexToBytes(secretKeyHex)));
}

/**
 * Strict Ed25519 verification (RFC 8032 / not ZIP-215): canonical encodings of the public key, R and S only, and
 * small-order public keys are refused (with one, anyone could forge a signature). This is the default for every
 * verify helper in whombat-contracts; the Go bindings apply the same rules. Malformed input returns false.
 */
export function verifyEd25519Strict(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    if (ed25519.Point.fromBytes(publicKey, false).isSmallOrder()) return false;
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Verifies an Ed25519 signature (hex), strictly (`verifyEd25519Strict`). Malformed input returns false. */
export function verifyBytes(signatureHex: string, message: Uint8Array, publicKeyHex: string): boolean {
  if (!/^[0-9a-f]{128}$/.test(signatureHex) || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
  return verifyEd25519Strict(hexToBytes(signatureHex), message, hexToBytes(publicKeyHex));
}

/** "3fa9 c1d2" from 8 hex characters. */
export function formatFingerprint(hex: string): string {
  const h = hex.slice(0, 8).toLowerCase();
  return `${h.slice(0, 4)} ${h.slice(4, 8)}`;
}

/** Key fingerprint shown in the log: first 8 hex chars of sha256(publicKey bytes), as `xxxx xxxx`. */
export function fingerprintOf(publicKeyHex: string): string {
  return formatFingerprint(bytesToHex(sha256(hexToBytes(publicKeyHex))));
}
