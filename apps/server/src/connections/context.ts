/**
 * Which connections the agent can see in a turn (docs/decisions/connections-catalog.md CX-25, CX-35; one-person.md
 * OP-S51):
 *
 * - Every connection of the agent's burrow in the person's turns.
 * - None in an outsiders' turn (OP-17: no mail, calendar or files of the person's), a Feedback assessment, a search
 *   answer; none without a catalog key (`connections.read` or `connections.write` at Allowed or Asks: holding one
 *   lists them, CT-271).
 * - T3 Code alone in the turn of an automation step on a tracker report, which hands looking into the code to it
 *   (outsiders-turns.md OT-11).
 * - Never a connection only automations use (a tracker, `isAgentConnection`; report-trackers.md TA-02).
 *
 * Handles are what agents name connections by (CX-05), unique in the burrow.
 */
import {
  type CatalogEntry,
  catalogEntry,
  type DispatchConnection,
  decide,
  type Grant,
  type Tier,
} from '@whombat/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { automationRunSteps, automationRuns, catalogConnections, type dispatches } from '../db/schema/index';
import { loadGrants, loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { outsidersTurn } from '../runtime/person';
import { isCallableEntry } from './callable';
import type { CatalogConnectionRow } from './types';

export type ConnectionDispatch = Pick<
  typeof dispatches.$inferSelect,
  'id' | 'burrowId' | 'agentId' | 'trigger' | 'mode' | 'search' | 'onBehalfOfAccountId'
>;

/** A connection an agent can see now, with the handle it names it by. */
export interface VisibleConnection {
  row: CatalogConnectionRow;
  entry: CatalogEntry;
  handle: string;
  /** Seen by a turn on a tracker report: its calls are narrowed to that job (`report-turn.ts`). */
  reportTurn: boolean;
}

/** A turn that never uses connections (CX-30): an outsiders' turn (OP-17), a Feedback assessment, a search answer. */
export function connectionless(
  d: Pick<ConnectionDispatch, 'trigger' | 'mode' | 'search' | 'onBehalfOfAccountId'>,
): boolean {
  return (
    outsidersTurn(d) ||
    d.trigger === 'feedback' ||
    d.trigger === 'search' ||
    d.mode === 'answer' ||
    d.search !== null
  );
}

/** The catalog entry an outsiders' turn on a tracker report may use (OT-11): T3 Code, for looking into the code. */
const REPORT_TURN_CATALOG_ID = 't3code';

/** Whether the turn is an automation step on a tracker report: its run's scope is the report. */
async function trackerItemTurn(
  db: Db | Tx,
  dispatch: Pick<ConnectionDispatch, 'id' | 'trigger'>,
): Promise<boolean> {
  if (dispatch.trigger !== 'automation') return false;
  const [row] = await db
    .select({ id: automationRuns.id })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .where(
      and(
        eq(automationRunSteps.dispatchId, dispatch.id),
        sql`${automationRuns.scope} ->> 'kind' = 'tracker'`,
      ),
    )
    .limit(1);
  return !!row;
}

/** The tier an agent's grants give a catalog key: `can`, `ask` or `cannot`. */
export function keyTierOf(
  agentId: string,
  grants: readonly Grant[],
  keyId: 'connections.read' | 'connections.write',
): Tier {
  const decision = decide({ id: agentId, kind: 'agent' }, grants, keyId);
  return decision.outcome === 'allow' ? 'can' : decision.outcome === 'ask' ? 'ask' : 'cannot';
}

/** Whether an agent holds a catalog key at all (Allowed or Asks). */
export function holdsConnectionKey(agentId: string, grants: readonly Grant[]): boolean {
  return (
    keyTierOf(agentId, grants, 'connections.read') !== 'cannot' ||
    keyTierOf(agentId, grants, 'connections.write') !== 'cannot'
  );
}

/** The connections an agent can see in this turn (any state: one needing reauth is still named in the instructions). */
export async function visibleConnections(
  db: Db | Tx,
  agentId: string,
  dispatch: ConnectionDispatch,
  /** The agent's row, when the caller already read it. */
  agentRow?: PrincipalRow,
  /** The agent's grants, when the caller already read them. */
  grants?: readonly Grant[],
): Promise<VisibleConnection[]> {
  // An outsiders' turn on a tracker report hands looking into the code to T3 Code (OT-11, John's choice): that alone.
  const reportTurn = outsidersTurn(dispatch) && (await trackerItemTurn(db, dispatch));
  if (connectionless(dispatch) && !reportTurn) return [];
  const agent = agentRow ?? (await loadPrincipalRow(db as Db, agentId));
  if (agent?.kind !== 'agent' || agent.id !== agentId || agent.burrowId !== dispatch.burrowId) return [];
  if (!holdsConnectionKey(agent.id, grants ?? (await loadGrants(db as Db, agent.id)))) return [];
  const rows = await db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, agent.burrowId))
    .orderBy(asc(catalogConnections.createdAt), asc(catalogConnections.id));
  const out: VisibleConnection[] = [];
  for (const row of rows) {
    const entry = catalogEntry(row.catalogId);
    // Connections only automations use (trackers, report-trackers.md TA-02) are never an agent's.
    if (!entry || !isCallableEntry(entry)) continue;
    if (reportTurn && entry.id !== REPORT_TURN_CATALOG_ID) continue;
    out.push({ row, entry, handle: row.handle, reportTurn });
  }
  return out;
}

/** The visible connection an agent names by `handle`, or null. */
export async function connectionByHandle(
  db: Db | Tx,
  agentId: string,
  dispatch: ConnectionDispatch,
  handle: string,
): Promise<VisibleConnection | null> {
  const wanted = handle.trim().toLowerCase();
  return (await visibleConnections(db, agentId, dispatch)).find((c) => c.handle === wanted) ?? null;
}

/**
 * `DispatchContext.connections` (CX-35): one line each in the instructions. Never a field value or a secret. A
 * connection that looks only says so (`access: 'read'`, CS-10); absent means it manages (CS-D15).
 */
export async function connectionsContextFor(
  db: Db | Tx,
  agentId: string,
  dispatch: ConnectionDispatch,
  /** The agent's row and grants, when the caller already read them. */
  known: { agentRow?: PrincipalRow; grants?: readonly Grant[] } = {},
): Promise<DispatchConnection[]> {
  const visible = await visibleConnections(db, agentId, dispatch, known.agentRow, known.grants);
  return visible.map((c) => {
    return {
      handle: c.handle,
      catalogId: c.row.catalogId,
      name: c.entry.name,
      label: c.row.label,
      status: c.row.status,
      ...(c.row.access === 'read' ? { access: 'read' as const } : {}),
    };
  });
}

/**
 * Whether the agent can use at least one connection in this turn (the two tools are listed then, CX-30): `dispatch` is
 * the turn's row, which the caller has already read.
 */
export async function seesActiveConnection(
  db: Db | Tx,
  agentId: string,
  dispatch: ConnectionDispatch | undefined,
  agentRow?: PrincipalRow,
): Promise<boolean> {
  if (!dispatch || dispatch.agentId !== agentId) return false;
  return (await visibleConnections(db, agentId, dispatch, agentRow)).some((c) => c.row.status === 'active');
}
