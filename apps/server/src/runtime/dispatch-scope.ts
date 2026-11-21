/**
 * The dispatch an agent is acting in (CT-69, SUB-04): its MCP tool calls and the runner's completion run inside
 * `runInDispatchScope`, so a message the agent posts there — and the dispatches that message queues for other agents
 * (a handoff, a follow-up) — know whose work it is. `enqueueDispatches` carries the scope's person over to them: an
 * agent chain stays the person's, and one an outsiders' turn starts stays apart (one-person.md OP-17). An approved
 * request (a deferred command, a pack tool call) runs in a scope for the person recorded on its approval (SUB-28).
 * Outside a scope an agent's act is the person's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { dispatches, messages, runs } from '../db/schema/index';

export interface DispatchScope {
  /** Null: not a turn, an approved request running for the person it was made for (SUB-28). */
  dispatchId: string | null;
  agentId: string;
  /** The person the dispatch is for (`dispatches.on_behalf_of_account_id`); null: an outsiders' turn. */
  onBehalfOfAccountId: string | null;
}

const storage = new AsyncLocalStorage<DispatchScope>();

export function runInDispatchScope<T>(scope: DispatchScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/** The scope of a dispatch row. */
export function dispatchScopeOf(row: {
  id: string;
  agentId: string;
  onBehalfOfAccountId?: string | null;
}): DispatchScope {
  return { dispatchId: row.id, agentId: row.agentId, onBehalfOfAccountId: row.onBehalfOfAccountId ?? null };
}

/** The dispatch the current async context acts in, if any. */
export function currentDispatchScope(): DispatchScope | null {
  return storage.getStore() ?? null;
}

/**
 * The thread the agent's turn was asked in, when that turn works in `conversationId` (run-checkout.md RC-14): what
 * Whombat posts for the agent there — a run's card, an approval card — goes into that thread, like its replies, not
 * the channel. The turn is `dispatchId` when given, else the current scope's. Null outside a thread.
 */
export async function turnThread(
  tx: Pick<Db, 'select'>,
  args: { agentId: string; conversationId: string; dispatchId?: string | null },
): Promise<string | null> {
  const scope = currentDispatchScope();
  const dispatchId = args.dispatchId ?? (scope?.agentId === args.agentId ? scope.dispatchId : null);
  if (!dispatchId) return null;
  const [turn] = await tx
    .select({
      agentId: dispatches.agentId,
      conversationId: dispatches.conversationId,
      threadRootId: dispatches.threadRootId,
    })
    .from(dispatches)
    .where(eq(dispatches.id, dispatchId));
  if (turn?.agentId !== args.agentId || turn.conversationId !== args.conversationId) return null;
  return turn.threadRootId;
}

/**
 * The thread a run's turn answers in when the turn that asked gave none (vault-asks.md VA-02): the thread the run's card
 * was posted in (RC-14), or null at the top of the conversation.
 */
export async function cardThread(tx: Pick<Db, 'select'>, messageId: string | null): Promise<string | null> {
  if (!messageId) return null;
  const [card] = await tx
    .select({ threadRootId: messages.threadRootId })
    .from(messages)
    .where(eq(messages.id, messageId));
  return card?.threadRootId ?? null;
}

/**
 * The run a dispatch works on: the run it controls (`dispatches.run_id`), else the newest run started in it. What the
 * turn does besides — a skill it learns, a turn it schedules — is that run's (card-settle.md QC-02). Null: no run.
 */
export async function dispatchRun(
  tx: Pick<Db, 'select'>,
  dispatch: { id: string; runId: string | null },
): Promise<string | null> {
  if (dispatch.runId) return dispatch.runId;
  const [run] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.dispatchId, dispatch.id))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return run?.id ?? null;
}
