/**
 * The Whombat's one person (docs/decisions/one-person.md OP-01, OP-10): the person who claimed it. Everything private on
 * the box is theirs; the columns that point at a person (`owner_id`, `on_behalf_of_account_id`, `dm_person_id`) point at
 * them. Other person rows that are still there (people who were on the box before OP-01) are history for the signed
 * events, never the person.
 *
 * The person is the claimer's principal (`appliance_state.claimed_by_account_id`); a box or test world without a claim
 * takes its first person with an account by position (migration 0006_one_person left only the person one).
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { applianceState, principals } from '../db/schema/index';
import type { PrincipalRow } from '../read/principals';

/** The person's principal in the burrow, or null while there is none (a box not claimed yet). */
export async function thePerson(db: Db | Tx, burrowId: string): Promise<PrincipalRow | null> {
  const people = await db
    .select()
    .from(principals)
    .where(and(eq(principals.burrowId, burrowId), eq(principals.kind, 'person'), isNull(principals.system)))
    .orderBy(asc(principals.position), asc(principals.createdAt), asc(principals.id));
  if (people.length <= 1) return people[0] ?? null;
  const [state] = await db
    .select({ claimer: applianceState.claimedByAccountId })
    .from(applianceState)
    .where(eq(applianceState.id, 1));
  return (
    people.find((p) => state?.claimer && p.accountId === state.claimer) ??
    people.find((p) => p.accountId !== null) ??
    people[0] ??
    null
  );
}

/** The person's account, or null. */
export async function thePersonAccountId(db: Db | Tx, burrowId: string): Promise<string | null> {
  return (await thePerson(db, burrowId))?.accountId ?? null;
}

/** Whether a principal is the person. */
export async function isThePerson(db: Db | Tx, burrowId: string, principalId: string): Promise<boolean> {
  return (await thePerson(db, burrowId))?.id === principalId;
}
