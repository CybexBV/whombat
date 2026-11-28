/** Bootstrap (sidebar), conversations, messages, threads, reactions, read state and uploads. */
import { z } from 'zod';
import { Preferences } from '../domain/account.js';
import { Burrow } from '../domain/burrow.js';
import { ChatRuntime } from '../domain/chat-runtime.js';
import { Count, Cursor, RepoFullName, Timestamp, Tone } from '../domain/common.js';
import { Conversation, ConversationKind, ConversationSummary, NotifyLevel } from '../domain/conversation.js';
import { HANDOFFS_MAX, Handoff } from '../domain/handoff.js';
import { JobAnswersBody } from '../domain/job-result.js';
import { Message, MessageTextInput, PINS_MAX, Reaction, ReactionValue } from '../domain/message.js';
import { Person, Principal } from '../domain/principal.js';
import { PrStatus, PullRequest } from '../domain/repo.js';
import { AttachmentId, ConversationId, DispatchId, MessageId } from '../ids.js';
import { MAX_ATTACHMENTS_PER_MESSAGE, UploadReservation, UploadReserveBody } from './attachments.js';
import { BurrowParam, endpoint, limitQuery } from './endpoint.js';
import { OkResponse } from './errors.js';

const B = z.object({ burrow: BurrowParam });
const BC = B.extend({ conversationId: ConversationId });

/** `conversations.handoffs` and the `conversation.handoffs` frame: a conversation's hand-overs, oldest first. */
export const ConversationHandoffs = z.object({
  conversationId: ConversationId,
  handoffs: z.array(Handoff).max(HANDOFFS_MAX),
});
export type ConversationHandoffs = z.infer<typeof ConversationHandoffs>;

/**
 * `conversations.handoffAnswer` (t3code.md T3-38): the person answers the question a job waits on, by its request and each
 * question's id, with an option's label (or several, for a question with many choices) or their own words.
 */
export const HandoffAnswerBody = z.object({
  handoffId: z.string().min(1).max(300),
  requestId: z.string().min(1).max(2000),
  answers: z.record(
    z.string().min(1).max(200),
    z.union([z.string().trim().min(1).max(2000), z.array(z.string().min(1).max(200)).min(1).max(10)]),
  ),
});
export type HandoffAnswerBody = z.infer<typeof HandoffAnswerBody>;

/**
 * `conversations.handoffSend` (t3code.md T3-39): the person's message to a job. `steer` reaches the turn at work now (or
 * starts one), `queue` waits for its next turn.
 */
export const HANDOFF_SEND_MODES = ['steer', 'queue'] as const;
export const HandoffSendBody = z.object({
  handoffId: z.string().min(1).max(300),
  text: z.string().trim().min(1).max(4000),
  mode: z.enum(HANDOFF_SEND_MODES),
});
export type HandoffSendBody = z.infer<typeof HandoffSendBody>;
const BM = B.extend({ messageId: MessageId });

/* Bootstrap -------------------------------------------------------------------------------------- */

/** Sidebar BRANCH ROOMS row: status dot + mono branch + `#482`. */
export const BranchRoomSummary = ConversationSummary.extend({
  branch: z.string(),
  prNumber: z.number().int().positive(),
  prStatus: PrStatus,
  /** Dot: ok when ready/merged, warn otherwise. */
  dot: Tone,
  /** The PR's repository (`owner/name`, 0.26, CT-170); `link` carries it too. Absent when unknown. */
  repo: RepoFullName.optional(),
});
export type BranchRoomSummary = z.infer<typeof BranchRoomSummary>;

export const Sidebar = z.object({
  /** BRANCH ROOMS (open PRs first). */
  branchRooms: z.array(BranchRoomSummary),
  /** The viewer's own rooms with the agent (Chat, Feedback, task chats). */
  dms: z.array(ConversationSummary),
  /** Nav meta: "Canvases · 4". `needsYou` is always 0: the count comes from `work.needsYou`. */
  counts: z.object({ canvases: Count, needsYou: Count }),
});
export type Sidebar = z.infer<typeof Sidebar>;

