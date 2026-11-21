/**
 * A person's yes wakes the agent that asked (docs/decisions/essentials-agents.md EA-07, contracts CT-168): a turn with
 * trigger `approval_granted` in the approval's conversation and thread (the card's), for the person the asking turn was
 * for, carrying the approval (`DispatchContext.grantedApproval`) so the agent may now do it. A queued reply turn of the
 * agent there for that person takes the wake over; a live turn already carrying on after the same approval gets no
 * second one.
 */
import type { Approval } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { threadedRoom } from '../chats/rooms';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { approvals, dispatches, messages, runs } from '../db/schema/index';
import { liveTurnForApproval, wakeQuietly } from '../domain/wake';
import { loadConversationRow } from '../read/conversations';
import type { Services } from '../services';

export const wakeForApproval = defineCommand({
  name: 'approval.wake_requester',
  schema: z.object({ approvalId: z.string() }),
  async apply(tx, ctx, input): Promise<{ dispatchId: string; created: boolean } | null> {
    const [row] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId));
    if (!row || row.burrowId !== ctx.burrow.id || row.state !== 'approved') return null;
    const live = await liveTurnForApproval(ctx, row.id, row.requesterId);
    if (live) return { dispatchId: live, created: false };
    // The card's thread: the thread it was posted in, else a new one under it.
    const [card] = row.messageId
      ? await tx
          .select({ id: messages.id, threadRootId: messages.threadRootId })
          .from(messages)
          .where(eq(messages.id, row.messageId))
      : [];
    const runId = await approvalRun(tx, row);
    // A person's pause or take over also holds approval follow-ups for that run.
    if (runId) {
      const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
      if (run?.status === 'paused' || run?.status === 'taken_over') return null;
    }
    return wakeQuietly(ctx, {
      agentId: row.requesterId,
      conversationId: row.conversationId,
      threadRootId: card ? (card.threadRootId ?? card.id) : null,
      person: row.onBehalfOfAccountId ?? null,
      trigger: 'approval_granted',
      coalesce: true,
      approvalId: row.id,
      runId,
    });
  },
});

/** The recorded owner, or a single run started by the asking turn. Never guess among several runs. */
export async function approvalRun(db: Db, approval: typeof approvals.$inferSelect): Promise<string | null> {
  if (approval.runId) {
    const [run] = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, approval.runId),
          eq(runs.burrowId, approval.burrowId),
          eq(runs.agentId, approval.requesterId),
        ),
      );
    return run && (run.status === 'live' || run.status === 'paused' || run.status === 'taken_over')
      ? run.id
      : null;
  }
  if (!approval.createdByDispatchId) return null;
  const [origin] = await db
    .select()
    .from(dispatches)
    .where(
      and(
        eq(dispatches.id, approval.createdByDispatchId),
        eq(dispatches.burrowId, approval.burrowId),
        eq(dispatches.agentId, approval.requesterId),
      ),
    );
  if (!origin) return null;
  const candidates = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        origin.runId ? eq(runs.id, origin.runId) : eq(runs.dispatchId, origin.id),
        eq(runs.burrowId, approval.burrowId),
        eq(runs.agentId, approval.requesterId),
        inArray(runs.status, ['live', 'paused', 'taken_over']),
      ),
    )
    .limit(2);
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
}

/**
 * The thread in `conversationId` where what follows a yes is said (task-feedback.md TF-04): the approval card's thread;
 * a card at the top of a threaded room (a person's Chat) opens one under it, as the wake does; at the top of
 * a flat room, none. Null too when the card isn't in that conversation.
 */
export async function approvalThread(
  db: Db,
  approvalId: string,
  conversationId: string,
): Promise<string | null> {
  const [card] = await db
    .select({ id: messages.id, threadRootId: messages.threadRootId, conversationId: messages.conversationId })
    .from(approvals)
    .innerJoin(messages, eq(messages.id, approvals.messageId))
    .where(eq(approvals.id, approvalId));
  if (!card || card.conversationId !== conversationId) return null;
  if (card.threadRootId) return card.threadRootId;
  const room = await loadConversationRow(db, conversationId);
  return room && threadedRoom(room) ? card.id : null;
}

/**
 * Wakes the requesting agent after a yes (signed by the person who said it). Never fails the approval: an agent that
 * can't be woken there any more (it left the room) is simply not woken.
 */
export async function wakeRequester(services: Services, approval: Approval): Promise<void> {
  try {
    await services.pipeline.commit(
      wakeForApproval,
      { approvalId: approval.id },
      { burrowId: approval.burrowId, actorId: approval.decidedById ?? approval.requesterId },
    );
  } catch (err) {
    services.log.warn({ err: String(err), approvalId: approval.id }, 'could not wake the agent after a yes');
  }
}
