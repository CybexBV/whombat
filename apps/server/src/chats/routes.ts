/**
 * REST for task chats (`api.chats.*`, contracts CT-337; docs/decisions/one-whombat.md ONE-06) and Chat's rooms and
 * threads (chat-channel.md CHT-06, CHT-07): the caller's own chats with their Whombat. Writes are commands in the commit
 * pipeline.
 */
import { type AnyEndpoint, api } from '@whombat/core';
import { notFound } from '../lib/errors';
import { loadConversation } from '../read/conversations';
import { loadMessages } from '../read/messages';
import { readableMessage } from '../read/views';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../routes/define';
import { clearChat } from './clear';
import { archiveChat, renameChat, startChat, unarchiveChat } from './commands';
import { markThreadUnread } from './mark-unread';
import { listChats, listThreads, loadThread, roomIdOf } from './read';
import { readThread } from './read-thread';
import { chatRuntimeView, setChatThreadRuntime } from './runtime';
import { settleFinishedThreads, settleThread } from './settle';
import { unreadThreads } from './unread';

async function conversationOf(db: Parameters<typeof loadConversation>[0], id: string) {
  const conversation = await loadConversation(db, id);
  if (!conversation) throw notFound('Chat');
  return conversation;
}

/** A thread just started, as `chats.start` answers: the Chat and its first message as the caller reads it. */
export async function startedChatAnswer(
  ctx: Pick<HandlerContext<AnyEndpoint>, 'services' | 'access'>,
  started: { conversationId: string; messageId: string },
) {
  const row = await readableMessage(ctx.services.db, ctx.access.burrow.id, started.messageId);
  const [message] = await loadMessages(ctx.services.db, [row], ctx.access.principal.id);
  if (!message) throw notFound('Message');
  return { conversation: await conversationOf(ctx.services.db, started.conversationId), message };
}

export const chatRoutes: RouteDef[] = [
  route(api.chats.list, async ({ services, access, query }) => ({
    chats: await listChats(services.db, access.principal, {
      archived: query.archived ?? false,
      // Chat's two rooms; task chats only with the archived ones (chat-channel.md CHT-07).
      rooms: true,
      ...(query.subjectKind
        ? { subject: { kind: query.subjectKind, ...(query.subjectId ? { id: query.subjectId } : {}) } }
        : {}),
    }),
  })),
  // A room's threads (chat-channel.md CHT-07, CT-443): the caller's own Chat or Feedback room.
  route(api.chats.threads, async ({ services, access, query }) =>
    listThreads(services.db, access.principal, {
      room: query.room,
      ...(query.state ? { state: query.state } : {}),
      ...(query.place ? { place: query.place } : {}),
      ...(query.subjectKind
        ? { subject: { kind: query.subjectKind, ...(query.subjectId ? { id: query.subjectId } : {}) } }
        : {}),
      ...(query.before ? { before: query.before } : {}),
      limit: query.limit,
      iconsDue: (repos) => services.github.repoIcons.refresh(access.burrow.id, repos),
    }),
  ),
  route(api.chats.start, async (ctx) => {
    return startedChatAnswer(ctx, await commitAs(ctx, startChat, ctx.body));
  }),
  // What answers in the caller's Chat (chat-runtime.md CR-01…CR-09, CT-461): their assistant, a thread's choice, both
  // providers.
  route(api.chats.runtime, async ({ services, access, query }) => {
    if (access.principal.kind !== 'person') throw notFound('Chat');
    return chatRuntimeView(services, access.principal, query.thread);
  }),
  // A thread's choice (CR-02): the caller's own Chat only, through the commit pipeline.
  route(api.chats.setThreadRuntime, async (ctx) =>
    commitAs(ctx, setChatThreadRuntime, { rootId: ctx.params.rootId, runtime: ctx.body.runtime }),
  ),
  // Clear the caller's Chat or Feedback room (chat-clear.md CHC-01…CHC-06, CT-990): its messages leave the room's view.
  route(api.chats.clear, async (ctx) => {
    const done = await commitAs(ctx, clearChat, { room: ctx.body.room });
    return {
      room: done.room,
      conversationId: done.conversationId,
      clearedAt: done.clearedAt,
      cleared: done.cleared,
    };
  }),
  // Which open threads of the caller's room have something new (thread-unread.md).
  route(api.chats.unread, async ({ services, access, query }) => {
    const found = await roomIdOf(services.db, access.principal, query.room);
    if (!found) return { conversationId: null, threads: [] };
    // An app from before one Chat asks for Code's: there are none (docs/decisions/one-chat.md).
    if (query.place === 'code') return { conversationId: found.id, threads: [] };
    return {
      conversationId: found.id,
      threads: await unreadThreads(services.db, access.principal.id, found.id),
    };
  }),
  // An app from before one Chat moves a thread to Code or back: every thread stays in Chat, answered as it is.
  route(api.chats.place, async (ctx) => {
    const thread = await loadThread(ctx.services.db, ctx.access.principal, 'chat', ctx.params.rootId);
    if (!thread) throw notFound('Thread');
    return { thread };
  }),
  // A thread of the caller's room read up to a message.
  route(api.chats.readThread, async (ctx) =>
    commitAs(ctx, readThread, { rootId: ctx.params.rootId, messageId: ctx.body.messageId }),
  ),
  // A thread of the caller's room marked unread again (chat-inbox.md CIB-06).
  route(api.chats.markUnread, async (ctx) => commitAs(ctx, markThreadUnread, { rootId: ctx.params.rootId })),
  // Settle a thread of the caller's Chat or Feedback room, or open it again (docs/decisions/chat-settle.md).
  route(api.chats.settle, async (ctx) => {
    const done = await commitAs(ctx, settleThread, { rootId: ctx.params.rootId, settled: ctx.body.settled });
    const thread = await loadThread(ctx.services.db, ctx.access.principal, done.room, done.rootId);
    if (!thread) throw notFound('Thread');
    return { thread };
  }),
  // Every open thread of the room that may settle.
  route(api.chats.settleFinished, async (ctx) => {
    const done = await commitAs(ctx, settleFinishedThreads, {
      room: ctx.body.room,
      onlyRead: ctx.body.onlyRead ?? false,
    });
    return { room: done.room, conversationId: done.conversationId, settled: done.settled };
  }),
  route(api.chats.rename, async (ctx) => {
    await commitAs(ctx, renameChat, { conversationId: ctx.params.conversationId, title: ctx.body.title });
    return { conversation: await conversationOf(ctx.services.db, ctx.params.conversationId) };
  }),
  route(api.chats.archive, async (ctx) => {
    await commitAs(ctx, archiveChat, { conversationId: ctx.params.conversationId });
    return { conversation: await conversationOf(ctx.services.db, ctx.params.conversationId) };
  }),
  route(api.chats.unarchive, async (ctx) => {
    await commitAs(ctx, unarchiveChat, { conversationId: ctx.params.conversationId });
    return { conversation: await conversationOf(ctx.services.db, ctx.params.conversationId) };
  }),
];
