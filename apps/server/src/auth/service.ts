/**
 * Accounts as the session dispatcher and the commands see them. People reach Whombat only through enrolled devices
 * (MA-04, MR-05): there is no sign-in here.
 */
import type { Account, Membership } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { type accounts, burrows, principals } from '../db/schema/index';
import { iso } from '../lib/time';
import type { Services } from '../services';

export type AccountRow = typeof accounts.$inferSelect;

/** The account as the person sees it. */
export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    createdAt: iso(row.createdAt),
  };
}

/** The burrows an account is the person of. */
export async function memberships(services: Services, accountId: string): Promise<Membership[]> {
  const rows = await services.db
    .select({ principal: principals, burrow: burrows })
    .from(principals)
    .innerJoin(burrows, eq(burrows.id, principals.burrowId))
    .where(and(eq(principals.accountId, accountId), eq(principals.kind, 'person')))
    .orderBy(asc(burrows.createdAt));
  return rows.map(({ principal, burrow }) => ({
    burrowId: burrow.id,
    burrowSlug: burrow.slug,
    burrowName: burrow.name,
    principalId: principal.id,
  }));
}
