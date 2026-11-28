/**
 * Reading task chats (docs/decisions/one-whombat.md ONE-04, ONE-06): a person's chats with their Whombat, newest first,
 * the default DM among them (`default: true`), archived ones left out unless asked for. Only the person sees their chats.
 */
import {
  CHAT_THREAD_TEXT_MAX,
  CHAT_THREADS_LIMIT_DEFAULT,
  CHAT_THREADS_LIMIT_MAX,
  type ChatSubject,
  type ChatSummary,
  type ChatSummaryRoom,
  type ChatThread,
  cardTitle,
  type StoredCard,
  threadPreview,
} from '@whombat/core';
import { and, count, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { conversations, messages } from '../db/schema/index';
import { personalDmId } from '../domain/personal-dm';
import { repoIconKey, storedRepoIcons } from '../github/repo-icons';
import { iso } from '../lib/time';
import { type ConversationRow, unreadCounts } from '../read/conversations';
import { loadAgentRow, loadPrincipalRow, type PrincipalRow, shortName } from '../read/principals';
import {
  type ChatRoom,
  chatRoomOf,
  FEEDBACK_ROOM_KEY,
  FEEDBACK_ROOM_TITLE,
  feedbackRoomId,
  roomByKey,
} from './rooms';
import { threadSettleOf } from './settle-rules';
import { repoShortName, threadRepos } from './thread-repo';
import { threadChoices } from './thread-runtime';
import { endedJobs, waitingThreads, workingThreads } from './thread-state';
import { roomTopic } from './title';
import { chatContextTopic, chatSubjectOf, messageSubjectOf } from './view';
import { threadWorks, withWork } from './work';

export { chatContextTopic, chatOf, chatSubjectOf, messageSubjectOf } from './view';

/** What a thread is about: its first message's subject, or null. */
export async function threadSubject(db: Db, rootId: string | null): Promise<ChatSubject | null> {
  if (!rootId) return null;
  const [root] = await db
    .select({
      subjectKind: messages.subjectKind,
      subjectId: messages.subjectId,
      subjectName: messages.subjectName,
    })
    .from(messages)
    .where(eq(messages.id, rootId));
  return (root && messageSubjectOf(root)) ?? null;
}

/**
 * The turn's `conversation.topic` where it differs from the room's own (for the agent only): a person's Chat or
 * Feedback room says whose it is and what the turn's thread is about (chat-channel.md CHT-05); a task chat its title and
 * subject (ONE-DW15). Null: the conversation's own topic.
 */
export async function turnTopic(
  db: Db,
  conversation: ConversationRow,
  threadRootId: string | null,
): Promise<string | null> {
  const room = chatRoomOf(conversation);
  if (!room) return chatContextTopic(conversation);
  const person = conversation.dmPersonId ? await loadPrincipalRow(db, conversation.dmPersonId) : undefined;
  return roomTopic(room, person ? shortName(person) : 'your person', await threadSubject(db, threadRootId));
}

/** Longest `lastText` (a one-line preview). */
const LAST_TEXT_MAX = 200;

/** One line of a message for the list: its first line, plain, clipped. */
function previewOf(text: string, max = LAST_TEXT_MAX): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What lists a person's chats with their Whombat ask for. */
export interface ChatListOptions {
  archived?: boolean;
  limit?: number;
  /** A thing's chats (`subjectKind` and `subjectId`): “Ask about pve-02” finds the one it had. */
  subject?: { kind: ChatSubject['kind']; id?: string };
  /**
   * Chat's two rooms (the assistant shell, chat-channel.md CHT-07): the Chat and the Feedback room, and task chats only
   * when archived ones are asked for (they are history now, CHT-04).
   */
  rooms?: boolean;
}

/**
 * The rows of the person's chats with their Whombat `agent`, newest first: the query `chats.list` (the web sidebar's
 * Conversations, the phone's Chats) and Home's chats and Needs you share (home-redesign.md HR-40).
 */
export async function chatRowsOf(
  db: Db,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
  agentId: string,
  options: ChatListOptions = {},
) {
  return db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.burrowId, person.burrowId),
        eq(conversations.kind, 'dm'),
        eq(conversations.dmAgentId, agentId),
        eq(conversations.dmPersonId, person.id),
        options.archived ? undefined : isNull(conversations.chatArchivedAt),
        // Task chats are history in Chat's shell: listed with the archived ones only (CHT-07).
        options.rooms && !options.archived
          ? or(isNull(conversations.taskKey), eq(conversations.taskKey, FEEDBACK_ROOM_KEY))
          : undefined,
        options.subject ? eq(conversations.chatSubjectKind, options.subject.kind) : undefined,
        options.subject?.id ? eq(conversations.chatSubjectId, options.subject.id) : undefined,
      ),
    )
    .orderBy(
      desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`),
      desc(conversations.id),
    )
    .limit(Math.min(options.limit ?? 200, 500));
}

/**
 * A chat's title in lists: the default chat is called after the Whombat (older apps list it so; Chat's apps call it by
 * its room), the Feedback room “Feedback”, a task chat by its own.
 */
export function chatListTitle(
  row: Pick<typeof conversations.$inferSelect, 'taskKey' | 'chatTitle' | 'title'>,
  agentName: string,
): string {
  if (row.taskKey === FEEDBACK_ROOM_KEY) return FEEDBACK_ROOM_TITLE;
  return row.taskKey === null ? agentName : (row.chatTitle ?? row.title);
}

/** `ChatSummary.room` (CT-441): the Chat, the Feedback room, or a task chat. */
function summaryRoom(row: Pick<typeof conversations.$inferSelect, 'kind' | 'taskKey'>): ChatSummaryRoom {
  return roomByKey(row) ?? 'task';
}

/**
 * The person's chats with their Whombat, newest first (`chats.list`): their task chats and their default DM. Empty when
 * they have no Whombat yet.
 */
export async function listChats(
  db: Db,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
  options: ChatListOptions = {},
): Promise<ChatSummary[]> {
  const agent = await loadAgentRow(db, person.burrowId);
  if (!agent) return [];
  const rows = await chatRowsOf(db, person, agent.id, options);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [unread, last] = await Promise.all([unreadCounts(db, person.id, ids), lastTexts(db, ids)]);
  return rows.map((row) => {
    const subject = chatSubjectOf(row);
    const text = last.get(row.id);
    const preview = text ? previewOf(text) : undefined;
    return {
      id: row.id,
      title: chatListTitle(row, agent.name),
      ...(subject ? { subject } : {}),
      lastAt: iso(row.lastMessageAt ?? row.createdAt),
      ...(preview ? { lastText: preview } : {}),
      unread: unread.get(row.id)?.unread ?? 0,
      default: row.taskKey === null,
      room: summaryRoom(row),
      ...(row.chatArchivedAt ? { archivedAt: iso(row.chatArchivedAt) } : {}),
    };
  });
}

/** The newest top-level message text of each conversation (one lateral query). */
async function lastTexts(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await db.execute<{ conversation_id: string; text: string | null }>(sql`
    select c.id as conversation_id, m.text
      from unnest(array[${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )}]::text[]) as c(id)
      left join lateral (
        select text from messages
         where conversation_id = c.id and thread_root_id is null and deleted_at is null
         order by ord desc limit 1) m on true`);
  return new Map(rows.filter((r) => r.text).map((r) => [r.conversation_id, r.text as string]));
}

/* Threads of a room (chat-channel.md CHT-07) ------------------------------------------------------ */

export interface ThreadListOptions {
  room?: ChatRoom;
  /** Open threads, newest activity first, or settled ones, latest settled first; absent: every thread. */
  state?: 'open' | 'settled';
  subject?: { kind: ChatSubject['kind']; id?: string };
  /**
   * An app from before one Chat asks for its Chat's or its Code's threads: every thread is Chat's, Code has none
   * (docs/decisions/one-chat.md).
   */
  place?: 'chat' | 'code';
  /** Threads older than this (the previous page's `next`): by last activity, or by when they settled. */
  before?: string;
  limit?: number;
  /**
   * Called with the repositories of the page whose icon is due for a look (none kept yet, or kept a day): the caller
   * starts the look in the background; the answer never waits for it.
   */
  iconsDue?: (repos: string[]) => void;
}

/**
 * The plain start of a thread's first message (Markdown marks dropped), or how many files it has, or what its card is
 * called when it is only a card (a guide's “Your email”): a row's title never falls back to a status like “No reply yet”.
 */
function threadText(text: string, files: number, card: StoredCard | null): string {
  const line = previewOf(text.replace(/[*_`#>]/g, ''), CHAT_THREAD_TEXT_MAX);
  if (line) return line;
  if (files) return files === 1 ? 'A file' : `${files} files`;
  return card ? cardTitle(card).slice(0, CHAT_THREAD_TEXT_MAX) : '';
}

