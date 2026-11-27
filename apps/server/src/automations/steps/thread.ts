import { and, eq, isNull } from 'drizzle-orm';
import type { ApplyContext } from '../../commit/types';
import { automationRuns } from '../../db/schema/index';
import { postMessage } from '../../domain/messages';
import { loadConversationRow } from '../../read/conversations';
import { outsidersRun } from '../runs';
import type { AutomationRunRow } from '../store';

/**
 * Makes `messageId` the run's thread when it has none yet: whatever the run posts first in its room starts its thread —
 * an ask, a prepared pull request or a notice too (one-agent.md OA-S100).
 */
export async function startsRunThread(
  tx: ApplyContext['tx'],
  runId: string,
  messageId: string,
): Promise<void> {
  await tx
    .update(automationRuns)
    .set({ threadRootId: messageId })
    .where(and(eq(automationRuns.id, runId), isNull(automationRuns.threadRootId)));
}

/** The run's thread: the step's own choice, starting it when there is none yet. */
export async function placeFor(
  _ctx: ApplyContext,
  run: AutomationRunRow,
  step: { conversation: 'run' | string; thread: 'run' | 'top' },
): Promise<{ conversationId: string; threadRootId: string | null; startsThread: boolean }> {
  const conversationId = step.conversation === 'run' ? run.conversationId : step.conversation;
  const sameRoom = conversationId === run.conversationId;
  if (step.thread === 'run' && sameRoom && run.threadRootId)
    return { conversationId, threadRootId: run.threadRootId, startsThread: false };
  return { conversationId, threadRootId: null, startsThread: sameRoom && !run.threadRootId };
}

/**
 * One line from the automation in the run's thread (it starts the thread when the run has none yet), waking nobody. The
 * message's id, or null when the run's room can't take it (gone, archived): a line is never worth failing a step.
 */
export async function postInRunThread(
  ctx: ApplyContext,
  run: AutomationRunRow,
  text: string,
  /** `notify: false`: nobody hears of it beyond the thread itself (no Inbox row, no push). */
  o: { notify?: boolean } = {},
): Promise<string | null> {
  const place = await placeFor(ctx, run, { conversation: 'run', thread: 'run' });
  const conversation = await loadConversationRow(ctx.tx, place.conversationId);
  if (!conversation) return null;
  const posted = await postMessage(ctx, {
    conversation,
    text,
    threadRootId: place.threadRootId,
    mentions: [],
    dispatch: false,
    outsidersRun: outsidersRun(run.trigger),
    ...(o.notify === false ? { notify: false } : {}),
  });
  if (place.startsThread)
    await ctx.tx.update(automationRuns).set({ threadRootId: posted.id }).where(eq(automationRuns.id, run.id));
  return posted.id;
}
