/**
 * Conversations (a person's rooms with the agent and pull requests' branch rooms; one-agent.md OA-04), read state,
 * messages, reactions and the link-preview cache (attachments: ./attachments). Nobody is a member of a conversation:
 * every one is the person's with the agent.
 */
import type {
  ChatRuntime,
  ConversationAction,
  ConversationKind,
  JobResult,
  LinkPreview,
  MessageMore,
  MessageProvenance,
  MessageVaultSave,
  MovedCard,
  NotifyLevel,
  RanOn,
  StoredCard,
  ThreadSettledHow,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ts } from './common';
import { burrows } from './tenancy';

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id),
    kind: text('kind').$type<ConversationKind>().notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    topic: text('topic').notNull().default(''),
    actions: jsonb('actions').$type<ConversationAction[]>().notNull().default([]),
    prNumber: integer('pr_number'),
    repoId: text('repo_id'),
    dmAgentId: text('dm_agent_id'),
    dmPersonId: text('dm_person_id'),
    /** Sidebar order within a kind. */
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastMessageAt: ts('last_message_at'),
    /** Link previews here (EC-23, CT-330): null or true = on (as the burrow says), false = none fetched or shown. */
    linkPreviews: boolean('link_previews'),
    /**
     * A task chat with the person's Whombat (one-whombat.md ONE-06, migration 0104): a `dm` row with a key of its own.
     * Null: the person's default DM (where approval cards and Vault asks land) and every other conversation.
     */
    taskKey: text('task_key'),
    /** The task chat's title: the first line of its first message (≤ 60 characters), or Whombat's better one. */
    chatTitle: text('chat_title'),
    /** When Whombat improved the title (`set_chat_title`, once per chat). */
    chatRetitledAt: ts('chat_retitled_at'),
    /** What the chat is about: a server, a connection or a device, with its name when the chat started. */
    chatSubjectKind: text('chat_subject_kind').$type<'server' | 'connection' | 'device'>(),
    chatSubjectId: text('chat_subject_id'),
    chatSubjectName: text('chat_subject_name'),
    chatArchivedAt: ts('chat_archived_at'),
    /**
     * A person's Chat or Feedback room was cleared then (chat-clear.md CHC-01…CHC-03, migration 0133): its top-level
     * messages up to this time no longer show in the room or in its assistant's window; its threads stay in Threads.
     */
    roomClearedAt: ts('room_cleared_at'),
    /** The person's notification level here: null = the kind's default (`defaultNotifyLevel`). */
    notify: text('notify').$type<NotifyLevel>(),
  },
  (t) => [
    uniqueIndex('conversations_slug_idx').on(t.burrowId, t.kind, t.slug).where(sql`${t.taskKey} IS NULL`),
    uniqueIndex('conversations_dm_idx')
      .on(t.dmAgentId, t.dmPersonId)
      .where(sql`${t.kind} = 'dm' AND ${t.taskKey} IS NULL`),
    uniqueIndex('conversations_task_idx')
      .on(t.dmAgentId, t.dmPersonId, t.taskKey)
      .where(sql`${t.taskKey} IS NOT NULL`),
  ],
);

