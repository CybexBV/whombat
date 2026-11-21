/**
 * A conversation's hand-overs to T3 Code (docs/decisions/t3code.md T3-24, T3-25): read for `conversations.handoffs`
 * and sent as the `conversation.handoffs` frame whenever what the person sees of one changed; and the hand-overs of one
 * thread as a turn working there reads them (`t3HandoffsOf`).
 */
import { type DispatchContext, HANDOFFS_MAX, type Handoff, T3_HANDOFFS_MAX, topics } from '@whombat/core';
import { and, desc, eq, gt, isNull, ne, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { catalogConnections, t3Watches } from '../db/schema/index';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { FINISHED, type T3Status } from '../things/kinds/business/t3code';
import { HANDOFF_RECEIPT_SHOWN_MS, handoffOf } from './handoff';

/** The conversation's hand-overs that show now, the oldest hand-over first. */
export async function conversationHandoffs(
  db: Db | Tx,
  burrowId: string,
  conversationId: string,
  now: Date,
): Promise<Handoff[]> {
  const rows = await db
    .select()
    .from(t3Watches)
    .where(
      and(
        eq(t3Watches.burrowId, burrowId),
        eq(t3Watches.conversationId, conversationId),
        // A council's threads show on its own card (council.md CNL-S02), a delegation's on its (delegate.md).
        isNull(t3Watches.councilId),
        isNull(t3Watches.delegationTaskId),
        or(
          eq(t3Watches.state, 'watching'),
          // Ended work: a while, or for days with its receipt (`handoffOf` decides).
          gt(t3Watches.runEndedAt, new Date(now.getTime() - HANDOFF_RECEIPT_SHOWN_MS)),
        ),
      ),
    )
    // The latest hand-overs: Chat is one conversation, and receipts stay listed for days.
    .orderBy(desc(t3Watches.armedAt))
    .limit(HANDOFFS_MAX * 2);
  return rows
    .reverse()
    .map((r) => handoffOf(r, now))
    .filter((h): h is Handoff => h !== null)
    .slice(-HANDOFFS_MAX);
}

/** Whether a watch's thread is at work or its work ended, as a turn's list of its thread's hand-overs says it. */
export function handoffStateOf(row: { state: string; status: string | null }): 'working' | 'ended' {
  const status = row.status as T3Status | null;
  const over = row.state !== 'watching' || (!!status && (FINISHED.includes(status) || status === 'idle'));
  return over ? 'ended' : 'working';
}

/**
 * `DispatchContext.t3Handoffs`: the T3 Code threads the agent handed work to from the thread a turn works in, newest
 * first, at most `T3_HANDOFFS_MAX`, so a follow-up finds its thread without listing all of T3 Code. Only on connections
 * that manage and can be reached; never a council's or a checklist's threads, which their own cards lead. Null when
 * there are none.
 */
export async function t3HandoffsOf(
  db: Db | Tx,
  row: { burrowId: string; agentId: string; conversationId: string; threadRootId: string | null },
): Promise<DispatchContext['t3Handoffs']> {
  const rows = await db
    .select({
      connection: catalogConnections.handle,
      threadId: t3Watches.threadId,
      title: t3Watches.title,
      state: t3Watches.state,
      status: t3Watches.status,
    })
    .from(t3Watches)
    .innerJoin(catalogConnections, eq(catalogConnections.id, t3Watches.connectionId))
    .where(
      and(
        eq(t3Watches.burrowId, row.burrowId),
        eq(t3Watches.agentId, row.agentId),
        eq(t3Watches.conversationId, row.conversationId),
        row.threadRootId ? eq(t3Watches.threadRootId, row.threadRootId) : isNull(t3Watches.threadRootId),
        isNull(t3Watches.councilId),
        isNull(t3Watches.delegationTaskId),
        eq(catalogConnections.status, 'active'),
        ne(catalogConnections.access, 'read'),
      ),
    )
    .orderBy(desc(t3Watches.armedAt))
    .limit(T3_HANDOFFS_MAX);
  const handoffs = rows.map((r) => ({
    connection: r.connection,
    threadId: r.threadId,
    title: r.title.slice(0, 160) || 'A T3 Code thread',
    state: handoffStateOf(r),
  }));
  return handoffs.length ? handoffs : null;
}

/** Sends the conversation's hand-overs to whoever has it open. Never throws: the next read shows them anyway. */
export async function publishHandoffs(
  services: Services,
  burrowId: string,
  conversationId: string,
): Promise<void> {
  try {
    const now = services.clock();
    const handoffs = await conversationHandoffs(services.db, burrowId, conversationId, now);
    services.bus.publish({
      topic: topics.conversation(conversationId),
      event: { type: 'conversation.handoffs', conversationId, handoffs },
      eventId: null,
      at: iso(now),
      outboxId: null,
    });
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      't3 hand-overs could not be sent',
    );
  }
}