/**
 * A reply as its thread's row shows it: the plain start of its words over several lines, a link as its words, or how
 * many files it has when it has only files. The apps make the same from a reply they just saw (`threadPreview`).
 */
function replyText(text: string, files: number): string {
  const words = threadPreview(text, CHAT_THREAD_TEXT_MAX);
  if (words) return words;
  if (files) return files === 1 ? 'A file' : `${files} files`;
  return '';
}

/** A thread's newest reply as its list row shows it (chat-inbox.md CIB-03). */
type LastReply = { authorId: string; text: string; at: string };

/**
 * The newest reply with words or files of each thread (one lateral query over `messages_thread_idx`): a reply that is
 * only a card is passed over, the row's status says what it waits for.
 */
async function lastReplies(db: Db, rootIds: readonly string[]): Promise<Map<string, LastReply>> {
  if (!rootIds.length) return new Map();
  const rows = await db.execute<{
    root_id: string;
    author_id: string;
    text: string;
    files: number;
    created_at: Date | string;
  }>(sql`
    select r.id as root_id, m.author_id, m.text, cardinality(m.attachment_ids)::int as files, m.created_at
      from unnest(array[${sql.join(
        rootIds.map((i) => sql`${i}`),
        sql`, `,
      )}]::text[]) as r(id)
      join lateral (
        select author_id, text, attachment_ids, created_at from messages
         where thread_root_id = r.id and deleted_at is null
           and (btrim(text) <> '' or cardinality(attachment_ids) > 0)
         order by ord desc limit 1) m on true`);
  const out = new Map<string, LastReply>();
  for (const r of rows) {
    const text = replyText(r.text, r.files);
    if (!text) continue;
    out.set(r.root_id, { authorId: r.author_id, text, at: iso(new Date(r.created_at)) });
  }
  return out;
}

