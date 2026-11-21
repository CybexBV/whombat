/**
 * An agent's last turn on its tool's default model (docs/decisions/model-effort.md ME-05): a runner says the agent's model
 * wasn't available for a turn (`CompleteBody.modelFallback`) and ran it again on the default; the agent keeps that (its
 * model, where, when) for Configure → Model's quiet note (`AgentProfile.modelFallback`, `modelFallbackText`), never in a
 * conversation. Where: the AI gateway the turn went through, the person whose sign-in it ran on, or the organization's
 * key. A later completed turn that ran on the agent's model clears it, and so does a change of model (`update_agent`).
 */
import type { ModelFallbackReport, ModelFallbackWhere } from '@whombat/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { principals, type StoredModelFallback } from '../db/schema/index';
import { gatewayName, isGatewayCatalogId, switchedGateway } from '../gateway/store';
import { signInPerson } from '../managed/providers/credential-owner';
import { agentRuntimeOf, loadPrincipalRow, type PrincipalRow } from '../read/principals';
import type { DispatchRow } from './context';

const NAME_MAX = 80;

/**
 * Where a dispatch's turn ran (ME-05): through the AI gateway it started on (its name while it is still the switched
 * one), else on the person's own sign-in (one-person.md OP-S09).
 */
export async function fallbackWhere(
  db: Db,
  row: Pick<DispatchRow, 'burrowId' | 'gatewayProvider' | 'onBehalfOfAccountId'>,
  agent: PrincipalRow,
): Promise<ModelFallbackWhere> {
  if (row.gatewayProvider) {
    const switched = await switchedGateway(db, row.burrowId, row.gatewayProvider);
    const connection = switched?.connection;
    return {
      kind: 'gateway',
      name: connection && isGatewayCatalogId(connection.catalogId) ? gatewayName(connection) : null,
    };
  }
  // The person's sign-in (one-person.md OP-S09).
  const person = await signInPerson(db, agent.burrowId);
  return { kind: 'account', name: person ? person.name.slice(0, NAME_MAX) : null };
}

/**
 * What a completed turn says about its agent's model (in the completion's transaction): a fallback is kept (only while
 * the agent still has that model), a turn that finished on the agent's own model clears the last one. Returns the stored
 * fallback, if one was kept.
 */
export async function noteModelFallback(
  tx: Tx,
  row: Pick<DispatchRow, 'agentId' | 'burrowId' | 'gatewayProvider' | 'onBehalfOfAccountId'>,
  body: { outcome: string; modelFallback?: ModelFallbackReport | undefined },
  now: Date,
): Promise<StoredModelFallback | null> {
  const report = body.modelFallback;
  if (!report) {
    if (body.outcome === 'done')
      await tx
        .update(principals)
        .set({ modelFallback: null })
        .where(and(eq(principals.id, row.agentId), isNotNull(principals.modelFallback)));
    return null;
  }
  const agent = await loadPrincipalRow(tx, row.agentId);
  if (agent?.kind !== 'agent') return null;
  // Its model changed while the turn ran: what the turn found is about a model it no longer has.
  if (agentRuntimeOf(agent.runtime).model !== report.model) return null;
  const stored: StoredModelFallback = {
    model: report.model,
    where: await fallbackWhere(tx, row, agent),
    at: now.toISOString(),
    detail: report.detail,
  };
  await tx.update(principals).set({ modelFallback: stored }).where(eq(principals.id, agent.id));
  return stored;
}
