/** Messages: send (with thread replies and mention dispatch), reactions and read markers. */
import {
  AttachmentId,
  ChatRuntime,
  ConversationId,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MessageId,
  MessageMore,
  MessageTextInput,
  ReactionValue,
  SUGGESTIONS_MAX,
  Suggestion,
  topics,
} from '@whombat/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { firstMessageChoice, storeFirstMessageChoice } from '../chats/runtime';
import { defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import { messages, reactions, readStates } from '../db/schema/index';
import { enqueueInSession } from '../domain/dispatch';
import { postMessage, publishUnread, unreadKey, wouldWakeAgent } from '../domain/messages';
import { dropSvgCopies } from '../domain/svg-copies';
import { claimAttachments, linkAttachments, svgFileTexts } from '../files/commands';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { loadConversationRow, unreadCounts } from '../read/conversations';
import { aggregateReactions, loadMessageRow, loadMessages, type MessageRow } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';

export const sendMessage = defineCommand({
  name: 'send_message',
  schema: z.object({
    conversationId: ConversationId,
    /** May be empty when the message carries attachments. */
    text: MessageTextInput.default(''),
    threadRootId: MessageId.optional(),
    attachmentIds: z.array(AttachmentId).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    clientId: z.string().min(1).max(64).optional(),
    /** Agents only (the MCP tools); dropped on a person's message. */
    suggestions: z.array(Suggestion).max(SUGGESTIONS_MAX).optional(),
    /** Agents only: what a short reply left out (docs/decisions/concise-replies.md); dropped on a person's message. */
    more: MessageMore.shape.hint.optional(),
    /** Agents only: the message asks a person something (docs/decisions/agent-status.md AS-03). */
    asks: z.boolean().optional(),
    /**
     * People only: what answers the thread this top-level message starts in their own Chat (contracts 0.96.1 CT-469,
     * chat-runtime.md CR-02); ignored anywhere else — on a reply too, so it never moves a started thread to another
     * provider (hermes-native.md HN-06, HN-L02).
     */
    runtime: ChatRuntime.optional(),
  }),
  async apply(tx, ctx, input) {
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (attachmentIds.length && input.clientId) {
      // A retry of a send that went through: its files are on that message already.
      const [existing] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            eq(messages.authorId, ctx.actor.id),
            eq(messages.clientId, input.clientId),
          ),
        );
      if (existing) return { id: existing.id, dispatches: [] };
    }
    // A lapsed licence (LC-10): a person's message to or mentioning an agent would start a new agent turn, so it is
    // refused and not posted. Messages without an agent, and agents' own replies in a running turn, go through.
    if (
      ctx.services.licence.lapsed &&
      ctx.actor.kind === 'person' &&
      (await wouldWakeAgent(ctx, conversation, input.text))
    )
      ctx.services.licence.assertNotLapsed();
    // The new thread's choice of what answers, checked before anything is posted (chat-runtime-server.md CR-S06).
    const choice = await firstMessageChoice(ctx, conversation, input);
    // Ready uploads of the sender for this conversation, on no message yet (docs/decisions/bp-attachments.md).
    const files = attachmentIds.length ? await claimAttachments(tx, ctx, conversation.id, attachmentIds) : [];
    // An agent's SVG file and the same SVG in a fenced block would show the drawing twice: the file stays (MS-D01).
    const text =
      ctx.actor.kind === 'agent' && files.length
        ? dropSvgCopies(input.text, await svgFileTexts(ctx, files))
        : input.text;
    const posted = await postMessage(ctx, {
      conversation,
      text,
      threadRootId: input.threadRootId ?? null,
      clientId: input.clientId ?? null,
      attachmentIds,
      suggestions: input.suggestions ?? [],
      more: input.more ?? null,
      asks: input.asks ?? false,
    });
    await linkAttachments(tx, ctx, posted.id, files);
    // The final transaction hook queues the turn after its model choice and attachments are stored.
    await storeFirstMessageChoice(ctx, choice, posted.id);
    return posted;
  },
});

/**
 * Posts what Whombat says about work as `actorId` in the thread it was asked in (task-feedback.md TF-04): Chat and
 * channels are threaded, and a post without a thread starts a new one at the top. At the top when `threadRootId` is
 * null (a flat conversation) or the thread is gone by now (its first message deleted). Throws as the commit does.
 */
export async function sendInThread(
  services: Services,
  m: { burrowId: string; actorId: string; conversationId: string; threadRootId: string | null; text: string },
): Promise<void> {
  const root = m.threadRootId ? await loadMessageRow(services.db, m.threadRootId) : null;
  const threadRootId = root?.conversationId === m.conversationId ? root.id : null;
  await services.pipeline.commit(
    sendMessage,
    { conversationId: m.conversationId, text: m.text, ...(threadRootId ? { threadRootId } : {}) },
    { burrowId: m.burrowId, actorId: m.actorId },
  );
}

/**
 * “More detail” under an agent's short reply (docs/decisions/concise-replies.md): the first person to ask marks
 * the offer taken and wakes the agent (`expand`) to post the detail where the short reply is. A second ask, or
 * one that lost the race, changes nothing.
 */
