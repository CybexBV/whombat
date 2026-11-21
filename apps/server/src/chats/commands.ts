/**
 * A person's chats with the agent (docs/decisions/chat-channel.md CHT-06; one-agent.md OA-04): `start_chat` posts the
 * text as a top-level message of the person's Chat, with the subject on it, and makes no conversation; it wakes the
 * agent as any message there does. Asked to (`reuseThread`, needs-you-list.md NYL-06), it posts into the newest thread
 * about that subject instead, so one thing keeps one thread.
 *
 * Task chats are `dm` conversations with a `task_key` from before Chat (one-whombat.md ONE-06): the person renames,
 * archives or brings one back; the agent may improve its title once (`set_chat_title`), unless the person named it
 * already. The person's Chat (`personalDmId`) is the one without a key; approval cards and Vault asks land in the chat
 * they come from (chat-asks.md CA-01).
 */
import { ChatRuntime, ChatSubject, ConversationId, MessageTextInput, RenameChatBody } from '@whombat/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { applyContext } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { catalogConnections, conversations, messages } from '../db/schema/index';
import { publishConversation } from '../domain/members';
import { postMessage } from '../domain/messages';
import { ensurePersonalDm } from '../domain/personal-dm';
import { subjectResolverFor } from '../home/registry';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadAgentRow, loadPrincipalRow, type PrincipalRow, toActor } from '../read/principals';
import { clearChat } from './clear';
import { isFeedbackRoom } from './rooms';
import { firstMessageChoice, setChatThreadRuntime, storeFirstMessageChoice } from './runtime';
import { CHAT_SUBJECT_NAME_MAX, CHAT_TITLE_MAX, clipTitle } from './title';

/** A subject as sent: `ChatSubject` (CT-337); the name is checked or replaced below. */
export const ChatSubjectInput = ChatSubject;

/** Whether a conversation row is a task chat (not the default DM, not the Feedback room). */
export function isTaskChat(row: Pick<ConversationRow, 'kind' | 'taskKey'>): boolean {
  return row.kind === 'dm' && row.taskKey !== null && !isFeedbackRoom(row);
}

/** The person and the agent they chat with, or a plain refusal. */
async function ownAssistant(ctx: ApplyContext): Promise<{ person: PrincipalRow; agent: PrincipalRow }> {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you start chats.');
  const person = await loadPrincipalRow(ctx.tx, ctx.actor.id);
  if (!person) throw notFound('Person');
  const agent = await loadAgentRow(ctx.tx, ctx.burrow.id);
  if (!agent) throw conflict('The agent isn’t ready yet. Try again in a moment.');
  return { person, agent };
}

/** The subject as this person may see it: a connection of theirs or the burrow's, or what its resolver says. */
export async function resolveChatSubject(
  ctx: ApplyContext,
  person: PrincipalRow,
  input: z.output<typeof ChatSubjectInput>,
): Promise<ChatSubject> {
  if (input.kind === 'connection') {
    const [row] = await ctx.tx.select().from(catalogConnections).where(eq(catalogConnections.id, input.id));
    if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Connection');
    return { kind: 'connection', id: row.id, name: row.label.slice(0, CHAT_SUBJECT_NAME_MAX) };
  }
  const resolver = subjectResolverFor(input.kind);
  if (resolver) {
    const found = await resolver(
      {
        db: ctx.tx as unknown as Db,
        burrowId: ctx.burrow.id,
        personId: person.id,
        now: ctx.now,
        services: ctx.services,
      },
      input.id,
    );
    if (!found) throw notFound(input.kind === 'server' ? 'Server' : 'Device');
    return { kind: input.kind, id: input.id, name: found.name.slice(0, CHAT_SUBJECT_NAME_MAX) };
  }
  return { kind: input.kind, id: input.id, name: input.name.slice(0, CHAT_SUBJECT_NAME_MAX) };
}

/** A task chat of the actor's, or `not_found` (someone else's chat is never named). */
async function ownChat(ctx: ApplyContext, conversationId: string): Promise<ConversationRow> {
  const row = await loadConversationRow(ctx.tx, conversationId);
  if (!row || row.burrowId !== ctx.burrow.id || !isTaskChat(row) || row.dmPersonId !== ctx.actor.id)
    throw notFound('Chat');
  return row;
}

