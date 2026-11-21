/** A passkey's authenticated list of Whombats. Pure: the PRF and owner seed never leave the client. */
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { canonicalJson, sha256Bytes } from '@whombat/core/audit';
import {
  fromBase64url,
  kitKeyFromPrf,
  openKitWithKey,
  sealKitWithKey,
  toBase64url,
} from '@whombat/core/backup';
import { z } from 'zod';
import { base64urlDecode, base64urlEncode, utf8Decode, utf8Encode } from '../bytes.js';
import { PeerIdString } from './common.js';

const Bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const B64 = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/);
export const OwnerPasskeyHandle = z
  .string()
  .regex(/^[A-Za-z0-9_-]{63}$/)
  .refine((v) => ownerPublicKey(v) !== null);
const OwnerPasskeyDocument = z.strictObject({
  kind: z.literal('whombat.owner-passkey/1'),
  credentialId: B64.max(1364),
  userHandle: OwnerPasskeyHandle,
  publicKey: B64,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  appliances: z
    .array(PeerIdString)
    .min(1)
    .max(128)
    .refine((v) => new Set(v).size === v.length),
  sealedSeed: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^wbkit1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});
export const OwnerPasskeyRecord = OwnerPasskeyDocument.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type OwnerPasskeyRecord = z.infer<typeof OwnerPasskeyRecord>;

export function ownerPublicKey(handle: string): Uint8Array | null {
  try {
    const text = utf8Decode(base64urlDecode(handle));
    if (!text.startsWith('wo1:')) return null;
    const encoded = Bytes32.safeParse(text.slice(4));
    if (!encoded.success) return null;
    const key = base64urlDecode(encoded.data);
    return key.length === 32 && ownerUserHandle(key) === handle ? key : null;
  } catch {
    return null;
  }
}

export function ownerUserHandle(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('owner_key_length');
  return base64urlEncode(utf8Encode(`wo1:${base64urlEncode(publicKey)}`));
}

export function newPasskeyOwner(): { seed: Uint8Array; userHandle: string } {
  const seed = randomBytes(32);
  return { seed, userHandle: ownerUserHandle(ed25519.getPublicKey(seed)) };
}

export function sealPasskeyOwner(seed: Uint8Array, prf: Uint8Array, credentialId: string): string {
  const context = `whombat owner seed 1:${credentialId}`;
  const key = kitKeyFromPrf(prf, context);
  try {
    return sealKitWithKey(toBase64url(seed), key, context);
  } finally {
    key.fill(0);
  }
}

export function openPasskeyOwner(record: OwnerPasskeyRecord, prf: Uint8Array): Uint8Array | null {
  const context = `whombat owner seed 1:${record.credentialId}`;
  const key = kitKeyFromPrf(prf, context);
  try {
    const plain = openKitWithKey(record.sealedSeed, key, context);
    const seed = plain ? fromBase64url(plain) : null;
    if (seed?.length === 32 && ownerUserHandle(ed25519.getPublicKey(seed)) === record.userHandle) return seed;
    seed?.fill(0);
    return null;
  } finally {
    key.fill(0);
  }
}

export function signOwnerPasskey(
  document: Omit<OwnerPasskeyRecord, 'signature'>,
  seed: Uint8Array,
): OwnerPasskeyRecord {
  const parsed = OwnerPasskeyDocument.parse(document);
  if (ownerUserHandle(ed25519.getPublicKey(seed)) !== parsed.userHandle)
    throw new Error('owner_key_mismatch');
  return { ...parsed, signature: base64urlEncode(ed25519.sign(utf8Encode(canonicalJson(parsed)), seed)) };
}

/** The handle must come from the authenticator, or an already trusted local record. Never trust control's alone. */
export function verifyOwnerPasskey(raw: unknown, trustedHandle: string): OwnerPasskeyRecord | null {
  const parsed = OwnerPasskeyRecord.safeParse(raw);
  const key = ownerPublicKey(trustedHandle);
  if (!parsed.success || !key || parsed.data.userHandle !== trustedHandle) return null;
  const { signature, ...document } = parsed.data;
  try {
    return ed25519.verify(base64urlDecode(signature), utf8Encode(canonicalJson(document)), key)
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

export function passkeyLinkChallenge(input: {
  nonce: string;
  appliance: string;
  endpoint: string;
  record: OwnerPasskeyRecord;
}): string {
  return base64urlEncode(sha256Bytes(canonicalJson({ purpose: 'whombat-passkey-link/1', ...input })));
}
