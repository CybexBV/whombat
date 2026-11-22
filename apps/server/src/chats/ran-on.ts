/**
 * What answered an assistant's reply in Chat (docs/decisions/chat-runtime.md CR-07, CR-08; chat-runtime-server.md
 * CR-S08, CR-S09): a reply the assistant posts in its person's Chat during a Claude Code or Codex turn carries `ran_on`
 * from the runtime the turn was resolved to, and the turn (`dispatch_id`); the turn's completion corrects it from what
 * the runner says ran (`CompleteBody.ran`, `modelFallback`) and tells the room (`message.updated`). Not in the Feedback
 * room, task chats, channels or any other room, and not on Whombat's own cards posted for the assistant.
 */
import {
  type ModelFallbackReport,
  type RanOn,
  type StoredCard,
  type TurnRanReport,
  topics,
} from '@whombat/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { ApplyContext, TxSession } from '../commit/types';
import type { Tx } from '../db/client';
import { dispatches, messages } from '../db/schema/index';
import { localModelView } from '../local-model/store';
import type { ConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import { currentDispatchScope } from '../runtime/dispatch-scope';
import { turnRuntime } from '../runtime/turn-runtime';
import { chatRoomOf } from './rooms';
import { isChatProvider, ranOnAtCompletion, ranOnAtPost } from './runtime-rules';
import { burrowLocalModel, providerModels } from './thread-runtime';

/** Cards Whombat posts for the assistant (an ask, a run, a plan, a failed turn): they say nothing about what answered. */
const NOT_A_REPLY: ReadonlySet<StoredCard['kind']> = new Set([
  'approval',
  'run',
  'plan',
  'turn_failed',
  'task',
]);

/**
 * What a message about to be posted says answered it (CR-S08): set for the assistant's own message in its person's Chat
 * (assistant shell) while it acts in a running turn there whose runtime is Claude Code or Codex. Null otherwise.
 */
export async function ranOnForPost(
  ctx: ApplyContext,
  conversation: ConversationRow,
  card: StoredCard | null | undefined,
): Promise<RanOn | null> {
  if (ctx.actor.kind !== 'agent' || (card && NOT_A_REPLY.has(card.kind))) return null;
  const scope = currentDispatchScope();
  if (!scope?.dispatchId || scope.agentId !== ctx.actor.id) return null;
  if (conversation.dmAgentId !== ctx.actor.id) return null;
  if (chatRoomOf(conversation) !== 'chat') return null;
  const [turn] = await ctx.tx
    .select({
      conversationId: dispatches.conversationId,
      state: dispatches.state,
      runtime: dispatches.runtime,
      gatewayProvider: dispatches.gatewayProvider,
    })
    .from(dispatches)
    .where(eq(dispatches.id, scope.dispatchId));
  // Only while the turn runs: what Whombat says for it after it ended (a refusal, why it failed) isn't an answer.
  if (turn?.conversationId !== conversation.id || (turn.state !== 'claimed' && turn.state !== 'running'))
    return null;
  const agent = await loadPrincipalRow(ctx.tx, ctx.actor.id);
  const runtime = turnRuntime(agent?.runtime, turn);
  if (!isChatProvider(runtime.provider)) return null;
  const local = runtime.provider === 'local' ? localModelView(ctx.burrow) : null;
  return ranOnAtPost(runtime, providerModels(ctx.services, runtime.provider, local), {
    gateway: turn.gatewayProvider !== null,
  });
}

/**
 * A turn completed (CR-S09): its replies in Chat say what really ran — the runner's `ran` (model, effort, fast, why not)
 * and the model it asked for when the runner fell back to the default — each changed one told to the room. Nothing
 * without either (an older runner keeps the post-time values).
 */
export async function correctRanOn(
  session: TxSession,
  dispatchId: string,
  report: { ran?: TurnRanReport | undefined; modelFallback?: ModelFallbackReport | undefined },
): Promise<number> {
  if (!report.ran && !report.modelFallback) return 0;
  const tx: Tx = session.tx;
  const rows = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.dispatchId, dispatchId), isNotNull(messages.ranOn)));
  const changed: (typeof rows)[number][] = [];
  // The model on the person's network names its models itself (CT-1173): read once, for a reply that ran on it.
  const firstLocal = rows.find((r) => r.ranOn?.provider === 'local');
  const local = firstLocal ? await burrowLocalModel(tx, firstLocal.burrowId) : null;
  for (const row of rows) {
    const posted = row.ranOn;
    if (!posted) continue;
    const next = ranOnAtCompletion(
      posted,
      report.ran,
      report.modelFallback,
      providerModels(session.services, posted.provider, local),
    );
    if (JSON.stringify(next) === JSON.stringify(posted)) continue;
    const [updated] = await tx
      .update(messages)
      .set({ ranOn: next })
      .where(eq(messages.id, row.id))
      .returning();
    if (updated) changed.push(updated);
  }
  for (const message of await loadMessages(tx, changed, null))
    session.publish(topics.conversation(message.conversationId), { type: 'message.updated', message });
  return changed.length;
}