/** Per-viewer read marker. Unread = top-level messages by others after `last_read_at`. */
export const readStates = pgTable(
  'read_states',
  {
    conversationId: text('conversation_id').notNull(),
    principalId: text('principal_id').notNull(),
    lastReadMessageId: text('last_read_message_id'),
    lastReadAt: ts('last_read_at'),
    /** Tie-break inside the same timestamp (messages.ord of the marker). */
    lastReadOrd: bigint('last_read_ord', { mode: 'number' }),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.principalId] })],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id').notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    authorId: text('author_id').notNull(),
    createdAt: ts('created_at').notNull(),
    /** Insertion order: stable tie-break for messages in the same instant, and the paging cursor. */
    ord: bigint('ord', { mode: 'number' }).generatedAlwaysAsIdentity(),
    editedAt: ts('edited_at'),
    text: text('text').notNull(),
    mentions: text('mentions').array().notNull().default(sql`'{}'::text[]`),
    card: jsonb('card').$type<StoredCard>(),
    /** An agent's quick replies (docs/decisions/rich-messages.md RM-05). */
    suggestions: text('suggestions').array().notNull().default(sql`'{}'::text[]`),
    /** An agent's offer of more detail, and who asked for it (docs/decisions/concise-replies.md). */
    more: jsonb('more').$type<MessageMore>(),
    /** An agent's message asks a person something it needs answered (docs/decisions/agent-status.md AS-03). */
    asks: boolean('asks').notNull().default(false),
    attachmentIds: text('attachment_ids').array().notNull().default(sql`'{}'::text[]`),
    threadRootId: text('thread_root_id'),
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: ts('last_reply_at'),
    threadParticipantIds: text('thread_participant_ids').array().notNull().default(sql`'{}'::text[]`),
    clientId: text('client_id'),
    /**
     * Where the text came from when it isn't simply the author's own (core `MessageProvenance`, feedback.md
     * review-2 F1): an assessor's output, or an approved feedback handoff. Null for everything else.
     */
    provenance: text('provenance').$type<MessageProvenance>(),
    /** A deleted thread root kept for its replies (EC-02): text, card, attachments and previews are gone. */
    deletedAt: ts('deleted_at'),
    /** Pinned in its conversation since then, by whom (EC-14). */
    pinnedAt: ts('pinned_at'),
    pinnedById: text('pinned_by_id'),
    /** Link previews under the message (EC-17…EC-22), fetched after posting; null = none (yet). */
    previews: jsonb('previews').$type<LinkPreview[]>(),
    /**
     * What a thread in Chat is about (docs/decisions/chat-channel.md CHT-05, migration 0116): a server, a connection or a
     * device (`ChatSubject`), on the thread's first message only. Null: nothing in particular.
     */
    subjectKind: text('subject_kind').$type<'server' | 'connection' | 'device'>(),
    subjectId: text('subject_id'),
    subjectName: text('subject_name'),
    /**
     * What answered an assistant's reply in Chat (`Message.ranOn`, docs/decisions/chat-runtime.md CR-07, CR-08; migration
     * 0118): stamped when the reply is posted during a Claude Code or Codex turn, corrected from the turn's completion
     * (`CompleteBody.ran`). Null on every other message.
     */
    ranOn: jsonb('ran_on').$type<RanOn>(),
    /** The turn that posted a reply carrying `ran_on`, or asked a question the run waits on. */
    dispatchId: text('dispatch_id'),
    /**
     * What the person's assistant took from this message into the Vault (`Message.vaultSaved`, docs/decisions/
     * vault-self-serve.md VS-07, VS-11; migration 0129): the secret blanked in the text, a line per entry. Null: none.
     */
    vaultSaved: jsonb('vault_saved').$type<MessageVaultSave[]>(),
    /**
     * The thread this message starts is settled (docs/decisions/chat-settle.md, migration 0014): when its work ended
     * and how (`person`, `quiet`, `merged`). Only on a top-level message of a person's Chat or Feedback room; a new
     * message in the thread clears both.
     */
    settledAt: ts('settled_at'),
    settledHow: text('settled_how').$type<ThreadSettledHow>(),
    /** The person opened the thread again by hand: the automatic round leaves it alone until a new message. */
    keptOpenAt: ts('kept_open_at'),
    /**
     * The council's or checklist's card that was on this message and moved to the thread's end (`Message.movedCard`,
     * docs/decisions/card-moves.md CM-07, migration 0059): the message keeps only the agent's words. Null otherwise.
     */
    movedCard: jsonb('moved_card').$type<MovedCard>(),
    /**
     * The card as it was on this message when it moved on, kept because the person talked after it
     * (`Message.earlierCard`, card-moves.md, migration 0060): the apps fold it here, read-only. Null otherwise.
     */
    earlierCard: jsonb('earlier_card').$type<StoredCard>(),
    /**
     * The message is the result of a job handed to T3 Code (`Message.jobResult`, docs/decisions/t3code.md, migration
     * 0003): its text is T3 Code's report and this the facts and the person's answers. Null on every other message.
     */
    jobResult: jsonb('job_result').$type<JobResult>(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt, t.ord),
    index('messages_thread_idx').on(t.threadRootId, t.createdAt, t.ord),
    // A conversation's top level by position (server-efficiency.md SV-01, SV-12): unread badges, open questions. The
    // migration (0084) also INCLUDEs author_id, mentions and deleted_at, which drizzle can't declare.
    index('messages_top_level_idx').on(t.conversationId, t.ord).where(sql`${t.threadRootId} is null`),
    index('messages_asks_idx').on(t.authorId).where(sql`${t.asks}`),
    // Guide cards still waiting for their person (assistant-guides.md AG-11: expiry, “no open guide card”).
    index('messages_open_guides_idx')
      .on(t.conversationId, t.createdAt)
      .where(sql`${t.card}->>'kind' = 'guide' and ${t.card}->>'state' = 'open'`),
    // The pins pane (`conversations.pins`, newest pin first).
    index('messages_pins_idx').on(t.conversationId, t.pinnedAt).where(sql`${t.pinnedAt} is not null`),
    // A room's threads by their last activity and a thing's threads (`chats.threads`, chat-channel.md CHT-07, 0116).
    index('messages_thread_activity_idx')
      .on(t.conversationId, sql`(coalesce(${t.lastReplyAt}, ${t.createdAt})) desc`, sql`${t.id} desc`)
      .where(sql`${t.threadRootId} is null`),
    index('messages_subject_idx')
      .on(t.conversationId, t.subjectKind, t.subjectId)
      .where(sql`${t.subjectKind} is not null`),
    uniqueIndex('messages_client_id_idx')
      .on(t.conversationId, t.authorId, t.clientId)
      .where(sql`${t.clientId} is not null`),
    // A turn's replies in Chat, corrected when it completes (chat-runtime-server.md CR-S09, 0118).
    index('messages_dispatch_idx').on(t.dispatchId).where(sql`${t.dispatchId} is not null`),
    // The Settled shelf, latest settled first (`chats.threads` `state: settled`, 0014).
    index('messages_settled_idx')
      .on(t.conversationId, sql`${t.settledAt} desc`, sql`${t.id} desc`)
      .where(sql`${t.threadRootId} is null and ${t.settledAt} is not null`),
    // What the automatic round of settling looks at: a room's open threads nobody kept open, by their last activity.
    index('messages_settle_candidates_idx')
      .on(t.conversationId, sql`(coalesce(${t.lastReplyAt}, ${t.createdAt}))`)
      .where(
        sql`${t.threadRootId} is null and ${t.settledAt} is null and ${t.keptOpenAt} is null and ${t.deletedAt} is null`,
      ),
    check(
      'messages_settled',
      sql`(${t.settledAt} is null) = (${t.settledHow} is null) and (${t.settledHow} is null or ${t.settledHow} in ('person', 'quiet', 'merged', 'resolved'))`,
    ),
  ],
);

