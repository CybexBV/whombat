/**
 * `connection_call` approvals (docs/decisions/connections-catalog.md CX-21, contracts CT-271).
 *
 * - **Who sees what was asked.** The action names the connection and the tool, never the arguments: they stay sealed in
 *   the deferred command. `Approval.connection` (label, entry and an arguments preview) is filled on reads and realtime
 *   frames for the person and the agent that asked, nobody else.
 * - **What a yes runs.** The deferred `call_connection_tool` command, once (the engine prefers it); the executor
 *   registered for the type only refuses an approval that has none (nothing else may carry this action).
 */
import type { Approval, ApprovalConnectionDetail, Message } from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ExecutionReconciler, Executor } from '../approvals/engine';
import type { Db, Tx } from '../db/client';
import { approvals, catalogConnections, events, principals } from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';
import type { Services } from '../services';
import { callArgsAad } from './call';

/** The preview's length (`ApprovalConnectionDetail.argumentsPreview`). */
const PREVIEW_MAX = 1000;

/** Key custody per database handle, so reads that only get `db` can open a preview (set once per server). */
const custodyByDb = new WeakMap<object, KeyCustody>();

/** Lets reads on this server's database open argument previews. Called when the services are made. */
export function registerConnectionApprovalReads(services: Services): void {
  custodyByDb.set(services.db, services.custody);
}

/** The arguments as deciders read them: compact JSON, cut at 1 000 characters. */
export function argumentsPreview(args: unknown): string {
  const text = JSON.stringify(args ?? {});
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/** `connection_call` approval details for `viewerId`, by approval id (only for those who may decide them). */
export async function approvalConnectionDetails(
  db: Db | Tx,
  list: readonly Pick<Approval, 'id' | 'action'>[],
  viewerId: string | null,
): Promise<Map<string, ApprovalConnectionDetail>> {
  const out = new Map<string, ApprovalConnectionDetail>();
  if (!viewerId) return out;
  const ids = list.filter((a) => a.action.type === 'connection_call').map((a) => a.id);
  if (!ids.length) return out;
  const rows = await db.select().from(approvals).where(inArray(approvals.id, ids));
  const connectionIds = [
    ...new Set(
      rows.flatMap((r) => (r.action.type === 'connection_call' ? [r.action.params.connectionId] : [])),
    ),
  ];
  if (!connectionIds.length) return out;
  const connections = await db
    .select({
      id: catalogConnections.id,
      label: catalogConnections.label,
      catalogId: catalogConnections.catalogId,
      burrowId: catalogConnections.burrowId,
    })
    .from(catalogConnections)
    .where(inArray(catalogConnections.id, connectionIds));
  const [viewer] = await db
    .select({ id: principals.id, kind: principals.kind, burrowId: principals.burrowId })
    .from(principals)
    .where(inArray(principals.id, [viewerId]));
  const custody = custodyByDb.get(db);
  for (const row of rows) {
    if (row.action.type !== 'connection_call') continue;
    const connection = connections.find(
      (c) => c.id === (row.action as { params: { connectionId: string } }).params.connectionId,
    );
    if (!connection) continue;
    // The person decides it, the agent asked it (one-person.md OP-S53): nobody else reads the arguments.
    const allowed =
      viewerId === row.requesterId || (viewer?.kind === 'person' && viewer.burrowId === connection.burrowId);
    if (!allowed) continue;
    let preview: string | null = null;
    const input = row.command?.input as { callId?: unknown; argsEnc?: unknown } | undefined;
    if (custody && typeof input?.callId === 'string' && typeof input.argsEnc === 'string') {
      try {
        preview = argumentsPreview(JSON.parse(custody.open(callArgsAad(input.callId), input.argsEnc)));
      } catch {
        preview = null;
      }
    }
    out.set(row.id, { label: connection.label, catalogId: connection.catalogId, argumentsPreview: preview });
  }
  return out;
}

/** The approvals as `viewerId` may see them: `connection` filled only for those who may decide. */
export async function withApprovalConnectionDetail<A extends Approval>(
  db: Db | Tx,
  list: A[],
  viewerId: string | null,
): Promise<A[]> {
  const details = await approvalConnectionDetails(db, list, viewerId);
  if (!details.size) return list;
  return list.map((a) => {
    const connection = details.get(a.id);
    return connection ? { ...a, connection } : a;
  });
}

function connectionCardOf(message: Message): Approval | null {
  const card = message.card;
  return card?.kind === 'approval' && card.approval.action.type === 'connection_call' ? card.approval : null;
}

/** Messages as `viewerId` may see them: a `connection_call` approval card with its detail for its deciders. */
export async function withMessageConnectionDetail(
  db: Db | Tx,
  messages: Message[],
  viewerId: string | null,
): Promise<Message[]> {
  const cards = messages.map(connectionCardOf).filter((a): a is Approval => a !== null);
  if (!cards.length) return messages;
  const details = await approvalConnectionDetails(db, cards, viewerId);
  if (!details.size) return messages;
  return messages.map((m) => {
    const approval = connectionCardOf(m);
    const connection = approval ? details.get(approval.id) : undefined;
    return connection && approval
      ? { ...m, card: { kind: 'approval' as const, approval: { ...approval, connection } } }
      : m;
  });
}

/**
 * The `connection_call` executor: a yes runs the deferred call (the engine runs the command it holds, never this). An
 * approval without one carries nothing to run, and says so instead of claiming it ran (EA-03).
 */
export const connectionCallExecutor: Executor = async (approval) => {
  if (approval.action.type !== 'connection_call') throw new Error('Not a connection_call approval.');
  return {
    ok: false,
    error: 'nothing was called: the request it was asked for is gone. Ask the agent to try again.',
  };
};

/**
 * After a crash, what happened to an approved call, from its own records: with no `connection.tool_called` the call's
 * commit never happened, so it never ran and runs once now; a `connection.tool_finished` that worked is done; anything
 * between may have reached the service and is never sent again (the approval says it is uncertain).
 */
export const connectionCallReconciler =
  (db: Db): ExecutionReconciler =>
  async (_approval, row) => {
    const callId = row.command?.input.callId;
    if (typeof callId !== 'string') return 'unknown';
    const found = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        and(
          // Both are the agent's own events (the actor index finds them).
          eq(events.burrowId, row.burrowId),
          eq(events.actorId, row.requesterId),
          inArray(events.type, ['connection.tool_called', 'connection.tool_finished']),
          sql`${events.payload}->>'callId' = ${callId}`,
        ),
      );
    if (!found.some((e) => e.type === 'connection.tool_called')) return 'not_done';
    const finished = found.find((e) => e.type === 'connection.tool_finished');
    return finished?.payload.outcome === 'done' ? 'done' : 'unknown';
  };