export const startChat = defineCommand({
  name: 'start_chat',
  schema: z.object({
    text: MessageTextInput,
    subject: ChatSubjectInput.optional(),
    clientId: z.string().min(1).max(64).optional(),
    /** What answers the new thread (contracts 0.96 CT-461, chat-runtime.md CR-02); Chat only. */
    runtime: ChatRuntime.optional(),
    /** Into the newest thread about `subject` when there is one (NYL-06). */
    reuseThread: z.boolean().optional(),
  }),
  // The first message wakes Whombat: not while the licence is lapsed (LC-10).
  licence: 'agentTurn',
  async apply(tx, ctx, input) {
    const { person, agent } = await ownAssistant(ctx);
    if (!input.text.trim()) throw badRequest('Say something first.');
    const subject = input.subject ? await resolveChatSubject(ctx, person, input.subject) : null;
    // The default DM exists from the start (PA-06): where asks land when they come from a room others read (CA-01).
    const chatId = await ensurePersonalDm(ctx, agent, person);
    // Chat (CHT-06): a thread in the person's Chat, signed as the message it is; the message wakes the agent there.
    const chat = await loadConversationRow(tx, chatId);
    if (!chat) throw notFound('Chat');
    // The thing's own thread (NYL-06): the question is a reply there, which opens it again if it settled.
    const thread = input.reuseThread && subject ? await newestThreadAbout(tx, chat.id, subject) : null;
    if (thread) {
      const reply = await postMessage(ctx, {
        conversation: chat,
        text: input.text,
        threadRootId: thread,
        clientId: input.clientId ?? null,
      });
      return { conversationId: chat.id, messageId: reply.id };
    }
    // What answers the thread, checked before it starts and stored before its turn is queued (CR-02, CR-S06).
    const choice = await firstMessageChoice(ctx, chat, { runtime: input.runtime });
    const posted = await postMessage(ctx, {
      conversation: chat,
      text: input.text,
      threadRootId: null,
      subject,
      clientId: input.clientId ?? null,
    });
    await storeFirstMessageChoice(ctx, choice, posted.id);
    return { conversationId: chat.id, messageId: posted.id };
  },
});

/**
 * *Talk to {assistant} about it* (docs/decisions/inbox.md IBX-07): a new thread of the person's Chat that the assistant
 * starts with an Inbox item's words, about its thing when it has one. The person talks it over from there; the
 * assistant's own message wakes nobody, so no turn runs until the person writes. `text` is the route's, from the item.
 */
export const discussNeedsYou = defineCommand({
  name: 'discuss_needs_you',
  schema: z.object({ text: MessageTextInput, subject: ChatSubjectInput.optional() }),
  async apply(tx, ctx, input) {
    const { person, agent } = await ownAssistant(ctx);
    const subject = input.subject ? await resolveChatSubject(ctx, person, input.subject) : null;
    const chat = await loadConversationRow(tx, await ensurePersonalDm(ctx, agent, person));
    if (!chat) throw notFound('Chat');
    const asAgent = applyContext(ctx, {
      burrow: ctx.burrow,
      actor: toActor(agent),
      now: ctx.now,
      at: ctx.at,
      decision: null,
      requirement: null,
      approvalId: null,
      onBehalfOf: {},
    });
    const posted = await postMessage(asAgent, {
      conversation: chat,
      text: input.text,
      threadRootId: null,
      subject,
      mentions: [],
      dispatch: false,
    });
    return { conversationId: chat.id, messageId: posted.id };
  },
});

/** The first message of the newest thread (by its last reply) in a room about `subject`, or null. */
async function newestThreadAbout(
  tx: ApplyContext['tx'],
  conversationId: string,
  subject: Pick<ChatSubject, 'kind' | 'id'>,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNull(messages.threadRootId),
        isNull(messages.deletedAt),
        eq(messages.subjectKind, subject.kind),
        eq(messages.subjectId, subject.id),
      ),
    )
    .orderBy(desc(sql`coalesce(${messages.lastReplyAt}, ${messages.createdAt})`), desc(messages.id))
    .limit(1);
  return row?.id ?? null;
}

