/**
 * The person the agent's act is for (docs/decisions/one-person.md OP-01, OP-17): the person, except inside an
 * outsiders' turn (its dispatch scope queued for nobody, `runtime/person.ts`), which is for nobody and sees none of the
 * person's private things.
 */
import type { Db, Tx } from '../db/client';
import type { PrincipalRow } from '../read/principals';
import { currentDispatchScope } from '../runtime/dispatch-scope';
import { thePerson } from './the-person';

/** The person when `accountId` is theirs, else null (an outsiders' turn, someone who was here before OP-01). */
export async function personOfAccountIn(
  db: Db | Tx,
  burrowId: string,
  accountId: string | null | undefined,
): Promise<PrincipalRow | null> {
  if (!accountId) return null;
  const person = await thePerson(db, burrowId);
  return person?.accountId === accountId ? person : null;
}

/** The person `agentId`'s current act is for: null inside an outsiders' turn (and while the box has no person). */
export async function turnPerson(
  db: Db | Tx,
  ctx: { burrowId: string; agentId: string },
): Promise<PrincipalRow | null> {
  const scope = currentDispatchScope();
  if (scope?.agentId === ctx.agentId && !scope.onBehalfOfAccountId) return null;
  return thePerson(db, ctx.burrowId);
}
