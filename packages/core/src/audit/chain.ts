/**
 * Event signing and the per-burrow hash chain.
 *
 *   envelope.seq      = head.seq + 1        (1 for the first event)
 *   envelope.prevHash = head.hash           (GENESIS_HASH for the first event)
 *   hash              = sha256(canonicalJson(envelope))
 *   sig               = ed25519.sign(hash bytes, actor secret key)
 */
import { EventEnvelope, GENESIS_HASH, type SignedEvent } from '../domain/audit.js';
import { canonicalJson } from './canonical.js';
import { hexToBytes, publicKeyOf, sha256Hex, signBytes, verifyBytes } from './crypto.js';

export interface ChainHead {
  seq: number;
  hash: string;
}

/** Envelope fields covered by the hash, in schema order. Anything else (hash, sig, read-model fields) is not. */
export const ENVELOPE_KEYS = Object.keys(EventEnvelope.shape) as (keyof EventEnvelope)[];

/** Extracts exactly the signed envelope from a stored or read-model event. */
export function envelopeOf(event: EventEnvelope | SignedEvent): EventEnvelope {
  const out: Record<string, unknown> = {};
  const source = event as unknown as Record<string, unknown>;
  for (const key of ENVELOPE_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as EventEnvelope;
}

/** sha256 hex of the canonical envelope. */
export function hashEnvelope(envelope: EventEnvelope): string {
  return sha256Hex(canonicalJson(envelopeOf(envelope)));
}

/** Signs an envelope with the actor's secret key. */
export function signEnvelope(envelope: EventEnvelope, secretKeyHex: string): SignedEvent {
  const clean = envelopeOf(envelope);
  const hash = hashEnvelope(clean);
  return {
    ...clean,
    hash,
    sig: signBytes(hexToBytes(hash), secretKeyHex),
    signer: publicKeyOf(secretKeyHex),
  };
}

/** An event before it is placed in the chain: everything except `v`, `seq` and `prevHash`. */
export type EventDraft = Omit<EventEnvelope, 'v' | 'seq' | 'prevHash'>;

/** Chain position for the next event after `head` (null = empty chain). */
export function nextChainPosition(head: ChainHead | null): { seq: number; prevHash: string } {
  return head ? { seq: head.seq + 1, prevHash: head.hash } : { seq: 1, prevHash: GENESIS_HASH };
}

/** Places a draft after `head` and signs it. The caller persists it and makes it the new head atomically. */
export function appendEvent(head: ChainHead | null, draft: EventDraft, secretKeyHex: string): SignedEvent {
  const envelope: EventEnvelope = { v: 1, ...draft, ...nextChainPosition(head) };
  return signEnvelope(envelope, secretKeyHex);
}

export type EventFailure =
  | 'hash_mismatch'
  | 'bad_signature'
  | 'signer_mismatch'
  | 'unknown_signer'
  | 'seq_gap'
  | 'prev_hash_mismatch'
  | 'burrow_mismatch';

/**
 * Verifies one event on its own: the hash matches the envelope, the signature is valid for `signer`,
 * and (when given) `signer` is one of the actor's keys.
 */
export function verifyEvent(
  event: SignedEvent,
  actorKeys?: string | readonly string[],
): { ok: true } | { ok: false; reason: EventFailure } {
  if (hashEnvelope(event) !== event.hash) return { ok: false, reason: 'hash_mismatch' };
  if (actorKeys !== undefined) {
    const keys = typeof actorKeys === 'string' ? [actorKeys] : actorKeys;
    if (keys.length === 0) return { ok: false, reason: 'unknown_signer' };
    if (!keys.includes(event.signer)) return { ok: false, reason: 'signer_mismatch' };
  }
  if (!verifyBytes(event.sig, hexToBytes(event.hash), event.signer))
    return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/** Checks that `event` directly follows `prev` in the chain. */
export function verifyLink(
  prev: ChainHead | null,
  event: Pick<SignedEvent, 'seq' | 'prevHash'>,
): EventFailure | null {
  const expected = nextChainPosition(prev);
  if (event.seq !== expected.seq) return 'seq_gap';
  if (event.prevHash !== expected.prevHash) return 'prev_hash_mismatch';
  return null;
}

export interface ChainFailure {
  seq: number;
  id: string;
  reason: EventFailure;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** Head after the last event checked. */
  head: ChainHead | null;
  failures: ChainFailure[];
}

/**
 * Walks a chain (events in `seq` order) and reports every broken event.
 * `keysOf(actorId)` returns the actor's public key(s); omit it to check signatures against `signer` only.
 * `from` is the trusted head before the first event (null = genesis) for verifying a window of the chain.
 */
export function verifyChain(
  events: readonly SignedEvent[],
  options: {
    keysOf?: (actorId: string) => string | readonly string[] | undefined;
    from?: ChainHead | null;
    burrowId?: string;
  } = {},
): ChainVerification {
  const failures: ChainFailure[] = [];
  let head: ChainHead | null = options.from ?? null;
  const burrowId = options.burrowId ?? events[0]?.burrowId;
  for (const event of events) {
    const link = verifyLink(head, event);
    if (link) failures.push({ seq: event.seq, id: event.id, reason: link });
    if (burrowId && event.burrowId !== burrowId)
      failures.push({ seq: event.seq, id: event.id, reason: 'burrow_mismatch' });
    const keys = options.keysOf ? (options.keysOf(event.actorId) ?? []) : undefined;
    const single = verifyEvent(event, keys);
    if (!single.ok) failures.push({ seq: event.seq, id: event.id, reason: single.reason });
    head = { seq: event.seq, hash: event.hash };
  }
  return { ok: failures.length === 0, checked: events.length, head, failures };
}