/**
 * What this Whombat can do for notifications (0.26, CT-175), so Settings → Notifications shows only what works:
 * `emailNotifications` (a mail server is set: the owner's own, `host.mail`, 1.1) and `webPush` (the box has a Web Push
 * key of its own, `devices.vapidKey`: a community box; a browser also needs a secure page, so not the local-network
 * page).
 */
export const BootstrapCapabilities = z.object({
  emailNotifications: z.boolean(),
  webPush: z.boolean(),
});
export type BootstrapCapabilities = z.infer<typeof BootstrapCapabilities>;

export const Bootstrap = z.object({
  burrow: Burrow,
  /** The person (sidebar footer: "Mara Okafor · Engineering lead"). */
  me: Person,
  /** The person, the agent and the system principals (avatars, names, the agent's status dot). */
  principals: z.array(Principal),
  sidebar: Sidebar,
  preferences: Preferences,
  serverTime: Timestamp,
  realtime: z.object({
    /** WebSocket path (`/ws`). */
    path: z.string(),
    /** Topics the client should subscribe to right away (`burrow:<id>`, `me:<principalId>`). */
    topics: z.array(z.string()),
  }),
  /** Notification capabilities of this Whombat (0.26, CT-175); absent: show neither. */
  capabilities: BootstrapCapabilities.optional(),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

/* Conversations ---------------------------------------------------------------------------------- */

export const ConversationDetail = z.object({
  conversation: Conversation,
  /** Viewer's unread state. */
  summary: ConversationSummary,
  /** Branch rooms: the PR (header chip, tabs, side pane). */
  pr: PullRequest.nullable(),
  lastReadMessageId: MessageId.nullable(),
  /** The viewer's own notification level here (0.26, CT-175); absent = `defaultNotifyLevel(kind)`. */
  notify: NotifyLevel.optional(),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

export const MessagePage = z.object({
  /** Oldest first. */
  messages: z.array(Message),
  /** Cursor for older messages, or null at the start of the conversation. */
  before: Cursor.nullable(),
  hasMore: z.boolean(),
});
export type MessagePage = z.infer<typeof MessagePage>;

export const SendMessageBody = z
  .object({
    /** May be empty (`''`) only when the message carries attachments. */
    text: MessageTextInput,
    /** Reply in a thread. */
    threadRootId: MessageId.optional(),
    /** Ready uploads of the sender for this conversation (`uploads.create` + PUT), sent at most once. */
    attachmentIds: z.array(AttachmentId).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    /** Client id for optimistic rendering and idempotent retries. */
    clientId: z.string().min(1).max(64).optional(),
    /**
     * What answers the thread this message starts (0.96.1, CT-469; Whombat chat-runtime.md CR-02): the Chat's top-level
     * box sends its choice with the thread's first message, so the first answer already runs on it. Kept only for a
     * top-level message in the sender's own Chat room, stored as that thread's choice in the same change, before the
     * assistant is woken (`chats.setThreadRuntime`'s checks; equal to the assistant's own: none). Ignored elsewhere.
     * Runtimes with `chat.runtime` only.
     */
    runtime: ChatRuntime.optional(),
  })
  .refine((b) => b.text.length > 0 || (b.attachmentIds?.length ?? 0) > 0, {
    path: ['text'],
    message: 'Say something first.',
  });
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const SendMessageResponse = z.object({
  message: Message,
  /** The agent's turns this message started (in the person's own room, or a mention); each shows "{name} is thinking". */
  dispatches: z.array(z.object({ dispatchId: DispatchId })),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const ThreadView = z.object({
  root: Message,
  /** Oldest first: every reply, or with `limit` the newest page before `before`. */
  replies: z.array(Message),
  conversationId: ConversationId,
  /** "Chat", "feat/invoice-pdf" — first half of the pane context line. */
  where: z.string(),
  /** "PDF libraries" — second half, from the root's card or text; null when there is none. */
  topic: z.string().nullable(),
  /**
   * Thread paging (0.55, CT-299): with `limit`, where the earlier replies start — ask again with `before` for the page
   * before this one (“Load earlier replies”). Null: these are the first replies (or every reply was asked for).
   */
  more: z.object({ before: MessageId }).nullable(),
});
export type ThreadView = z.infer<typeof ThreadView>;

/** The most replies one `messages.thread` page holds (0.55, CT-299). */
export const THREAD_PAGE_MAX = 200;

/**
 * `messages.thread`'s query (0.55, CT-299). No `limit`: every reply. `limit`: the newest
 * `limit` replies, or with `before` the `limit` replies just before that reply; `more.before` pages further back.
 */
export const ThreadQuery = z.object({
  before: MessageId.optional(),
  limit: z.coerce.number().int().min(1).max(THREAD_PAGE_MAX).optional(),
});
export type ThreadQuery = z.infer<typeof ThreadQuery>;

/**
 * The page `messages.thread` answers (CT-299), from every reply oldest first: without `limit` all of them and `more`
 * null; with it the newest `limit` before `before` (a reply id; one that isn't a reply here pages from the newest), and
 * `more.before` the oldest reply of the page while earlier ones exist. The reference for runtimes and fixtures.
 */
export function pageThreadReplies<M extends { id: string }>(
  replies: readonly M[],
  query: { before?: string | undefined; limit?: number | undefined },
): { replies: M[]; more: { before: string } | null } {
  if (query.limit === undefined) return { replies: [...replies], more: null };
  const at = query.before ? replies.findIndex((r) => r.id === query.before) : -1;
  const end = at === -1 ? replies.length : at;
  const start = Math.max(0, end - query.limit);
  const page = replies.slice(start, end);
  return { replies: page, more: start > 0 && page[0] ? { before: page[0].id } : null };
}

/** `conversations.setNotify`: a level, or null for the conversation kind's default (CT-175). */
export const SetNotifyBody = z.object({ notify: NotifyLevel.nullable() });
export type SetNotifyBody = z.infer<typeof SetNotifyBody>;

export const SetNotifyResponse = z.object({
  conversationId: ConversationId,
  /** The level now in effect (the default when the body was null). */
  notify: NotifyLevel,
});
export type SetNotifyResponse = z.infer<typeof SetNotifyResponse>;

export const conversationEndpoints = {
  bootstrap: endpoint({
    id: 'conversations.bootstrap',
    method: 'GET',
    path: '/burrows/:burrow/bootstrap',
    summary: 'Everything the shell needs: burrow, me, principals, sidebar with unread counts, preferences.',
    params: B,
    response: Bootstrap,
  }),
  list: endpoint({
    id: 'conversations.list',
    method: 'GET',
    path: '/burrows/:burrow/conversations',
    summary: 'Conversations visible to the viewer, optionally by kind.',
    params: B,
    query: z.object({ kind: ConversationKind.optional() }),
    response: z.object({ conversations: z.array(ConversationSummary) }),
  }),
  get: endpoint({
    id: 'conversations.get',
    method: 'GET',
    path: '/burrows/:burrow/conversations/:conversationId',
    summary: 'A conversation with header data (actions, PR for branch rooms).',
    params: BC,
    response: ConversationDetail,
  }),
  update: endpoint({
    id: 'conversations.update',
    method: 'PATCH',
    path: '/burrows/:burrow/conversations/:conversationId',
    summary: 'Change a conversation’s topic.',
    params: BC,
    /** Only the fields sent change. */
    body: z.object({
      topic: z.string().max(280).optional(),
    }),
    response: ConversationDetail,
  }),
  markRead: endpoint({
    id: 'conversations.markRead',
    method: 'POST',
    path: '/burrows/:burrow/conversations/:conversationId/read',
    summary: 'Mark read up to a message; clears the sidebar badge.',
    params: BC,
    body: z.object({ messageId: MessageId }),
    response: z.object({ unread: Count, mentions: Count }),
  }),
  setNotify: endpoint({
    id: 'conversations.setNotify',
    method: 'PUT',
    path: '/burrows/:burrow/conversations/:conversationId/notify',
    summary:
      'The viewer’s notification level for this conversation: all, mentions or none (null: the default).',
    params: BC,
    body: SetNotifyBody,
    response: SetNotifyResponse,
  }),
  pins: endpoint({
    id: 'conversations.pins',
    method: 'GET',
    path: '/burrows/:burrow/conversations/:conversationId/pins',
    summary: 'Pinned messages, newest pin first (at most 50).',
    params: BC,
    response: z.object({ messages: z.array(Message).max(PINS_MAX) }),
  }),
  handoffs: endpoint({
    id: 'conversations.handoffs',
    method: 'GET',
    path: '/burrows/:burrow/conversations/:conversationId/handoffs',
    summary:
      'Work the agent handed to another program from this conversation and still waits for (a T3 Code thread), and work that just ended (Whombat t3code.md T3-24).',
    params: BC,
    response: ConversationHandoffs,
  }),
  handoffAnswer: endpoint({
    id: 'conversations.handoffAnswer',
    method: 'POST',
    path: '/burrows/:burrow/conversations/:conversationId/handoffs/answer',
    summary:
      'Answer the question a job handed to T3 Code waits on (never a permission request: only T3 Code approves those). Answers with the conversation’s hand-overs.',
    params: BC,
    body: HandoffAnswerBody,
    response: ConversationHandoffs,
  }),
  handoffSend: endpoint({
    id: 'conversations.handoffSend',
    method: 'POST',
    path: '/burrows/:burrow/conversations/:conversationId/handoffs/send',
    summary:
      'Send a job handed to T3 Code a message: steer the turn at work now, or queue it for its next turn. Answers with the conversation’s hand-overs.',
    params: BC,
    body: HandoffSendBody,
    response: ConversationHandoffs,
  }),
};

/** `messages.edit`: the new text (CT-173). Empty only when the message has attachments (the server checks). */
export const EditMessageBody = z.object({ text: MessageTextInput });
export type EditMessageBody = z.infer<typeof EditMessageBody>;

/**
 * `messages.delete` (CT-173): a message without replies is removed (`message` null, event `message.deleted`); a thread
 * root with replies stays as a tombstone (`message` with `deletedAt`, event `message.updated`).
 */
export const DeleteMessageResponse = z.object({
  messageId: MessageId,
  message: Message.nullable(),
});
export type DeleteMessageResponse = z.infer<typeof DeleteMessageResponse>;

const messageListEndpoint = endpoint({
  id: 'messages.list',
  method: 'GET',
  path: '/burrows/:burrow/conversations/:conversationId/messages',
  summary: 'Top-level messages (no thread replies), newest page first, each page oldest first.',
  params: BC,
  query: z.object({ before: Cursor.optional(), limit: limitQuery(50) }),
  response: MessagePage,
});

const messageSendEndpoint = endpoint({
  id: 'messages.send',
  method: 'POST',
  path: '/burrows/:burrow/conversations/:conversationId/messages',
  summary: 'Post a message or thread reply. `@Agent` mentions (or any DM message) dispatch to the agent.',
  params: BC,
  body: SendMessageBody,
  response: SendMessageResponse,
  status: 201,
});

const messageGetEndpoint = endpoint({
  id: 'messages.get',
  method: 'GET',
  path: '/burrows/:burrow/messages/:messageId',
  summary: 'One message (deep links, receipts).',
  params: BM,
  response: z.object({ message: Message }),
});

const messageThreadEndpoint = endpoint({
  id: 'messages.thread',
  method: 'GET',
  path: '/burrows/:burrow/messages/:messageId/thread',
  summary:
    'Thread pane: the root and its replies. With `limit` (0.55, feature `messages.thread_paging`): the newest page, `before` a reply for the page before it, `more` where the earlier ones start.',
  params: BM,
  query: ThreadQuery,
  response: ThreadView,
});

const messageReactEndpoint = endpoint({
  id: 'messages.react',
  method: 'POST',
  path: '/burrows/:burrow/messages/:messageId/reactions',
  summary: 'Add or remove the viewer’s reaction.',
  params: BM,
  body: z.object({ value: ReactionValue, on: z.boolean() }),
  response: z.object({ reactions: z.array(Reaction) }),
});

const messageMoreEndpoint = endpoint({
  id: 'messages.more',
  method: 'POST',
  path: '/burrows/:burrow/messages/:messageId/more',
  summary:
    '“More detail” under an agent’s short reply: the agent posts the detail it left out in the same place. Asking twice changes nothing.',
  params: BM,
  response: z.object({ message: Message }),
});

const messageEditEndpoint = endpoint({
  id: 'messages.edit',
  method: 'PATCH',
  path: '/burrows/:burrow/messages/:messageId',
  summary:
    'Edit your own message’s text (people; not cards). Sets `editedAt`; a newly added mention wakes or notifies once.',
  params: BM,
  body: EditMessageBody,
  response: z.object({ message: Message }),
});

const messageJobAnswersEndpoint = endpoint({
  id: 'messages.jobAnswers',
  method: 'POST',
  path: '/burrows/:burrow/messages/:messageId/job-answers',
  summary:
    'Send T3 Code the person’s answers to what a job’s result message left for them, together: it carries them out in one run and the message is updated when that ends. Answers with the message.',
  params: BM,
  body: JobAnswersBody,
  response: z.object({ message: Message }),
});

const messageDeleteEndpoint = endpoint({
  id: 'messages.delete',
  method: 'DELETE',
  path: '/burrows/:burrow/messages/:messageId',
  summary:
    'Delete a message (the person may delete any). Without replies it is removed; a thread root with replies becomes “This message was deleted.”.',
  params: BM,
  response: DeleteMessageResponse,
});

const messagePinEndpoint = endpoint({
  id: 'messages.pin',
  method: 'PUT',
  path: '/burrows/:burrow/messages/:messageId/pin',
  summary: 'Pin or unpin a message in its conversation (people in it).',
  params: BM,
  body: z.object({ pinned: z.boolean() }),
  response: z.object({ message: Message }),
});

/**
 * The messages' endpoints, spelled out by name so declaration emit refers to each one's type instead of expanding them
 * all in one declaration (TS7056 once the message types grew past the compiler's limit).
 */
export interface MessageEndpoints {
  list: typeof messageListEndpoint;
  send: typeof messageSendEndpoint;
  get: typeof messageGetEndpoint;
  thread: typeof messageThreadEndpoint;
  react: typeof messageReactEndpoint;
  more: typeof messageMoreEndpoint;
  edit: typeof messageEditEndpoint;
  jobAnswers: typeof messageJobAnswersEndpoint;
  delete: typeof messageDeleteEndpoint;
  pin: typeof messagePinEndpoint;
}

export const messageEndpoints: MessageEndpoints = {
  list: messageListEndpoint,
  send: messageSendEndpoint,
  get: messageGetEndpoint,
  thread: messageThreadEndpoint,
  react: messageReactEndpoint,
  more: messageMoreEndpoint,
  edit: messageEditEndpoint,
  jobAnswers: messageJobAnswersEndpoint,
  delete: messageDeleteEndpoint,
  pin: messagePinEndpoint,
};

export const uploadEndpoints = {
  create: endpoint({
    id: 'uploads.create',
    method: 'POST',
    path: '/burrows/:burrow/uploads',
    summary:
      '"+ file": reserve an attachment for one conversation; PUT the bytes to `uploadUrl`, then send its id with a message.',
    params: B,
    body: UploadReserveBody,
    response: UploadReservation,
    status: 201,
  }),
  discard: endpoint({
    id: 'uploads.discard',
    method: 'DELETE',
    path: '/burrows/:burrow/uploads/:attachmentId',
    summary:
      'Remove an upload of yours that was not sent (× on its chip); its bytes go when nothing uses them.',
    params: B.extend({ attachmentId: AttachmentId }),
    response: OkResponse,
  }),
};
