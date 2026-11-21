/**
 * `runner.loginSecret` (docs/decisions/hermes-engine.md HE-42, HE-S141; contracts CT-1231): the password of one login of
 * the turn, for its Hermes to fill, at that moment. The login must still be one of the turn's own — the rule that built
 * `DispatchContext.logins`, read again: the person's turn, the key switched on, the agent holding `browser.use` — and the
 * Vault decides as for every use (`vault.use`, signed
 * as the agent; its refusal a neutral `vault.refused`). Each fetch is a use in the person's RECENT USE (“in Dusty's browser
 * for this turn”), recorded once per turn. Never logged.
 */
import { type DispatchLoginSecret, vaultTurnUseWhat } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { vaultUses } from '../db/schema/index';
import { notFound } from '../lib/errors';
import { loadPrincipalRow, shortName } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import type { Services } from '../services';
import { entryById } from '../vault/store';
import { currentTotp } from '../vault/totp-code';
import { decideVaultUseCommand, recordUse, unseal } from '../vault/uses';
import { browserContextFor, turnLoginsFor } from './context';

/** Whether `entryId` is one of the turn's logins now (as `DispatchContext.logins` was built). */
async function turnHasLogin(services: Services, dispatch: DispatchRow, entryId: string): Promise<boolean> {
  // An assessment never signs in (one-person.md OP-17).
  if (dispatch.trigger === 'feedback') return false;
  const agent = await loadPrincipalRow(services.db, dispatch.agentId);
  if (!agent) return false;
  const browser = await browserContextFor(services, agent, dispatch);
  return (await turnLoginsFor(services, agent, dispatch, browser)).some((l) => l.entryId === entryId);
}

export async function loginSecretFor(
  services: Services,
  dispatch: DispatchRow,
  entryId: string,
): Promise<DispatchLoginSecret> {
  if (!(await turnHasLogin(services, dispatch, entryId))) throw notFound('Login');
  const agent = await loadPrincipalRow(services.db, dispatch.agentId);
  const what = vaultTurnUseWhat('login', agent ? shortName(agent) : 'the agent');
  const decided = await services.pipeline.commit(
    decideVaultUseCommand,
    { dispatchId: dispatch.id, entryId, kind: 'sign_in', what },
    { burrowId: dispatch.burrowId, actorId: dispatch.agentId, onBehalfOf: {} },
  );
  if (decided.status !== 'ok' || decided.result.kind !== 'run') throw notFound('Login');
  const entry = await entryById(services.db, entryId);
  const password = entry ? unseal(services, entry).secret : null;
  if (!entry || !password) throw notFound('Login');
  // One line in the person's RECENT USE per turn and login, however often Hermes fills it.
  const [already] = await services.db
    .select({ id: vaultUses.id })
    .from(vaultUses)
    .where(
      and(eq(vaultUses.dispatchId, dispatch.id), eq(vaultUses.entryId, entryId), eq(vaultUses.what, what)),
    )
    .limit(1);
  if (!already)
    await recordUse(
      services,
      { agentId: dispatch.agentId, burrowId: dispatch.burrowId, onBehalfOf: {} },
      { entryId, dispatchId: dispatch.id, what, outcome: 'done', status: null, ms: 0, bytes: null },
    );
  // The current code of its authenticator key, made here: the key never leaves the server (vault-simplify.md VLT-46).
  return { password, otp: currentTotp(services, entry) };
}
