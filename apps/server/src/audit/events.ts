/**
 * Appending signed events to a burrow's hash chain, and reading them back as `SignedEvent`s.
 *
 * Appends run inside the commit transaction while it holds the burrow's advisory lock
 * (`lockBurrow`), so `seq` assignment, `prevHash` lookup and the insert cannot race with another commit
 * in the same burrow (REFERENCE_NOTES §7). The lock is transaction-scoped: Postgres releases it on commit,
 * rollback and connection loss, so there is no exit path that leaks it.
 */
import {
  type AuditApprovalState,
  type AuditEvent,
  appendEvent,
  type ChainHead,
  type EventDraft,
  fingerprintOf,
  type SignedEvent,
} from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { events, principals } from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';
import { iso, normalizeIso } from '../lib/time';

/** Advisory lock class for burrow write serialization ("WHMB"). */
export const BURROW_LOCK_CLASS = 0x57484d42;

/** Takes the burrow's transaction-scoped advisory lock. Re-entrant within one transaction. */
export async function lockBurrow(tx: Tx, burrowId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${BURROW_LOCK_CLASS}::int, hashtext(${burrowId}))`);
}

export async function chainHead(db: Db, burrowId: string): Promise<ChainHead | null> {
  const [row] = await db
    .select({ seq: events.seq, hash: events.hash })
    .from(events)
    .where(eq(events.burrowId, burrowId))
    .orderBy(desc(events.seq))
    .limit(1);
  return row ?? null;
}

type EventRow = typeof events.$inferSelect;

/** Removes `undefined` members so the canonical envelope omits them. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Signs `draft` with the actor's custodied key and appends it after the current head.
 * The caller must hold the burrow lock (the commit pipeline takes it when the transaction starts).
 */
export async function appendSignedEvent(
  tx: Tx,
  custody: KeyCustody,
  draft: EventDraft,
  secretKeyEnc?: string,
): Promise<SignedEvent> {
  let enc = secretKeyEnc;
  if (!enc) {
    const [actor] = await tx
      .select({ secretKeyEnc: principals.secretKeyEnc, burrowId: principals.burrowId })
      .from(principals)
      .where(eq(principals.id, draft.actorId));
    if (!actor) throw new Error(`Cannot sign: unknown principal ${draft.actorId}`);
    if (actor.burrowId !== draft.burrowId)
      throw new Error(`Cannot sign: ${draft.actorId} is in another burrow`);
    enc = actor.secretKeyEnc;
  }
  const secretKey = custody.decrypt(draft.actorId, enc);
  const head = await chainHead(tx, draft.burrowId);
  const clean = compact({ ...draft, createdAt: normalizeIso(draft.createdAt), payload: draft.payload ?? {} });
  const signed = appendEvent(head, clean, secretKey);
  await tx.insert(events).values({
    id: signed.id,
    burrowId: signed.burrowId,
    seq: signed.seq,
    v: signed.v,
    prevHash: signed.prevHash,
    actorId: signed.actorId,
    type: signed.type,
    kind: signed.kind,
    text: signed.text,
    where: signed.where,
    keyUsed: signed.keyUsed ?? null,
    keyNote: signed.keyNote ?? null,
    onBehalfOf: signed.onBehalfOf ?? null,
    onBehalfOfId: signed.onBehalfOfId ?? null,
    aboutId: signed.aboutId ?? null,
    decided: signed.decided ?? null,
    approvalId: signed.approvalId ?? null,
    ref: signed.ref ?? null,
    payload: signed.payload,
    createdAt: new Date(signed.createdAt),
    hash: signed.hash,
    sig: signed.sig,
    signer: signed.signer,
  });
  return signed;
}

/** Rebuilds the signed event from its row (optional envelope fields are omitted when NULL). */
export function rowToSignedEvent(row: EventRow): SignedEvent {
  return compact({
    v: row.v as 1,
    id: row.id,
    burrowId: row.burrowId,
    seq: row.seq,
    prevHash: row.prevHash,
    actorId: row.actorId,
    type: row.type,
    kind: row.kind,
    text: row.text,
    where: row.where,
    keyUsed: row.keyUsed ?? undefined,
    keyNote: row.keyNote ?? undefined,
    onBehalfOf: row.onBehalfOf ?? undefined,
    onBehalfOfId: row.onBehalfOfId ?? undefined,
    aboutId: row.aboutId ?? undefined,
    decided: row.decided ?? undefined,
    approvalId: row.approvalId ?? undefined,
    ref: row.ref ?? undefined,
    payload: row.payload,
    createdAt: iso(row.createdAt),
    hash: row.hash,
    sig: row.sig,
    signer: row.signer,
  });
}

/** Read-model event: fingerprint, verification result and the live approval (Asks events). */
export function toAuditEvent(
  event: SignedEvent,
  verified: boolean,
  approval: AuditApprovalState | null,
): AuditEvent {
  return { ...event, fingerprint: fingerprintOf(event.signer), verified, approval };
}

export async function loadEventRow(db: Db, burrowId: string, id: string): Promise<EventRow | undefined> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, burrowId), eq(events.id, id)));
  return row;
}
