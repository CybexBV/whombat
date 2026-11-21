/**
 * Whose AI sign-in the agent's turns run on (docs/decisions/one-person.md OP-09, OP-S09): the person's own Claude or
 * ChatGPT sign-in, or an API key they added, in their one credential home per provider. Every turn runs on it, the
 * turns outsiders' input starts too (OP-17); there is no source to choose. The runner reads which provider and the
 * sign-in's mode from `DispatchContext.credential`.
 */
import type { DispatchContext, DispatchCredential } from '@whombat/core/contracts';
import type { Db } from '../../db/client';
import { loadPersonRow, type PrincipalRow, shortName } from '../../read/principals';
import type { Services } from '../../services';
import { providerLogins } from './service';

/** The person whose sign-ins the agent's turns run on, with their account (null before the burrow has its person). */
export async function signInPerson(
  db: Db,
  burrowId: string,
): Promise<{ accountId: string; name: string; row: PrincipalRow } | null> {
  const person = await loadPersonRow(db, burrowId);
  return person?.accountId ? { accountId: person.accountId, name: shortName(person), row: person } : null;
}

/**
 * The claim answer's `DispatchContext.credential` (contracts 3.0): the agent's provider and the person's sign-in mode
 * for it, read where the sign-ins can be read now (the runner's, through the bridge, once it polls).
 */
export async function dispatchCredential(
  services: Services,
  ctx: DispatchContext,
): Promise<DispatchCredential | null> {
  const provider = ctx.agent.runtime.provider;
  const logins = providerLogins(services);
  let authMode: string | null = null;
  if ((provider === 'claude' || provider === 'codex') && logins.readable)
    authMode = (await logins.record(provider))?.authMode ?? null;
  return { v: 1, provider, authMode };
}