/**
 * Per-viewer read marker of one thread of the person's Chat or Feedback room (docs/decisions/thread-unread.md): messages
 * from others in the thread after `last_read_ord` are new to them. No row: everything from others in it is new, except
 * a first message they already passed in the room (`read_states`).
 */
export const threadReads = pgTable(
  'thread_reads',
  {
    rootId: text('root_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    /** `messages.ord` of the newest message read in the thread. */
    lastReadOrd: bigint('last_read_ord', { mode: 'number' }).notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rootId, t.principalId] })],
);

/**
 * A Chat thread's choice of what answers (docs/decisions/chat-runtime.md CR-02, CR-03; chat-runtime-server.md CR-S01;
 * migration 0118): the provider, model, effort and fast replies its person picked, keyed by the thread's first message
 * (a top-level message of the person's Chat). No row: the thread follows the assistant's own runtime. Written only
 * through the commit pipeline (`chats.setThreadRuntime`, `chats.start` with `runtime`); removing the message removes it.
 */
export const chatThreadRuntimes = pgTable('chat_thread_runtimes', {
  rootId: text('root_id')
    .primaryKey()
    .references(() => messages.id, { onDelete: 'cascade' }),
  burrowId: text('burrow_id')
    .notNull()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull(),
  runtime: jsonb('runtime').$type<ChatRuntime>().notNull(),
  setById: text('set_by_id').notNull(),
  setAt: ts('set_at').notNull(),
});

export const reactions = pgTable(
  'reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id),
    principalId: text('principal_id').notNull(),
    value: text('value').notNull(),
    burrowId: text('burrow_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.value, t.principalId] })],
);

/**
 * Link previews fetched for a burrow (docs/decisions/essentials-conversations.md EC-18): one row per burrow and URL,
 * reused for 24 hours. `preview` null = the page had none, or the fetch failed (`reason` says why, never shown).
 * Operational cache, not signed; pruned when stale.
 */
export const linkPreviews = pgTable(
  'link_previews',
  {
    burrowId: text('burrow_id').notNull(),
    url: text('url').notNull(),
    preview: jsonb('preview').$type<LinkPreview>(),
    /** `ok`, `none` (no title, not HTML) or `failed` (refused, unreachable, too large, timed out). */
    status: text('status').$type<'ok' | 'none' | 'failed'>().notNull(),
    reason: text('reason'),
    fetchedAt: ts('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.burrowId, t.url] }), index('link_previews_fetched_idx').on(t.fetchedAt)],
);
