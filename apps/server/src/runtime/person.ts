/**
 * Whom a turn is for (docs/decisions/one-person.md OP-01, OP-17): every turn is the person's — what they ask, their own
 * automations and schedules, what the agent does on its own — except a turn that outsiders' input starts (a website
 * Feedback assessment, a tracker customer's report or reply), which stays apart: no access to the person's mail,
 * calendar, files, Vault or memory, and its own Hermes profile on the runner.
 *
 * The dispatch says which (`dispatches.on_behalf_of_account_id`, CT-69, set when it is queued): the person's account,
 * or null for an outsiders' turn. `DispatchContext.onBehalfOf` follows it: null only in an outsiders' turn.
 */
import type { Db, Tx } from '../db/client';
import { personOfAccountIn } from '../domain/turn-person';
import type { PrincipalRow } from '../read/principals';
import type { DispatchRow } from './context';

/** Whether a dispatch is an outsiders' turn (OP-17): queued for nobody. */
export function outsidersTurn(row: Pick<DispatchRow, 'onBehalfOfAccountId'>): boolean {
  return !row.onBehalfOfAccountId;
}

/**
 * The person a dispatch's turn is for, or null for an outsiders' turn — and for a turn queued for an account that isn't
 * the person's (someone who was on the box before OP-01): nobody's, so nothing private.
 */
export async function dispatchPerson(
  db: Db | Tx,
  row: Pick<DispatchRow, 'burrowId' | 'onBehalfOfAccountId'>,
): Promise<PrincipalRow | null> {
  if (outsidersTurn(row)) return null;
  return personOfAccountIn(db, row.burrowId, row.onBehalfOfAccountId);
}
