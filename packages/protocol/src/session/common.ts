/** Building blocks shared by the session protocol schemas. */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { base64urlEncode, utf8Encode } from '../bytes.js';

/** Client-generated request id (≥ 96 random bits, e.g. a ULID or nanoid); the idempotency key (MA-09). */
export const RequestId = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type RequestId = z.infer<typeof RequestId>;

/** Operation name: `area.action` (`burrows.list`, `enroll.claim`, `recovery.kit.confirm`). */
export const OpName = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/);

/** Stream id of a non-control stream (1..2^32−1; odd = opened by the client, even = by the appliance). */
export const StreamId = z.number().int().min(1).max(0xffff_ffff);
export type StreamId = z.infer<typeof StreamId>;

/** Subscription id chosen by the client. */
export const SubscriptionId = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Opaque, appliance-owned event cursor (MA-09); compare only for equality, resume with `after`. */
export const EventCursor = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export type EventCursor = z.infer<typeof EventCursor>;

/** The account's authorization generation; bumps on revocation and role changes (MA-04 §6). */
export const AuthzGeneration = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** libp2p PeerId of an Ed25519 identity (base58btc identity multihash). */
export const PeerIdString = z.string().regex(/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/);
export type PeerIdString = z.infer<typeof PeerIdString>;

/** Local id of an enrolled endpoint key. */
export const EndpointId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const EndpointPlatform = z.enum(['web', 'android', 'ios', 'desktop', 'cli']);
export type EndpointPlatform = z.infer<typeof EndpointPlatform>;

/** Human label of an endpoint ("Chrome on MacBook"). */
export const EndpointLabel = z.string().trim().min(1).max(80);

/** Opaque handle control issued for one app install's push token (CT-11); the client gives it to its appliance. */
export const PushHandle = z
  .string()
  .min(22)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * The appliance's reference for a push (CT-32). It reaches Apple/Google, so it must reveal nothing: either ≥ 128
 * random bits or a keyed hash (HMAC-SHA256 with an appliance-local key, `pushRefFor`), base64url, 22–43
 * characters. Never an id, a name or anything derived from content without a key.
 */
export const PushRef = z
  .string()
  .min(22)
  .max(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Keyed-hash push ref: base64url(HMAC-SHA256(key, value)) truncated to 22 characters (128 bits). */
export function pushRefFor(key: Uint8Array, value: string): string {
  if (key.length < 32) throw new Error('push ref keys are at least 32 bytes');
  return base64urlEncode(hmac(sha256, key, utf8Encode(value))).slice(0, 22);
}