export const renameChat = defineCommand({
  name: 'rename_chat',
  schema: RenameChatBody.extend({ conversationId: ConversationId }),
  async apply(tx, ctx, input) {
    const row = await ownChat(ctx, input.conversationId);
    const title = clipTitle(input.title);
    if (title === row.chatTitle) return { conversationId: row.id, title };
    // A person's name for it settles it: Whombat doesn't change it afterwards (ONE-DW15).
    await tx
      .update(conversations)
      .set({ chatTitle: title, chatRetitledAt: row.chatRetitledAt ?? ctx.now })
      .where(eq(conversations.id, row.id));
    const event = await ctx.emit({
      type: 'chat.renamed',
      kind: 'System',
      text: null,
      where: row.title,
      payload: { conversationId: row.id },
    });
    await publishConversation(ctx, row.id, event.id);
    return { conversationId: row.id, title };
  },
});

export const archiveChat = defineCommand({
  name: 'archive_chat',
  schema: z.object({ conversationId: ConversationId }),
  async apply(tx, ctx, input) {
    const row = await ownChat(ctx, input.conversationId);
    if (row.chatArchivedAt) return { conversationId: row.id, archivedAt: row.chatArchivedAt.toISOString() };
    await tx.update(conversations).set({ chatArchivedAt: ctx.now }).where(eq(conversations.id, row.id));
    const event = await ctx.emit({
      type: 'chat.archived',
      kind: 'System',
      text: null,
      where: row.title,
      payload: { conversationId: row.id },
    });
    await publishConversation(ctx, row.id, event.id);
    return { conversationId: row.id, archivedAt: ctx.at };
  },
});

/** Brings an archived chat back to the person's list (`chats.unarchive`, contracts 0.80.1, CT-349). */
export const unarchiveChat = defineCommand({
  name: 'unarchive_chat',
  schema: z.object({ conversationId: ConversationId }),
  async apply(tx, ctx, input) {
    const row = await ownChat(ctx, input.conversationId);
    if (!row.chatArchivedAt) return { conversationId: row.id };
    await tx.update(conversations).set({ chatArchivedAt: null }).where(eq(conversations.id, row.id));
    const event = await ctx.emit({
      type: 'chat.unarchived',
      kind: 'System',
      text: null,
      where: row.title,
      payload: { conversationId: row.id },
    });
    await publishConversation(ctx, row.id, event.id);
    return { conversationId: row.id };
  },
});

/** What `set_chat_title` answers when it can't (the agent relays or drops it). */
export const CHAT_TITLE_SET_TEXT = 'This chat has its title already.';

/** The assistant's better title for a chat it is in (MCP `set_chat_title`, once per chat, ONE-06). */
export const setChatTitle = defineCommand({
  name: 'set_chat_title',
  schema: z.object({ conversationId: ConversationId, title: z.string().trim().min(1).max(200) }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only a person’s assistant names its chats.');
    const row = await loadConversationRow(tx, input.conversationId);
    if (!row || row.burrowId !== ctx.burrow.id || !isTaskChat(row) || row.dmAgentId !== ctx.actor.id)
      throw forbidden('You can only name a chat you are in.');
    if (row.chatRetitledAt) throw conflict(CHAT_TITLE_SET_TEXT);
    const title = clipTitle(input.title);
    const [updated] = await tx
      .update(conversations)
      .set({ chatTitle: title, chatRetitledAt: ctx.now })
      .where(and(eq(conversations.id, row.id), isNull(conversations.chatRetitledAt)))
      .returning({ id: conversations.id });
    if (!updated) throw conflict(CHAT_TITLE_SET_TEXT);
    const event = await ctx.emit({
      type: 'chat.renamed',
      kind: 'System',
      text: null,
      where: row.title,
      payload: { conversationId: row.id, byWhombat: true },
    });
    await publishConversation(ctx, row.id, event.id);
    return { conversationId: row.id, title };
  },
});

export { CHAT_TITLE_MAX };

export const CHAT_COMMANDS = [
  startChat,
  // Talk to {assistant} about an Inbox item (inbox.md IBX-07).
  discussNeedsYou,
  renameChat,
  archiveChat,
  unarchiveChat,
  setChatTitle,
  // A Chat thread's choice of what answers (chat-runtime.md CR-02).
  setChatThreadRuntime,
  // Clearing Chat or Feedback (chat-clear.md CHC-01…CHC-07).
  clearChat,
];
