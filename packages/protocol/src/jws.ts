/**
 * Compact JWS with `alg: EdDSA` (Ed25519), the form of admission tickets and licence tokens: the structure, header, key,
 * signature and claims checks they share, and their signing. Each token type keeps its own schemas, size limit and the
 * checks of what its claims mean (audience, role, device, time).
 */
import { verifyEd25519Strict } from '@whombat/core/audit';
import type { z } from 'zod';
import { base64urlDecode, base64urlEncode, utf8Decode, utf8Encode } from './bytes.js';

/** Injected Ed25519 verification (`ed25519.verify(sig, msg, pub)` from `@noble/curves` fits). */
export type Ed25519Verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;
/** Injected Ed25519 signing, used by control and tests. */
export type Ed25519Sign = (message: Uint8Array) => Uint8Array;

/**
 * The checks every compact EdDSA token goes through, in order; a token fails with the first one it doesn't pass (the Go
 * verifiers and the conformance vectors expect this order).
 */
export type CompactEdDsaError = 'malformed' | 'bad_header' | 'unknown_kid' | 'bad_signature' | 'bad_claims';

export type CompactEdDsaResult<H, C> =
  | { ok: true; header: H; claims: C }
  | { ok: false; error: CompactEdDsaError };

export interface VerifyCompactEdDsaOptions<H extends { kid: string }, C> {
  /** Longest token accepted; longer ones are `malformed` before anything is decoded. */
  maxLength: number;
  header: z.ZodType<H>;
  claims: z.ZodType<C>;
  /** The trusted keys, found by the header's `kid`. */
  keys: readonly { kid: string; x: string }[];
  /** Ed25519 verification; default `verifyEd25519Strict` from `@whombat/core/audit` (strict RFC 8032, like Go). */
  verify?: Ed25519Verify | undefined;
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(utf8Decode(base64urlDecode(segment)));
}

/**
 * Verifies a token's structure (three base64url segments, a 64-byte signature), header, key, signature and claims
 * schema. The claims are decoded only after the signature holds.
 */
export function verifyCompactEdDsa<H extends { kid: string }, C>(
  token: string,
  options: VerifyCompactEdDsaOptions<H, C>,
): CompactEdDsaResult<H, C> {
  const fail = (error: CompactEdDsaError): CompactEdDsaResult<H, C> => ({ ok: false, error });
  if (token.length > options.maxLength) return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return fail('malformed');
  const [h, p, s] = parts as [string, string, string];

  let rawHeader: unknown;
  let signature: Uint8Array;
  try {
    rawHeader = decodeJsonSegment(h);
    signature = base64urlDecode(s);
  } catch {
    return fail('malformed');
  }
  if (signature.length !== 64) return fail('malformed');
  const header = options.header.safeParse(rawHeader);
  if (!header.success) return fail('bad_header');

  const jwk = options.keys.find((k) => k.kid === header.data.kid);
  if (!jwk) return fail('unknown_kid');
  let publicKey: Uint8Array;
  try {
    publicKey = base64urlDecode(jwk.x);
  } catch {
    return fail('unknown_kid');
  }
  if (publicKey.length !== 32) return fail('unknown_kid');

  let valid = false;
  try {
    valid = (options.verify ?? verifyEd25519Strict)(signature, utf8Encode(`${h}.${p}`), publicKey);
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad_signature');

  let rawClaims: unknown;
  try {
    rawClaims = decodeJsonSegment(p);
  } catch {
    return fail('malformed');
  }
  const claims = options.claims.safeParse(rawClaims);
  if (!claims.success) return fail('bad_claims');
  return { ok: true, header: header.data, claims: claims.data };
}

/** Signs a header and claims the caller has already validated; throws unless the signature is 64 bytes. */
export function signCompactEdDsa(header: unknown, claims: unknown, sign: Ed25519Sign): string {
  const h = base64urlEncode(utf8Encode(JSON.stringify(header)));
  const p = base64urlEncode(utf8Encode(JSON.stringify(claims)));
  const signature = sign(utf8Encode(`${h}.${p}`));
  if (signature.length !== 64) throw new Error('Ed25519 signatures are 64 bytes');
  return `${h}.${p}.${base64urlEncode(signature)}`;
}