/** The person's room with their assistant: their Chat (the default DM) or their Feedback room; null when it isn't there. */
export async function roomIdOf(
  db: Db,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
  room: ChatRoom,
): Promise<{ id: string; agentId: string } | null> {
  const agent = await loadAgentRow(db, person.burrowId);
  if (!agent) return null;
  const id =
    room === 'chat'
      ? await personalDmId(db, agent.id, person.id)
      : await feedbackRoomId(db, agent.id, person.id);
  return id ? { id, agentId: agent.id } : null;
}

/** The columns of a thread's first message a `ChatThread` is made of. */
const threadColumns = {
  id: messages.id,
  authorId: messages.authorId,
  text: messages.text,
  attachmentIds: messages.attachmentIds,
  card: messages.card,
  subjectKind: messages.subjectKind,
  subjectId: messages.subjectId,
  subjectName: messages.subjectName,
  createdAt: messages.createdAt,
  replyCount: messages.replyCount,
  lastReplyAt: messages.lastReplyAt,
  settledAt: messages.settledAt,
  settledHow: messages.settledHow,
};
type ThreadRow = Pick<typeof messages.$inferSelect, keyof typeof threadColumns>;

/** A room's thread for its person: what `chats.threads` and `chats.settle` answer. */
async function threadsOf(
  db: Db,
  room: { id: string; agentId: string; burrowId: string; personId: string; room: ChatRoom },
  rows: readonly ThreadRow[],
  iconsDue?: (repos: string[]) => void,
): Promise<ChatThread[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const where = {
    burrowId: room.burrowId,
    conversationId: room.id,
    agentId: room.agentId,
    personId: room.personId,
  };
  const replied = rows.filter((r) => r.replyCount > 0).map((r) => r.id);
  const [working, held, waiting, choices, works, lasts, repoOf, jobs] = await Promise.all([
    workingThreads(db, where, ids),
    // Work handed over from it still goes on (T3 Code, a council, a delegation): it doesn't settle (DLG-31).
    workingThreads(db, where, ids, { handedOver: true }),
    waitingThreads(db, where, ids),
    // What answers each thread of the Chat, the person's own choice (chat-runtime.md); null: the assistant's.
    room.room === 'chat' ? threadChoices(db, ids) : new Map(),
    // The council or checklist going on from it, for its row.
    threadWorks(db, room.id, ids),
    // The row's second line: the newest reply (chat-inbox.md CIB-03).
    lastReplies(db, replied),
    // The repository its work is in, for its row's icon.
    threadRepos(db, where, ids),
    // How the latest job handed to T3 Code from it ended, for its row's Done (chat-inbox-web.md).
    endedJobs(db, where, ids),
  ]);
  const icons = await storedRepoIcons(db, room.burrowId, [...repoOf.values()]);
  const due = [...new Set(repoOf.values())].filter((name) => icons.get(repoIconKey(name))?.due);
  if (due.length && iconsDue) iconsDue(due);
  return rows.map((r): ChatThread => {
    const subject = messageSubjectOf(r);
    const thread: ChatThread = {
      conversationId: room.id,
      room: room.room,
      rootId: r.id,
      authorId: r.authorId,
      text: threadText(r.text, r.attachmentIds.length, r.card),
      ...(subject ? { subject } : {}),
      createdAt: iso(r.createdAt),
      replyCount: r.replyCount,
      lastAt: iso(r.lastReplyAt ?? r.createdAt),
      working: working.has(r.id),
      runtime: choices.get(r.id) ?? null,
      settled: threadSettleOf(r),
      waiting: waiting.has(r.id),
      ...(held.has(r.id) && !working.has(r.id) ? { handedOver: true } : {}),
    };
    const last = lasts.get(r.id);
    if (last) thread.last = last;
    const job = jobs.get(r.id);
    if (job) thread.job = job;
    const repo = repoOf.get(r.id);
    if (repo) {
      const iconUrl = icons.get(repoIconKey(repo))?.iconUrl;
      thread.repo = { fullName: repo, name: repoShortName(repo), ...(iconUrl ? { iconUrl } : {}) };
    }
    return withWork(thread, works.get(r.id));
  });
}

