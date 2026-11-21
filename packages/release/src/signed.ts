/**
 * Signed JSON documents: Ed25519 over the UTF-8 of the payload's canonical JSON (RFC 8785, core's
 * `canonicalJson`). Payloads carry their own `purpose` and audience so a signature can't be replayed as
 * another document type or in another environment. Cross-language payloads use integers only (no floats),
 * so canonical JSON is identical in Go (`gowebpki/jcs`) and TypeScript.
 */
import { canonicalJson, signBytes, utf8ToBytes, verifyBytes } from '@whombat/core/audit';
import { z } from 'zod';
import { Ident, SignatureHex } from './primitives.js';

export function signingBytes(payload: unknown): Uint8Array {
  return utf8ToBytes(canonicalJson(payload));
}

/** `{payload, keyId, sig}` with `sig = Ed25519(canonicalJson(payload))`. */
export function signedDocument<P extends z.ZodType>(payload: P) {
  return z.strictObject({ payload, keyId: Ident, sig: SignatureHex });
}

export function signDocument<T>(payload: T, keyId: string, secretKeyHex: string) {
  return { payload, keyId, sig: signBytes(signingBytes(payload), secretKeyHex) };
}

/** Verifies the signature only; the caller checks purpose, audience, times and sequence. */
export function verifyDocumentSignature(
  doc: { payload: unknown; sig: string },
  publicKeyHex: string,
): boolean {
  return verifyBytes(doc.sig, signingBytes(doc.payload), publicKeyHex);
}