export const requestMore = defineCommand({
  name: 'request_more',
  // “More detail” wakes the agent: a new agent turn (LC-10).
  licence: 'agentTurn',
  schema: z.object({ messageId: MessageId }),
  async apply(tx, ctx, input) {
    const row = await loadMessageRow(tx, input.messageId);
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Message');
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can ask for more detail.');
    if (!row.more) throw badRequest('There is no more detail to this message.');
    const author = await loadPrincipalRow(tx, row.authorId);
    if (author?.kind !== 'agent') throw badRequest('There is no more detail to this message.');
    const load = async () => {
      const [message] = await loadMessages(tx, [(await loadMessageRow(tx, row.id)) ?? row], ctx.actor.id);
      if (!message) throw notFound('Message');
      return message;
    };
    if (row.more.requestedAt) return load();

    const more = { ...row.more, requestedById: ctx.actor.id, requestedAt: ctx.now.toISOString() };
    const [taken] = await tx
      .update(messages)
      .set({ more })
      .where(and(eq(messages.id, row.id), sql`${messages.more}->>'requestedAt' is null`))
      .returning({ id: messages.id });
    if (!taken) return load();
    const event = await ctx.emit({
      type: 'message.more_requested',
      kind: 'Messages',
      text: null,
      where: null,
      aboutId: author.id,
      payload: { messageId: row.id },
    });
    const message = await load();
    ctx.publish(
      topics.conversation(row.conversationId),
      { type: 'message.updated', message },
      { eventId: event.id },
    );

    const burrowId = ctx.burrow.id;
    const actorId = ctx.actor.id;
    const at = ctx.now;
    // The detail goes where the short reply is: its thread, or the conversation itself.
    await enqueueInSession(ctx, {
      burrowId,
      causedById: actorId,
      conversationId: row.conversationId,
      messageId: row.id,
      threadRootId: row.threadRootId,
      requests: [{ agentId: author.id, trigger: 'expand' }],
      at,
    });
    return message;
  },
});

export const reactToMessage = defineCommand({
  name: 'react',
  schema: z.object({ messageId: MessageId, value: ReactionValue, on: z.boolean() }),
  async apply(tx, ctx, input) {
    const row = await loadMessageRow(tx, input.messageId);
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Message');
    // A deleted message takes no reactions.
    if (row.deletedAt) throw notFound('Message');
    if (input.on) {
      await tx
        .insert(reactions)
        .values({
          messageId: row.id,
          principalId: ctx.actor.id,
          value: input.value,
          burrowId: ctx.burrow.id,
          createdAt: ctx.now,
        })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(reactions)
        .where(
          and(
            eq(reactions.messageId, row.id),
            eq(reactions.principalId, ctx.actor.id),
            eq(reactions.value, input.value),
          ),
        );
    }
    const event = await ctx.emit({
      type: 'message.reacted',
      kind: 'Messages',
      text: null,
      where: null,
      payload: { messageId: row.id, value: input.value, on: input.on },
    });
    const [message] = await loadMessages(tx, [row], null);
    if (message)
      ctx.publish(
        topics.conversation(row.conversationId),
        { type: 'message.updated', message },
        {
          eventId: event.id,
        },
      );
    const rows = await tx
      .select({ value: reactions.value, principalId: reactions.principalId })
      .from(reactions)
      .where(eq(reactions.messageId, row.id))
      .orderBy(asc(reactions.createdAt));
    return aggregateReactions(rows, ctx.actor.id);
  },
});

/** Moves `principalId`'s read marker in the message's conversation to it, never backwards. */
export async function moveReadMark(
  tx: Tx,
  principalId: string,
  row: Pick<MessageRow, 'id' | 'conversationId' | 'createdAt' | 'ord'>,
  now: Date,
): Promise<void> {
  const [current] = await tx
    .select()
    .from(readStates)
    .where(and(eq(readStates.conversationId, row.conversationId), eq(readStates.principalId, principalId)));
  if (current && current.lastReadOrd !== null && current.lastReadOrd >= row.ord) return;
  await tx
    .insert(readStates)
    .values({
      conversationId: row.conversationId,
      principalId,
      lastReadMessageId: row.id,
      lastReadAt: row.createdAt,
      lastReadOrd: row.ord,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [readStates.conversationId, readStates.principalId],
      set: { lastReadMessageId: row.id, lastReadAt: row.createdAt, lastReadOrd: row.ord, updatedAt: now },
    });
}

/** Private per-viewer state: moves the read marker (never backwards) and refreshes the viewer's badge. */
export const markRead = defineCommand({
  name: 'mark_read',
  schema: z.object({ conversationId: ConversationId, messageId: MessageId }),
  async apply(tx, ctx, input) {
    const row = await loadMessageRow(tx, input.messageId);
    if (!row || row.conversationId !== input.conversationId || row.burrowId !== ctx.burrow.id)
      throw notFound('Message');
    await moveReadMark(tx, ctx.actor.id, row, ctx.now);
    const counts = (await unreadCounts(tx, ctx.actor.id, [input.conversationId])).get(
      input.conversationId,
    ) ?? {
      unread: 0,
      mentions: 0,
    };
    const services = ctx.services;
    const viewerId = ctx.actor.id;
    // After the room's badges counted before this commit (SV-02), so a stale count never lands after this one.
    ctx.background(
      'unread badge',
      async () => {
        services.bus.publish({
          topic: topics.me(viewerId),
          event: { type: 'conversation.unread', conversationId: input.conversationId, ...counts },
          eventId: null,
          at: services.clock().toISOString(),
          outboxId: null,
        });
      },
      unreadKey(input.conversationId),
    );
    return counts;
  },
});

export { publishUnread };
