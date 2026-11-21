/**
 * Which connection the agent acts as (docs/decisions/connectors.md "Tools"; one-person.md OP-S51): the person's, whose
 * account holds it (one per account and provider), in the person's turns. An outsiders' turn (queued for nobody) acts
 * as nobody's (OP-17).
 */
import type { ConnectorProvider } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections } from '../db/schema/index';
import { personOfAccountIn } from '../domain/turn-person';
import { loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { currentDispatchScope } from '../runtime/dispatch-scope';

export type ConnectionRow = typeof connections.$inferSelect;

export interface AgentConnection {
  /** The agent. */
  agent: PrincipalRow;
  /** The person its turn is for. */
  person: PrincipalRow;
  /** The person's account (connections belong to accounts, not burrows). */
  accountId: string;
  /** The person's connection for the provider, whatever its status; null when they have not connected. */
  connection: ConnectionRow | null;
}

/** The account the agent's current turn is for (its dispatch scope), or null outside one. */
export function scopeAccountOf(agentId: string): string | null {
  const scope = currentDispatchScope();
  return scope?.agentId === agentId ? scope.onBehalfOfAccountId : null;
}

/**
 * The person and connection behind the agent's turn: the person when `forAccountId` (by default the current turn's) is
 * theirs; null in an outsiders' turn.
 */
export async function connectionForAgent(
  db: Db,
  agentId: string,
  provider: ConnectorProvider = 'google',
  forAccountId: string | null = scopeAccountOf(agentId),
): Promise<AgentConnection | null> {
  return (await connectionsForAgent(db, agentId, [provider], forAccountId)).get(provider) ?? null;
}

/**
 * `connectionForAgent` for several providers: the agent (`agent` when the caller already read it), the person and their
 * connections read once. A provider maps to null where `connectionForAgent` answers null.
 */
export async function connectionsForAgent(
  db: Db,
  agentId: string,
  providers: readonly ConnectorProvider[],
  forAccountId: string | null,
  agent?: PrincipalRow,
): Promise<Map<ConnectorProvider, AgentConnection | null>> {
  const none = new Map(providers.map((p) => [p, null]));
  const row = agent ?? (await loadPrincipalRow(db, agentId));
  if (row?.kind !== 'agent' || row.id !== agentId || !forAccountId || providers.length === 0) return none;
  const person = await personOfAccountIn(db, row.burrowId, forAccountId);
  if (!person?.accountId) return none;
  const accountId = person.accountId;
  const found = await db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), inArray(connections.provider, [...providers])));
  return new Map(
    providers.map((p) => [
      p,
      { agent: row, person, accountId, connection: found.find((c) => c.provider === p) ?? null },
    ]),
  );
}

/** An account's connection for a provider, or null. */
export async function connectionOfAccount(
  db: Db,
  accountId: string,
  provider: ConnectorProvider = 'google',
): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), eq(connections.provider, provider)));
  return row ?? null;
}
