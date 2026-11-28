import { z } from 'zod';
import { coreWords } from '../i18n/catalog.js';
import { BurrowId, ConversationId, MessageId, PrincipalId, RepoId } from '../ids.js';
import { ChatRuntime } from './chat-runtime.js';
import { Count, Timestamp } from './common.js';
import { CouncilMark, CouncilStage } from './council.js';
import { HandoffOutcome } from './handoff.js';
import { ConversationLink, LinkRef } from './links.js';

/**
 * `dm`: a person's own room with the agent — their Chat, their Feedback room or a task chat, private to them (Whombat
 * one-agent.md OA-04); `branch`: a pull request's room. There are no channels and no conversations between people.
 */
export const ConversationKind = z.enum(['dm', 'branch']);
export type ConversationKind = z.infer<typeof ConversationKind>;

/**
 * A person's notification level for one conversation (0.26, CT-175): `all` = every message by someone else,
 * `mentions` = mentions, `@channel` / `@here` and replies in threads they're in, `none` = only needs-you items addressed
 * to them. Absent = {@link defaultNotifyLevel}.
 */
export const NotifyLevel = z.enum(['all', 'mentions', 'none']);
export type NotifyLevel = z.infer<typeof NotifyLevel>;

/** The level a conversation has until the person picks one: `dm` → `all`, branch rooms → `mentions`. */
export function defaultNotifyLevel(kind: ConversationKind): NotifyLevel {
  return kind === 'dm' ? 'all' : 'mentions';
}

/** The level in effect: the person's own (`notify`), else the kind's default. */
export function notifyLevelOf(c: { kind: ConversationKind; notify?: NotifyLevel | null }): NotifyLevel {
  return c.notify ?? defaultNotifyLevel(c.kind);
}

const NOTIFY_LEVEL_LABELS_KEYS = ['all', 'mentions', 'none'] as const;

/** `Bell` menu labels (All / Mentions / Nothing). */
export function notifyLevelLabels(
  locale?: string | null,
): Readonly<Record<(typeof NOTIFY_LEVEL_LABELS_KEYS)[number], string>> {
  return coreWords(locale, 'notify.level', NOTIFY_LEVEL_LABELS_KEYS);
}

export const NOTIFY_LEVEL_LABELS: Record<NotifyLevel, string> = notifyLevelLabels('en');

/* Task chats (Whombat one-whombat.md ONE-06, contracts 0.80.0, CT-337) ------------------------------- */

/** The most characters of a task chat's title: the first line of its first message, cut here. */
export const CHAT_TITLE_MAX = 60;

/** What a task chat is about: a server, a connection or a device (ONE-06). `id` is the thing's own id. */
export const ChatSubject = z.object({
  kind: z.enum(['server', 'connection', 'device']),
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
});
export type ChatSubject = z.infer<typeof ChatSubject>;

/**
 * A DM that is a task chat with the person's Whombat (ONE-06): its title, its subject, and when it was archived. The
 * person's default chat (the personal DM, where approval cards and Vault asks land) has none.
 */
export const ConversationChat = z.object({
  title: z.string().min(1).max(CHAT_TITLE_MAX),
  subject: ChatSubject.nullable().optional(),
  archivedAt: Timestamp.nullable().optional(),
});
export type ConversationChat = z.infer<typeof ConversationChat>;

/* Chat and Feedback (Whombat chat-channel.md CHT-01…CHT-07, contracts 0.93.0, CT-441, CT-442) --------- */

/**
 * A person's rooms with the agent (CHT-01, CHT-03; OA-04): `chat` is their default DM, threaded (each
 * top-level message starts a thread); `feedback` is the room their website feedback and assessing automations post in.
 */
export const CHAT_ROOMS = ['chat', 'feedback'] as const;
export const ChatRoom = z.enum(CHAT_ROOMS);
export type ChatRoom = z.infer<typeof ChatRoom>;

