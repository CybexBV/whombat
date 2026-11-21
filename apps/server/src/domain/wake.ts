/**
 * Waking an agent without a message (a turn nobody typed): the person's yes or no to a Vault ask (vault.md VT-32) and
 * their yes to what the agent asked for (docs/decisions/essentials-agents.md EA-07, trigger `approval_granted`).
 */
import { type DispatchTrigger, newId } from '@whombat/core';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { dispatchRuntimeFor } from '../chats/thread-runtime';
import type { ApplyContext } from '../commit/types';
import { dispatches } from '../db/schema/index';
import { loadConversationRow } from '../read/conversations';
import { accountInBurrow, loadPrincipalRow } from '../read/principals';
import { publishDispatch } from '../runtime/activity';

export interface QuietWake {
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  /** The person the turn is for (an account); null: nobody. */
  person: string | null;
  trigger: DispatchTrigger;
  /**
   * A queued reply turn for the same agent, conversation, thread and person takes the wake over (else a new one is
   * queued).
   */
  coalesce: boolean;
  /** Its own turn: no queued turn takes it over (a person's Undo of a reported change, home-redesign.md HR-03). */
  own?: boolean;
  /** The approval the turn carries on after (EA-07): stored on the dispatch, its context gets `grantedApproval`. */
  approvalId?: string | null;
  /**
   * A live run the turn carries on (vault-asks.md VA-03): a run turn of it (mode `run`, with the run's checkout), which
   * only a queued turn of the same run takes over.
   */
  runId?: string | null;
  /**
   * The message the new turn is about (its trigger message): what a background job said. A queued turn that takes the
   * wake over keeps its own.
   */
  messageId?: string | null;
  /** Automatic background work (Looks and care plans): uses the agent's background model when one is set. */
  background?: boolean;
}

/**
 * Wakes an agent in a conversation for a person without a message (VT-32, EA-07): a queued dispatch for the same agent,
 * conversation, thread and person takes it over when `coalesce` (else a new one is queued); one in another thread never
 * does, as that thread's turn may run beside this one's (hermes-native.md HN-T04). Null when it can't be woken there
 * (not a conversation of the burrow).
 */
export async function wakeQuietly(
  ctx: ApplyContext,
  args: QuietWake,
): Promise<{ dispatchId: string; created: boolean } | null> {
  const { tx } = ctx;
  const agent = await loadPrincipalRow(tx, args.agentId);
  // A turn for an account without a person here is nobody's (one-person.md OP-S08).
  if (agent?.kind !== 'agent') return null;
  if (args.person && !(await accountInBurrow(tx, ctx.burrow.id, args.person))) return null;
  const room = await loadConversationRow(tx, args.conversationId);
  if (!room || room.burrowId !== ctx.burrow.id) return null;
  const [queued] = args.own
    ? []
    : await tx
        .select({ id: dispatches.id, approvalId: dispatches.approvalId })
        .from(dispatches)
        .where(
          and(
            eq(dispatches.agentId, agent.id),
            eq(dispatches.conversationId, args.conversationId),
            eq(dispatches.state, 'queued'),
            args.runId
              ? and(eq(dispatches.mode, 'run'), eq(dispatches.runId, args.runId))
              : eq(dispatches.mode, 'reply'),
            args.coalesce
              ? notInArray(dispatches.trigger, ['expand', 'approval_declined'])
              : eq(dispatches.trigger, args.trigger),
            args.person
              ? eq(dispatches.onBehalfOfAccountId, args.person)
              : isNull(dispatches.onBehalfOfAccountId),
            args.threadRootId
              ? eq(dispatches.threadRootId, args.threadRootId)
              : isNull(dispatches.threadRootId),
            // A turn waiting for a usage limit's reset is its own (resourceful-agents.md RA-DS12): the wake gets a turn
            // now, instead of waiting for the reset or going with that turn when a newer one supersedes it.
            isNull(dispatches.requeuedFor),
          ),
        )
        .limit(1);
  // A queued turn carrying on after another approval keeps it; a new one is queued for this one.
  if (queued && (!args.approvalId || !queued.approvalId || queued.approvalId === args.approvalId)) {
    if (args.approvalId && !queued.approvalId)
      await tx.update(dispatches).set({ approvalId: args.approvalId }).where(eq(dispatches.id, queued.id));
    return { dispatchId: queued.id, created: false };
  }
  const id = newId('dispatch');
  const [inserted] = await tx
    .insert(dispatches)
    .values({
      id,
      burrowId: ctx.burrow.id,
      agentId: agent.id,
      trigger: args.trigger,
      mode: args.runId ? 'run' : 'reply',
      conversationId: args.conversationId,
      messageId: args.messageId ?? null,
      threadRootId: args.threadRootId,
      runId: args.runId ?? null,
      state: 'queued',
      onBehalfOfAccountId: args.person,
      approvalId: args.approvalId ?? null,
      // A wake in a thread of the person's Chat runs on the thread's choice (chat-runtime.md CR-02, CR-S04).
      runtime: await dispatchRuntimeFor(tx, {
        agent,
        conversation: room,
        threadRootId: args.threadRootId,
        trigger: args.trigger,
        background: args.background,
      }),
      createdAt: ctx.now,
    })
    .returning();
  if (inserted) publishDispatch(ctx, inserted);
  await ctx.append(ctx.actor.id, {
    type: 'dispatch.created',
    kind: 'System',
    text: null,
    where: null,
    aboutId: agent.id,
    payload: {
      dispatchId: id,
      agentId: agent.id,
      trigger: args.trigger,
      mode: args.runId ? 'run' : 'reply',
      messageId: args.messageId ?? null,
      ...(args.approvalId ? { approvalId: args.approvalId } : {}),
    },
    createdAt: ctx.at,
  });
  const services = ctx.services;
  ctx.after(async () => {
    services.typing.start(
      { conversationId: args.conversationId, threadRootId: args.threadRootId, principalId: agent.id },
      id,
    );
    services.runtime.wake();
  });
  return { dispatchId: id, created: true };
}

/** A live turn of the agent already carrying on after this approval (EA-07: never a second wake for it). */
export async function liveTurnForApproval(
  ctx: Pick<ApplyContext, 'tx'>,
  approvalId: string,
  agentId: string,
) {
  const [row] = await ctx.tx
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.approvalId, approvalId),
        eq(dispatches.agentId, agentId),
        inArray(dispatches.state, ['queued', 'claimed', 'running']),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
