/**
 * Pending sign-ins of catalog connections (CX-11, CX-15, CX-D01): an OAuth start's state and a Nextcloud login flow,
 * one `connection_pending` row each — single use, 10 minutes, bound to the account that started it. What it carries
 * (the PKCE verifier, the label and fields, the issuer and endpoints, Nextcloud's poll token) is sealed with AAD
 * `connection_pending:<id>`.
 */
import { randomIdBody } from '@whombat/core';
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { connectionPending } from '../db/schema/index';
import type { Services } from '../services';
import { openJson, pendingAad, sealJson } from './crypto';

export const PENDING_TTL_MS = 10 * 60_000;

export type PendingRow = typeof connectionPending.$inferSelect;

export interface PendingInput<S> {
  accountId: string;
  burrowId: string;
  catalogId: string;
  connectionId: string | null;
  signIn: string;
  returnPath: string;
  state: S;
  ttlMs?: number;
}

/** Stores a pending sign-in; returns its id (`oas_…`, the OAuth `state` or the Nextcloud flow id). */
export async function createPending<S>(
  services: Services,
  input: PendingInput<S>,
): Promise<{ id: string; expiresAt: Date }> {
  const now = services.clock();
  const id = `oas_${randomIdBody(43)}`;
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? PENDING_TTL_MS));
  await services.pipeline.transactAccount(async (tx) => {
    // Housekeeping: the account's finished or expired sign-ins.
    await tx
      .delete(connectionPending)
      .where(
        and(
          eq(connectionPending.accountId, input.accountId),
          or(lt(connectionPending.expiresAt, now), isNotNull(connectionPending.usedAt)),
        ),
      );
    await tx.insert(connectionPending).values({
      id,
      accountId: input.accountId,
      burrowId: input.burrowId,
      catalogId: input.catalogId,
      connectionId: input.connectionId,
      signIn: input.signIn,
      stateEnc: sealJson(services.custody, pendingAad(id), input.state),
      returnPath: input.returnPath,
      createdAt: now,
      expiresAt,
    });
  });
  return { id, expiresAt };
}

export function pendingState<S>(services: Services, row: PendingRow): S {
  return openJson<S>(services.custody, pendingAad(row.id), row.stateEnc);
}

/** How a pending sign-in stood: taken now (single use), used or expired before, or not this account's. */
export type TakeOutcome =
  | { kind: 'taken'; row: PendingRow }
  | { kind: 'used' | 'expired'; row: PendingRow }
  | { kind: 'unknown' };

const ID = /^oas_[A-Za-z0-9_-]{1,64}$/;

/** The account's own pending sign-in, unused and unexpired, or null (read only: Nextcloud polls before taking it). */
export async function livePending(
  services: Services,
  id: string,
  accountId: string,
  signIns: readonly string[],
): Promise<{ kind: 'live' | 'used' | 'expired'; row: PendingRow } | null> {
  if (!ID.test(id)) return null;
  const [row] = await services.db.select().from(connectionPending).where(eq(connectionPending.id, id));
  if (!row || row.accountId !== accountId || !signIns.includes(row.signIn)) return null;
  if (row.usedAt) return { kind: 'used', row };
  if (row.expiresAt.getTime() <= services.clock().getTime()) return { kind: 'expired', row };
  return { kind: 'live', row };
}

/**
 * Takes a pending sign-in for good: it must exist, be unused and unexpired, and be the signed-in account's (someone
 * else's state reads as unknown and stays usable by its own account). An expired one is used up when first seen.
 */
export async function takePending(
  services: Services,
  id: string | undefined,
  accountId: string | null,
  signIns: readonly string[],
): Promise<TakeOutcome> {
  if (!id || !accountId || !ID.test(id)) return { kind: 'unknown' };
  const now = services.clock();
  const [row] = await services.pipeline.transactAccount((tx) =>
    tx
      .update(connectionPending)
      .set({ usedAt: now })
      .where(
        and(
          eq(connectionPending.id, id),
          eq(connectionPending.accountId, accountId),
          isNull(connectionPending.usedAt),
          gt(connectionPending.expiresAt, now),
        ),
      )
      .returning(),
  );
  if (row && signIns.includes(row.signIn)) return { kind: 'taken', row };
  const [known] = await services.db.select().from(connectionPending).where(eq(connectionPending.id, id));
  if (!known || known.accountId !== accountId || !signIns.includes(known.signIn)) return { kind: 'unknown' };
  if (row) return { kind: 'used', row: known };
  const [first] = known.usedAt
    ? []
    : await services.pipeline.transactAccount((tx) =>
        tx
          .update(connectionPending)
          .set({ usedAt: now })
          .where(and(eq(connectionPending.id, id), isNull(connectionPending.usedAt)))
          .returning({ id: connectionPending.id }),
      );
  return { kind: first ? 'expired' : 'used', row: known };
}
