/**
 * A card asked before its yes was bound to where it goes (the previous release saved connection calls and page actions
 * without their call target): a yes to it never runs, since Whombat can't tell whether the connection still goes where
 * the card was about. Whombat asks again on a fresh card, bound to where the connection goes now and worded from it, in
 * the earlier card's thread; the earlier approval ends saying so. The fresh card's command names the earlier approval
 * (`askAgainOf`), so it is asked once, also when a crash makes the engine run the earlier one again.
 */
import type { Tier } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { approvals } from '../db/schema/index';
import { type ApiError, conflict } from '../lib/errors';
import { approvalThread } from './wake';

/** What the earlier card says once its yes asked again. */
export const ASKED_AGAIN_TEXT =
  'This was asked before Whombat kept where it goes, so it asks you again on a new card.';

/** The error the earlier approval ends with (the engine records it on the approval). */
export function askedAgainError(): ApiError {
  return conflict(ASKED_AGAIN_TEXT);
}

/** Whether a card already asks again for `approvalId`. */
export async function askedAgain(
  db: Pick<Db, 'select'>,
  burrowId: string,
  approvalId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, burrowId),
        sql`${approvals.command} -> 'input' ->> 'askAgainOf' = ${approvalId}`,
      ),
    )
    .limit(1);
  return !!row;
}

/** The tier a card that asks again decides on: it always asks, unless the key is off. */
export function askAgainTier(tier: Tier): Tier {
  return tier === 'can' ? 'ask' : tier;
}

/** Where the fresh card goes in `conversationId`: the earlier card's thread. */
export async function askAgainThread(
  db: Db,
  approvalId: string,
  conversationId: string,
): Promise<{ threadRootId: string | null }> {
  return { threadRootId: await approvalThread(db, approvalId, conversationId).catch(() => null) };
}
