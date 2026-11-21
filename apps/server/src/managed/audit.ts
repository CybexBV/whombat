/**
 * The appliance's signed audit log (MA-04: claim, enrollment, pairing, recovery, revocation). These actions
 * belong to no burrow, so they get their own hash chain in `appliance_events`,
 * signed by the appliance audit key: an Ed25519 key the runtime creates on first use and keeps sealed with
 * `WHOMBAT_MASTER_KEY` (like principals' keys, D-06). Envelope hash = sha256(canonicalJson(envelope)),
 * `sig = ed25519(hash)`, `prevHash` links the chain; appends hold a transaction-level advisory lock.
 */
import { randomBytes } from 'node:crypto';
import {
  canonicalJson,
  generateKeypair,
  sha256Hex,
  signBytes,
  utf8ToBytes,
  verifyBytes,
} from '@whombat/core';
import type { APPLIANCE_EVENT_TYPES } from '@whombat/protocol/session';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { applianceEvents, applianceKeys } from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';

/** Advisory lock of the appliance chain ("WHAP"). */
export const APPLIANCE_AUDIT_LOCK = 0x57484150;
const AUDIT_KEY_ID = 'appliance-audit';
export const GENESIS_HASH = '0'.repeat(64);

/** The contracts' appliance audit event types (`APPLIANCE_EVENT_TYPES`, 0.5.3: `reenroll.*`, `diagnostics.*`). */
export type ApplianceEventType = (typeof APPLIANCE_EVENT_TYPES)[number];

export interface ApplianceEventInput {
  type: ApplianceEventType;
  actorAccountId: string | null;
  endpointId: string | null;
  /** Ids, labels and fingerprints only: never secrets. */
  payload: Record<string, unknown>;
  at: Date;
}

export interface ApplianceEnvelope {
  v: 1;
  seq: number;
  type: string;
  actorAccountId: string | null;
  endpointId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  prevHash: string;
}

/** A local id with a readable prefix (`ep_…`, `pair_…`): 72 random bits. */
export function localId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function envelopeHash(envelope: ApplianceEnvelope): string {
  return sha256Hex(canonicalJson(envelope));
}

async function auditKey(tx: Tx | Db, custody: KeyCustody): Promise<{ publicKey: string; secretKey: string }> {
  const [row] = await tx.select().from(applianceKeys).where(eq(applianceKeys.id, AUDIT_KEY_ID));
  if (row) return { publicKey: row.publicKey, secretKey: custody.decrypt(AUDIT_KEY_ID, row.secretKeyEnc) };
  const pair = generateKeypair();
  const wrapped = custody.wrap(AUDIT_KEY_ID, pair);
  await tx
    .insert(applianceKeys)
    .values({ id: AUDIT_KEY_ID, publicKey: pair.publicKey, secretKeyEnc: wrapped.secretKeyEnc })
    .onConflictDoNothing();
  const [stored] = await tx.select().from(applianceKeys).where(eq(applianceKeys.id, AUDIT_KEY_ID));
  if (!stored) throw new Error('appliance audit key missing');
  return { publicKey: stored.publicKey, secretKey: custody.decrypt(AUDIT_KEY_ID, stored.secretKeyEnc) };
}

/** Appends one signed event inside the caller's transaction (the action and its audit commit together). */
export async function appendApplianceEvent(
  tx: Tx,
  custody: KeyCustody,
  input: ApplianceEventInput,
): Promise<{ seq: number; hash: string }> {
  await tx.execute(sql`select pg_advisory_xact_lock(${APPLIANCE_AUDIT_LOCK})`);
  const key = await auditKey(tx, custody);
  const [head] = await tx
    .select({ seq: applianceEvents.seq, hash: applianceEvents.hash })
    .from(applianceEvents)
    .orderBy(desc(applianceEvents.seq))
    .limit(1);
  const envelope: ApplianceEnvelope = {
    v: 1,
    seq: (head?.seq ?? 0) + 1,
    type: input.type,
    actorAccountId: input.actorAccountId,
    endpointId: input.endpointId,
    payload: input.payload,
    createdAt: input.at.toISOString(),
    prevHash: head?.hash ?? GENESIS_HASH,
  };
  const hash = envelopeHash(envelope);
  const sig = signBytes(utf8ToBytes(hash), key.secretKey);
  await tx.insert(applianceEvents).values({
    seq: envelope.seq,
    type: envelope.type,
    actorAccountId: envelope.actorAccountId,
    endpointId: envelope.endpointId,
    payload: envelope.payload,
    createdAt: input.at,
    prevHash: envelope.prevHash,
    hash,
    sig,
  });
  return { seq: envelope.seq, hash };
}

/** Walks the whole chain: every hash recomputes, links and verifies under the audit key. */
export async function verifyApplianceChain(
  db: Db,
  _custody?: KeyCustody,
): Promise<{ ok: boolean; count: number; brokenAt: number | null }> {
  const rows = await db.select().from(applianceEvents).orderBy(asc(applianceEvents.seq));
  if (rows.length === 0) return { ok: true, count: 0, brokenAt: null };
  // Read-only (a drill verifies a read-only restore): the stored public key, never a new one.
  const [key] = await db.select().from(applianceKeys).where(eq(applianceKeys.id, AUDIT_KEY_ID));
  if (!key) return { ok: false, count: rows.length, brokenAt: rows[0]?.seq ?? null };
  const publicKey = key.publicKey;
  let prev = GENESIS_HASH;
  for (const row of rows) {
    const envelope: ApplianceEnvelope = {
      v: 1,
      seq: row.seq,
      type: row.type,
      actorAccountId: row.actorAccountId,
      endpointId: row.endpointId,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
      prevHash: row.prevHash,
    };
    const hash = envelopeHash(envelope);
    if (row.prevHash !== prev || hash !== row.hash || !verifyBytes(row.sig, utf8ToBytes(hash), publicKey))
      return { ok: false, count: rows.length, brokenAt: row.seq };
    prev = row.hash;
  }
  return { ok: true, count: rows.length, brokenAt: null };
}
