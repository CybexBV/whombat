import { api, uploadContentUrl } from '@whombat/core';
import { updateConversation } from '../commands/conversations';
import { deleteMessage, editMessage, pinMessage, pinnedMessages } from '../commands/message-edits';
import { markRead, reactToMessage, requestMore, sendMessage } from '../commands/messages';
import { discardUpload, reserveUpload } from '../files/commands';
import { toAttachment } from '../files/service';
import { forbidden, notFound } from '../lib/errors';
import { notificationCapabilities } from '../mail/digest';
import { loadMessages } from '../read/messages';
import {
  bootstrap,
  conversationDetail,
  listConversations,
  messagePage,
  readableConversation,
  readableMessage,
  threadView,
} from '../read/views';
import type { Services } from '../services';
import { conversationHandoffs } from '../t3code/handoffs';
import { answerJob, answerJobReport, messageJob } from '../t3code/job';
import { commitAs } from './burrows';
import { route } from './define';

/** A message as the caller sees it (their own reactions marked), after a command changed it. */
async function messageFor(
  ctx: { services: Services; access: { burrow: { id: string }; principal: { id: string } } },
  messageId: string,
) {
  const row = await readableMessage(ctx.services.db, ctx.access.burrow.id, messageId);
  const [message] = await loadMessages(ctx.services.db, [row], ctx.access.principal.id);
  if (!message) throw notFound('Message');
  return message;
}

export const conversationRoutes = [
  route(api.conversations.bootstrap, async ({ access, auth, services }) => {
    if (access.principal.kind !== 'person') throw forbidden('Bootstrap is for people.');
    return {
      ...(await bootstrap(services.db, access.burrow, access.principal, auth.account, services.clock())),
      // What Settings → Notifications may offer here (essentials-people.md EP-16).
      capabilities: notificationCapabilities(services),
    };
  }),

  route(api.conversations.list, async ({ access, query, services }) => ({
    conversations: await listConversations(services.db, access.burrow.id, access.principal.id, query.kind),
  })),

  route(api.conversations.get, async ({ access, params, services }) => {
    const row = await readableConversation(services.db, access.burrow.id, params.conversationId);
    return conversationDetail(services.db, access.principal.id, row);
  }),

  route(api.conversations.update, async (ctx) => {
    await commitAs(ctx, updateConversation, {
      conversationId: ctx.params.conversationId,
      topic: ctx.body.topic,
      linkPreviews: ctx.body.linkPreviews,
    });
    const row = await readableConversation(ctx.services.db, ctx.access.burrow.id, ctx.params.conversationId);
    return conversationDetail(ctx.services.db, ctx.access.principal.id, row);
  }),

  route(api.conversations.pins, async ({ access, params, services }) => {
    const row = await readableConversation(services.db, access.burrow.id, params.conversationId);
    const pinned = await pinnedMessages(services.db, row);
    return { messages: await loadMessages(services.db, pinned, access.principal.id) };
  }),

  // What the agent handed to T3 Code from here (t3code.md T3-24): whoever reads the conversation sees it.
  route(api.conversations.handoffs, async ({ access, params, services }) => {
    const row = await readableConversation(services.db, access.burrow.id, params.conversationId);
    return {
      conversationId: row.id,
      handoffs: await conversationHandoffs(services.db, access.burrow.id, row.id, services.clock()),
    };
  }),

  // The person answers a job's question or sends it a message (t3code.md T3-38, T3-39).
  route(api.conversations.handoffAnswer, async ({ access, params, body, services }) =>
    answerJob(
      services,
      { burrowId: access.burrow.id, principal: access.principal },
      params.conversationId,
      body,
    ),
  ),
  route(api.conversations.handoffSend, async ({ access, params, body, services }) =>
    messageJob(
      services,
      { burrowId: access.burrow.id, principal: access.principal },
      params.conversationId,
      body,
    ),
  ),

  // The person's answers to what a job's result message left for them, sent to T3 Code together.
  route(api.messages.jobAnswers, async ({ access, params, body, services }) =>
    answerJobReport(
      services,
      { burrowId: access.burrow.id, principal: access.principal },
      params.messageId,
      body,
    ),
  ),

  route(api.messages.edit, async (ctx) => {
    await commitAs(ctx, editMessage, { messageId: ctx.params.messageId, text: ctx.body.text });
    return { message: await messageFor(ctx, ctx.params.messageId) };
  }),

  route(api.messages.delete, async (ctx) => {
    const done = await commitAs(ctx, deleteMessage, { messageId: ctx.params.messageId });
    return {
      messageId: done.messageId,
      message: done.message ? await messageFor(ctx, done.messageId) : null,
    };
  }),

  route(api.messages.pin, async (ctx) => {
    await commitAs(ctx, pinMessage, { messageId: ctx.params.messageId, pinned: ctx.body.pinned });
    return { message: await messageFor(ctx, ctx.params.messageId) };
  }),

  route(api.conversations.markRead, async (ctx) =>
    commitAs(ctx, markRead, { conversationId: ctx.params.conversationId, messageId: ctx.body.messageId }),
  ),

  route(api.messages.list, async ({ access, params, query, services }) => {
    const row = await readableConversation(services.db, access.burrow.id, params.conversationId);
    return messagePage(services.db, access.principal.id, params.conversationId, {
      ...(query.before ? { before: query.before } : {}),
      limit: query.limit,
      // A cleared Chat shows what came after (chat-clear.md CHC-03); its threads stay in Threads.
      clearedAt: row.roomClearedAt,
    });
  }),

  route(api.messages.send, async (ctx) => {
    const posted = await commitAs(ctx, sendMessage, {
      ...ctx.body,
      conversationId: ctx.params.conversationId,
    });
    const row = await readableMessage(ctx.services.db, ctx.access.burrow.id, posted.id);
    const [message] = await loadMessages(ctx.services.db, [row], ctx.access.principal.id);
    if (!message) throw notFound('Message');
    return { message, dispatches: posted.dispatches };
  }),

  route(api.messages.get, async ({ access, params, services }) => {
    const row = await readableMessage(services.db, access.burrow.id, params.messageId);
    const [message] = await loadMessages(services.db, [row], access.principal.id);
    if (!message) throw notFound('Message');
    return { message };
  }),

  // Paged with `limit` (and `before`), whole without it as for older clients (review-features.md RF-03).
  route(api.messages.thread, async ({ access, params, query, services }) => {
    await readableMessage(services.db, access.burrow.id, params.messageId);
    return threadView(services.db, access.principal.id, params.messageId, query);
  }),

  route(api.messages.react, async (ctx) => ({
    reactions: await commitAs(ctx, reactToMessage, { messageId: ctx.params.messageId, ...ctx.body }),
  })),

  route(api.messages.more, async (ctx) => ({
    message: await commitAs(ctx, requestMore, { messageId: ctx.params.messageId }),
  })),

  route(api.uploads.create, async (ctx) => {
    const row = await commitAs(ctx, reserveUpload, ctx.body);
    return {
      attachment: toAttachment(row),
      uploadUrl: uploadContentUrl(ctx.access.burrow.slug, row.id),
      method: 'PUT' as const,
      headers: { 'content-type': 'application/octet-stream' },
      maxBytes: ctx.services.files.maxBytes,
    };
  }),

  route(api.uploads.discard, async (ctx) =>
    commitAs(ctx, discardUpload, { attachmentId: ctx.params.attachmentId }),
  ),
];
