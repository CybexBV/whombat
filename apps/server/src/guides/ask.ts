/**
 * A setup card the agent asks for from its turn (connect-in-chat.md): `connection_add`'s connect card and `vault_ask`'s
 * Vault card, posted as the agent in the turn's own thread, waking nobody. The card is made (and checked against the
 * contract) by the tool; this only posts it where the turn is, so the person sees it beside what they asked.
 */
import { ConversationId, GuideCard, linkPath, MessageId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadBurrowRow } from '../commit/pipeline';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { dispatches, messages } from '../db/schema/index';
import { linkOfConversation } from '../domain/links';
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
    /** Explicit message id so an OAuth return path built into the card can name it before posting. */
    messageId: MessageId.optional(),
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
      ...(input.messageId ? { id: input.messageId } : {}),
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
 * The return path for a connect card posted in a conversation: opens the card's thread with `&guide=<messageId>` so
 * OAuth sign-in returns straight to the thread, locks the card and wakes the assistant.
 */
export async function cardReturnTo(
  db: Db,
  burrowId: string,
  conversationId: string,
  threadRootId: string | null,
  messageId: string,
): Promise<string | null> {
  const [burrow, conversation] = await Promise.all([
    loadBurrowRow(db, burrowId),
    loadConversationRow(db, conversationId),
  ]);
  if (!burrow || !conversation) return null;
  const link = await linkOfConversation(db, conversation);
  const base = linkPath(burrow.slug, link);
  const root = threadRootId ?? (link.type === 'dm' ? messageId : null);
  const params = new URLSearchParams();
  if (root) params.set('thread', root);
  params.set('guide', messageId);
  return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
}

/**
 * Posts the card in the turn's conversation and thread as the agent; its message id. `turn`: the turn waits for the
 * answer itself (its id goes on the message).
 */
export async function postAskCard(
  ctx: ToolContext,
  card: GuideCard,
  options: { turn?: boolean; messageId?: string } = {},
): Promise<string> {
  return postTurnCard(ctx.services, ctx.dispatch, card, { ...options, onBehalfOf: ctx.onBehalfOf });
}

/** `postAskCard` for a turn the server knows by its row (Hermes's own asks reach it from the runner). */
export async function postTurnCard(
  services: Services,
  dispatch: Pick<DispatchRow, 'id' | 'burrowId' | 'agentId' | 'conversationId' | 'threadRootId'>,
  card: GuideCard,
  options: { turn?: boolean; messageId?: string; onBehalfOf?: ToolContext['onBehalfOf'] } = {},
): Promise<string> {
  const res = await services.pipeline.commit(
    askWithCard,
    {
      conversationId: dispatch.conversationId,
      threadRootId: dispatch.threadRootId ?? null,
      card,
      ...(options.messageId ? { messageId: options.messageId } : {}),
      ...(options.turn ? { dispatchId: dispatch.id } : {}),
    },
    { burrowId: dispatch.burrowId, actorId: dispatch.agentId, onBehalfOf: options.onBehalfOf ?? {} },
  );
  if (res.status !== 'ok') throw new Error(res.message);
  return res.result.messageId;
}

export const GUIDE_ASK_COMMANDS = [askWithCard];