/** What `ChatSummary.room` names: a room, or `task` (a task chat from before the Chat shell, ONE-06). */
export const CHAT_SUMMARY_ROOMS = [...CHAT_ROOMS, 'task'] as const;
export type ChatSummaryRoom = (typeof CHAT_SUMMARY_ROOMS)[number];

/** A row of the chats list (sidebar “Conversations”, the phone's Chats): newest first. */
export const ChatSummary = z.object({
  id: ConversationId,
  title: z.string().min(1).max(120),
  subject: ChatSubject.nullable().optional(),
  lastAt: Timestamp.nullable(),
  /** The start of the last message, plain text. */
  lastText: z.string().max(200).optional(),
  unread: Count,
  /** The person's default chat (the personal DM). */
  default: z.boolean(),
  archivedAt: Timestamp.nullable().optional(),
  /**
   * Which room it is (0.93, CT-441; CHT-01, CHT-03): `chat`, `feedback`, or `task`. Absent means `task`, but a
   * `default: true` row is the Chat (`chatSummaryRoom`).
   */
  room: z.enum(CHAT_SUMMARY_ROOMS).optional(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

/** A chats-list row's room: its `room`, else `chat` for the default chat and `task` for any other (CT-441). */
export function chatSummaryRoom(
  s: Pick<ChatSummary, 'default'> & { room?: ChatSummaryRoom },
): ChatSummaryRoom {
  return s.room ?? (s.default ? 'chat' : 'task');
}

/** The most characters of `ChatThread.text`: the start of the thread's first message. */
export const CHAT_THREAD_TEXT_MAX = 200;

/**
 * How a thread of Chat or Feedback was settled (3.8; Whombat chat-settle.md): by its person, by itself after days
 * without a message (`ChatPreferences.settleQuietDays`), when the pull request its work opened merged or closed, or
 * (3.10) when the problem the assistant looked into by itself went away (Whombat look-research.md).
 */
export const THREAD_SETTLED_HOW = ['person', 'quiet', 'merged', 'resolved'] as const;
export const ThreadSettledHow = z.enum(THREAD_SETTLED_HOW);
export type ThreadSettledHow = z.infer<typeof ThreadSettledHow>;

/**
 * A settled thread (3.8): finished and put away, still searchable and opened as before. `at` is when its work ended (a
 * thread that settles by itself takes its last message's time), so the Settled shelf orders by it. A new message in
 * the thread opens it again.
 */
export const ThreadSettle = z.object({ at: Timestamp, how: ThreadSettledHow });
export type ThreadSettle = z.infer<typeof ThreadSettle>;

/**
 * Where a thread of the person's Chat shows (3.20), for apps from before one Chat (Whombat one-chat.md): a box answers
 * every thread as Chat's and none as Code's. Goes with the next major.
 */
export const THREAD_PLACES = ['chat', 'code'] as const;
export const ThreadPlace = z.enum(THREAD_PLACES);
export type ThreadPlace = z.infer<typeof ThreadPlace>;

/**
 * A thread in Code (3.20): the job, its repository, branch and pull request, when it moved and whether it was opened in
 * Code. Never sent since one Chat (Whombat one-chat.md); goes with the next major.
 */
export const ThreadCode = z.object({
  title: z.string().min(1).max(160),
  project: z.string().max(160).nullable(),
  branch: z.string().max(300).nullable(),
  pullRequest: z.string().max(500).nullable(),
  movedAt: Timestamp,
  seen: z.boolean(),
});
export type ThreadCode = z.infer<typeof ThreadCode>;

/** A council member on a thread's row: its provider's mark (else its first letter) and whether it works now. */
export const ThreadWorkMember = z.object({
  mark: CouncilMark.nullable(),
  letter: z.string().min(1).max(2),
  working: z.boolean(),
});
export type ThreadWorkMember = z.infer<typeof ThreadWorkMember>;

/**
 * Work going on from a thread, as its row says it (3.20; Whombat one-chat.md): a council (its stage, how many of the
 * round answered, its members) or a checklist of tasks (how many are done, at work, and whether one needs the person).
 * Work handed to T3 Code alone comes with the conversation's `Handoff`s. `since`: when it started.
 */
export const ThreadWork = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('council'),
    stage: CouncilStage,
    answered: Count,
    of: Count,
    members: z.array(ThreadWorkMember).max(6),
    since: Timestamp,
  }),
  z.object({
    kind: z.literal('tasks'),
    done: Count,
    total: Count,
    working: Count,
    needsYou: z.boolean(),
    /**
     * The list is offered and waits for the person's Hand over (Whombat delegate.md): `total` counts its tasks, none
     * done or working, and `needsYou` is true, so an app from before reads it as needing the person. Absent: handed over.
     */
    offered: z.boolean().optional(),
    since: Timestamp,
  }),
]);
export type ThreadWork = z.infer<typeof ThreadWork>;

