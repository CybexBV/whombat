/**
 * A setup card the agent asks for from its turn (connect-in-chat.md): `connection_add`'s connect card and `vault_ask`'s
 * Vault card, posted as the agent in the turn's own thread, waking nobody. The card is made (and checked against the
 * contract) by the tool; this only posts it where the turn is, so the person sees it beside what they asked.
 */
import { ConversationId, GuideCard, MessageId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { dispatches, messages } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { forbidden, notFound } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { loadConversationRow } from '../read/conversations';
import type { DispatchRow } from '../runtime/context';
import type { Services } from '../services';

/** The topics a turn may post this way: the rest are the guides' own steps. */
const ASK_TOPICS: readonly string[] = ['add_connection', 'secret', 'settings'];

export const askWithCard = defineCommand({
  name: 'guides.ask',
  schema: z.object({
    conversationId: ConversationId,
    threadRootId: MessageId.nullable(),
    card: GuideCard,
    /**
     * The turn that waits for the answer itself (a code card, a login Hermes asked for; vault-simplify.md VLT-44, VLT-45):
     * kept on the message, so an answer while that turn still waits goes to it.
     */
    dispatchId: z.string().min(1).max(80).optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant asks this way.');
    if (!ASK_TOPICS.includes(input.card.guide)) throw forbidden('That card isn’t one a turn posts.');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation) throw notFound('Conversation');
    const posted = await postMessage(ctx, {
      conversation,
      threadRootId: input.threadRootId,
      text: '',
      card: input.card,
      dispatch: false,
    });
    if (input.dispatchId) {
      const [own] = await tx
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(and(eq(dispatches.id, input.dispatchId), eq(dispatches.agentId, ctx.actor.id)));
      if (!own) throw forbidden('This dispatch is gone.');
      await tx.update(messages).set({ dispatchId: own.id }).where(eq(messages.id, posted.id));
    }
    return { messageId: posted.id };
  },
});

/**
 * Posts the card in the turn's conversation and thread as the agent; its message id. `turn`: the turn waits for the
 * answer itself (its id goes on the message).
 */
export async function postAskCard(
  ctx: ToolContext,
  card: GuideCard,
  options: { turn?: boolean } = {},
): Promise<string> {
  return postTurnCard(ctx.services, ctx.dispatch, card, { ...options, onBehalfOf: ctx.onBehalfOf });
}

/** `postAskCard` for a turn the server knows by its row (Hermes's own asks reach it from the runner). */
export async function postTurnCard(
  services: Services,
  dispatch: Pick<DispatchRow, 'id' | 'burrowId' | 'agentId' | 'conversationId' | 'threadRootId'>,
  card: GuideCard,
  options: { turn?: boolean; onBehalfOf?: ToolContext['onBehalfOf'] } = {},
): Promise<string> {
  const res = await services.pipeline.commit(
    askWithCard,
    {
      conversationId: dispatch.conversationId,
      threadRootId: dispatch.threadRootId ?? null,
      card,
      ...(options.turn ? { dispatchId: dispatch.id } : {}),
    },
    { burrowId: dispatch.burrowId, actorId: dispatch.agentId, onBehalfOf: options.onBehalfOf ?? {} },
  );
  if (res.status !== 'ok') throw new Error(res.message);
  return res.result.messageId;
}

export const GUIDE_ASK_COMMANDS = [askWithCard];
