/**
 * An approved call answers in words (docs/decisions/home-redesign.md HR-04; contracts CT-407): a `connection_call` that
 * ran after a person's yes no longer posts its raw output as the agent's message. Its result is kept on
 * the approval, sealed (`approvals.result_enc`, AAD `approval:<id>:result`), and the agent that asked is woken where it
 * asked (trigger `approval_granted`, as for commands, EA-07): its turn reads the result as
 * `DispatchContext.grantedResult` and tells the person in its own words. When no agent can be woken there any more, one
 * plain line is posted instead (“Done.”, “It didn’t work. …”).
 */
import { GRANTED_RESULT_TEXT_MAX, type GrantedResultContext } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { sendInThread } from '../commands/messages';
import { defineCommand } from '../commit/types';
import { approvals } from '../db/schema/index';
import type { Services } from '../services';
import { approvalResultAad, plainResultLine } from './granted-result';
import { wakeForApproval } from './wake';

export { grantedResult } from './granted-result';

/** Keeps the call's result with the approval and wakes the agent that asked, where it asked (signed by that agent). */
export const wakeWithResult = defineCommand({
  name: 'approval.wake_with_result',
  schema: z.object({
    approvalId: z.string(),
    result: z.object({
      outcome: z.enum(['done', 'error', 'failed']),
      text: z.string().max(GRANTED_RESULT_TEXT_MAX),
      truncated: z.boolean(),
    }),
  }),
  async apply(tx, ctx, input): Promise<{ dispatchId: string; created: boolean } | null> {
    const [row] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId));
    if (!row || row.burrowId !== ctx.burrow.id || row.requesterId !== ctx.actor.id) return null;
    await tx
      .update(approvals)
      .set({ resultEnc: ctx.services.custody.seal(approvalResultAad(row.id), JSON.stringify(input.result)) })
      .where(eq(approvals.id, row.id));
    return wakeForApproval.apply(tx, ctx, { approvalId: row.id });
  },
});

/**
 * After an approved call ran: the agent that asked is woken with its result (HR-04), or, when it can't be woken there
 * any more, one plain line is posted as it in `postIn`, in `threadRootId` (the approval card's thread, task-feedback.md
 * TF-04; null: at the top). Never throws.
 */
export async function answerAfterApproval(
  services: Services,
  call: {
    burrowId: string;
    agentId: string;
    approvalId: string | null;
    postIn: string;
    threadRootId?: string | null;
    result: GrantedResultContext;
    /** The line posted when it can't be woken (a builtin's own words, ONE-DH21); absent: `plainResultLine`. */
    fallback?: string | null;
  },
): Promise<'woken' | 'posted'> {
  try {
    if (call.approvalId) {
      const res = await services.pipeline.commit(
        wakeWithResult,
        { approvalId: call.approvalId, result: call.result },
        { burrowId: call.burrowId, actorId: call.agentId },
      );
      if (res.status === 'ok' && res.result) return 'woken';
    }
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error' },
      'could not wake the agent after a yes',
    );
  }
  await sendInThread(services, {
    burrowId: call.burrowId,
    actorId: call.agentId,
    conversationId: call.postIn,
    threadRootId: call.threadRootId ?? null,
    text: call.fallback || plainResultLine(call.result),
  }).catch((err: unknown) =>
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error' },
      'could not post an approved call’s result',
    ),
  );
  return 'posted';
}