/** `ChatThread.last`: a thread's newest reply, as a list row shows it (Whombat chat-inbox.md CIB-03). */
export const ChatThreadLast = z.object({
  authorId: PrincipalId,
  text: z.string().max(CHAT_THREAD_TEXT_MAX),
  at: Timestamp,
});
export type ChatThreadLast = z.infer<typeof ChatThreadLast>;

/**
 * `ChatThread.job`: how the latest job handed over from a thread ended (a T3 Code thread, Whombat t3code.md), as long as
 * the person hasn't written in the thread since. Its row says Done, Didn’t finish or Stopped by it once the live
 * hand-overs no longer list the job.
 */
export const ChatThreadJob = z.object({
  outcome: HandoffOutcome,
  endedAt: Timestamp,
});
export type ChatThreadJob = z.infer<typeof ChatThreadJob>;

/**
 * The plain start of a message for a list row's preview (Whombat chat-inbox.md): its lines joined by a space, Markdown
 * marks dropped, a link as its words (`[PR 69](https://…)` reads “PR 69”), a bare address without its scheme, clipped
 * with “…” at `max`. Empty for a message without words. The server makes `ChatThread.last.text` with it and the apps
 * the same for a reply they just saw, so a row reads the same from both.
 */
export function threadPreview(text: string, max = CHAT_THREAD_TEXT_MAX): string {
  const plain = text
    // A fenced block's fence lines; its words stay.
    .replace(/^\s*(?:```|~~~).*$/gm, '')
    // An image or a link as its words.
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/\bhttps?:\/\/(?:www\.)?/gi, '')
    .split('\n')
    .map((l) =>
      l
        // Heading and quote marks, and a list item's bullet or number (only before a space).
        .replace(/^\s*(?:[#>]+\s*|[-*+]\s+|\d+[.)]\s+)*/, '')
        .replace(/[*`#>]/g, '')
        // `_` only as emphasis at a word's edge: `my_app.py` keeps its underscore.
        .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
        // A table's bars.
        .replace(/\s*\|\s*/g, ' ')
        .trim(),
    )
    .filter((l) => l.length > 0 && !/^[-:\s]+$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...plain];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : plain;
}

/**
 * The repository a thread's work is in (Whombat chat-inbox.md): a coding job's or a repository automation's. Its row
 * shows the repository's own icon: `iconUrl` is an attachment URL (`/api/v1/burrows/{slug}/attachments/{id}`) the apps
 * load like an image attachment; absent or null, the row shows the name's first letter on a tile.
 */
export const ChatThreadRepo = z.object({
  /** `owner/name`. */
  fullName: z.string().min(3).max(255),
  /** `name`: what the row's title says after “ · ”. */
  name: z.string().min(1).max(120),
  iconUrl: z.string().min(1).max(300).nullable().optional(),
});
export type ChatThreadRepo = z.infer<typeof ChatThreadRepo>;

/**
 * A thread in a person's Chat or Feedback room (0.93, CT-442; CHT-02, CHT-07): the Threads list, a thing page's Ask
 * pane and the phone read these (`chats.threads`). A thread is a top-level message and its replies; it is about
 * `subject` when one was given on its first message (CHT-05).
 */
export const ChatThread = z.object({
  conversationId: ConversationId,
  room: ChatRoom,
  /** The thread's first message: `?thread=` in its link (`chatThreadHref`). */
  rootId: MessageId,
  authorId: PrincipalId,
  /**
   * The start of the first message, plain text; how many files (“A file”) when it has only files, and what its card is
   * called (`cardTitle`) when it is only a card.
   */
  text: z.string().max(CHAT_THREAD_TEXT_MAX),
  subject: ChatSubject.nullable().optional(),
  createdAt: Timestamp,
  replyCount: Count,
  /** The last reply, else `createdAt`: the list's order, newest first, and its paging (`before`). */
  lastAt: Timestamp,
  /** The assistant has a turn on this thread now (“is looking into it”). */
  working: z.boolean(),
  /**
   * What answers in this thread (0.96, CT-459; Whombat chat-runtime.md CR-02), the caller's own choice. Null: it follows
   * the assistant's own runtime (absent too).
   */
  runtime: ChatRuntime.nullable().optional(),
  /** Settled (3.8; chat-settle.md): null or absent while it is open. */
  settled: ThreadSettle.nullable().optional(),
  /**
   * Something in it waits for the person (3.8): a yes or no, a key or Vault request, or a question card. Such a
   * thread is never settled, by them or by itself, until it is answered. Absent: false.
   */
  waiting: z.boolean().optional(),
  /**
   * Work handed over from it still goes on (a T3 Code thread, a council or a delegation, Whombat t3code.md T3-27,
   * council.md CNL-43, delegate.md DLG-31): it doesn't settle until that is over. Absent: false.
   */
  handedOver: z.boolean().optional(),
  /** 3.20: where it shows; absent: Chat. Never sent since one Chat (Whombat one-chat.md). */
  place: ThreadPlace.optional(),
  /** 3.20: what Code showed of it. Never sent since one Chat. */
  code: ThreadCode.nullable().optional(),
  /** 3.20: a council or a checklist going on from it, for its row; null or absent: none. */
  work: ThreadWork.nullable().optional(),
  /**
   * The newest reply with words or files (Whombat chat-inbox.md CIB-03): who wrote it, its plain first line (“A file”,
   * “3 files” when it has only files) and when. Absent before the first reply, or when the replies are only cards.
   */
  last: ChatThreadLast.optional(),
  /** The repository its work is in, for its row's icon (Whombat chat-inbox.md). Absent or null: none. */
  repo: ChatThreadRepo.nullable().optional(),
  /**
   * How the latest job handed over from it ended, while the person hasn't written there since (`ChatThreadJob`). Absent
   * or null: none ended, it still goes on, or the person wrote after it. `working`, `waiting` and a live hand-over win
   * over it on the row.
   */
  job: ChatThreadJob.nullable().optional(),
});
export type ChatThread = z.infer<typeof ChatThread>;

/** `chats.threads`' page size: 30 unless asked, at most 50. */
export const CHAT_THREADS_LIMIT_DEFAULT = 30;
export const CHAT_THREADS_LIMIT_MAX = 50;

/** A task chat's title from its first message: the first non-empty line, Markdown marks dropped, ≤ 60 characters. */
export function chatTitleFrom(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          // Heading and quote marks, and a list item's bullet (only before a space: `-5 °C` keeps its minus).
          .replace(/^\s*(?:[#>]+\s*|[-*+]\s+)*/, '')
          .replace(/[*`]/g, '')
          // `_` only as emphasis at a word's edge: `my_app.py` keeps its underscore.
          .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
          .trim(),
      )
      .find((l) => l.length > 0) ?? '';
  if (!line) return 'New chat';
  const chars = [...line];
  if (chars.length <= CHAT_TITLE_MAX) return line;
  const cut = chars.slice(0, CHAT_TITLE_MAX - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const SUBJECT_NOUN: Record<ChatSubject['kind'], string> = {
  server: 'the server',
  connection: 'the connection',
  device: 'the device',
};

/** The turn context's line for a chat's subject: “This chat is about the server pve-02.” */
export function chatSubjectLine(subject: ChatSubject): string {
  return `This chat is about ${SUBJECT_NOUN[subject.kind]} ${subject.name}.`;
}

/** The same for a thread in Chat (0.93, CHT-05): “This thread is about the server pve-02.” */
export function chatThreadSubjectLine(subject: ChatSubject): string {
  return `This thread is about ${SUBJECT_NOUN[subject.kind]} ${subject.name}.`;
}

/** Header action button ("Plan canvas", "Branch room"). */
export const ConversationAction = z.object({
  label: z.string().min(1).max(40),
  link: LinkRef,
});
export type ConversationAction = z.infer<typeof ConversationAction>;

/**
 * The person's room with the agent, or a branch room (one per PR). Since 3.0 (CT-1514; Whombat one-person.md OP-03) every
 * conversation is the person's with the agent: `memberIds`, `dmPersonId` and `memberCount` went.
 *
 * - dm:     the person's Chat (`/:burrow/chat`), Feedback room (`/:burrow/feedback`) or a task chat (`chat` set,
 *           `/:burrow/chats/:id`).
 * - branch: `title` is the branch (`feat/invoice-pdf`), `prNumber` set; route `/:burrow/pr/:prNumber?repo=owner/name`.
 */
export const Conversation = z.object({
  id: ConversationId,
  burrowId: BurrowId,
  kind: ConversationKind,
  slug: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  topic: z.string().max(280),
  actions: z.array(ConversationAction),
  prNumber: z.number().int().positive().nullable(),
  repoId: RepoId.nullable(),
  createdAt: Timestamp,
  lastMessageAt: Timestamp.nullable(),
  /**
   * A DM that is a task chat with the person's Whombat (0.80, CT-337; one-whombat.md ONE-06): title, subject, archived.
   * Null or absent on every other conversation, the default chat included.
   */
  chat: ConversationChat.nullable().optional(),
});
export type Conversation = z.infer<typeof Conversation>;

/** Sidebar / list row with the viewer's unread state. */
export const ConversationSummary = z.object({
  id: ConversationId,
  kind: ConversationKind,
  slug: z.string(),
  title: z.string(),
  link: ConversationLink,
  /** Unread messages for the viewer (badge on its row). */
  unread: Count,
  /** Unread messages that mention the viewer. */
  mentions: Count,
  prNumber: z.number().int().positive().nullable(),
  lastMessageAt: Timestamp.nullable(),
  /** The viewer's own level for this conversation (0.26); absent = `defaultNotifyLevel(kind)`. */
  notify: NotifyLevel.optional(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

/**
 * Link for a conversation. Branch rooms carry their repository when `repo` is given (CT-170); a task chat links to
 * itself (CT-348); a person's other rooms link to their `room` (Chat unless it is the Feedback room).
 */
export function conversationLink(
  c: Pick<Conversation, 'kind' | 'slug' | 'prNumber'> & {
    id?: string;
    repo?: string | null;
    /** A task chat's part (`Conversation.chat`): set, the link is the chat's own (0.80.1, CT-348). */
    chat?: ConversationChat | null;
    /** Which of the person's rooms it is. */
    room?: ChatRoom;
  },
): ConversationLink {
  if (c.kind === 'branch' && c.prNumber)
    return c.repo ? { type: 'pr', number: c.prNumber, repo: c.repo } : { type: 'pr', number: c.prNumber };
  if (c.chat && c.id) return { type: 'chat', id: c.id };
  return c.room === 'feedback' ? { type: 'dm', room: 'feedback' } : { type: 'dm' };
}

/** "feat/invoice-pdf", "Chat" — the conversation as named in "where" lines. */
export function conversationLabel(c: Pick<Conversation, 'kind' | 'title'>): string {
  return c.title;
}