/**
 * A room's threads for its person (`chats.threads`, CHT-07): its top-level messages, optionally only those about one
 * thing, and only open or only settled ones. Open threads (and all of them) come newest activity first, paged by their
 * last activity; settled ones latest settled first, paged by when they settled (`next`: the last row's, while there are
 * more). A first page says how many of them are settled. Every top-level message is a thread's start, the assistant's
 * own posts too (CHT-02). Empty when the room doesn't exist.
 */
export async function listThreads(
  db: Db,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
  options: ThreadListOptions = {},
): Promise<{ threads: ChatThread[]; next: string | null; settledCount?: number }> {
  const room = options.room ?? 'chat';
  const found = await roomIdOf(db, person, room);
  if (!found || options.place === 'code') {
    return { threads: [], next: null, ...(options.before ? {} : { settledCount: 0 }) };
  }
  const limit = Math.max(1, Math.min(options.limit ?? CHAT_THREADS_LIMIT_DEFAULT, CHAT_THREADS_LIMIT_MAX));
  const settledShelf = options.state === 'settled';
  const lastAt = sql<Date>`coalesce(${messages.lastReplyAt}, ${messages.createdAt})`;
  const pageBy = settledShelf ? sql<Date>`${messages.settledAt}` : lastAt;
  const before = options.before ? new Date(options.before) : null;
  const threadsHere = and(
    eq(messages.conversationId, found.id),
    isNull(messages.threadRootId),
    isNull(messages.deletedAt),
    options.subject ? eq(messages.subjectKind, options.subject.kind) : undefined,
    options.subject?.id ? eq(messages.subjectId, options.subject.id) : undefined,
  );
  const [rows, counted] = await Promise.all([
    db
      .select(threadColumns)
      .from(messages)
      .where(
        and(
          threadsHere,
          options.state === 'open' ? isNull(messages.settledAt) : undefined,
          settledShelf ? isNotNull(messages.settledAt) : undefined,
          before && !Number.isNaN(before.getTime())
            ? sql`${pageBy} < ${before.toISOString()}::timestamptz`
            : undefined,
        ),
      )
      .orderBy(desc(pageBy), desc(messages.id))
      .limit(limit + 1),
    // “Settled · 14” comes with a first page only.
    options.before
      ? null
      : db
          .select({ n: count() })
          .from(messages)
          .where(and(threadsHere, isNotNull(messages.settledAt))),
  ]);
  const page = rows.slice(0, limit);
  const threads = await threadsOf(
    db,
    { id: found.id, agentId: found.agentId, burrowId: person.burrowId, personId: person.id, room },
    page,
    options.iconsDue,
  );
  const last = threads.at(-1);
  const cursor = settledShelf ? last?.settled?.at : last?.lastAt;
  return {
    threads,
    next: rows.length > limit && cursor ? cursor : null,
    ...(counted ? { settledCount: counted[0]?.n ?? 0 } : {}),
  };
}

/** One thread of the person's room as the Threads list shows it, or null when it isn't one (`chats.settle`). */
export async function loadThread(
  db: Db,
  person: Pick<PrincipalRow, 'id' | 'burrowId'>,
  room: ChatRoom,
  rootId: string,
): Promise<ChatThread | null> {
  const found = await roomIdOf(db, person, room);
  if (!found) return null;
  const rows = await db
    .select(threadColumns)
    .from(messages)
    .where(
      and(
        eq(messages.id, rootId),
        eq(messages.conversationId, found.id),
        isNull(messages.threadRootId),
        isNull(messages.deletedAt),
      ),
    );
  const [thread] = await threadsOf(
    db,
    { id: found.id, agentId: found.agentId, burrowId: person.burrowId, personId: person.id, room },
    rows,
  );
  return thread ?? null;
}
