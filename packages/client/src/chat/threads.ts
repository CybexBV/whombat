/**
 * A room's threads (Whombat chat-channel.md CHT-02, CHT-07; contracts 0.93.0 `ChatThread`, `chats.threads`; app
 * chat-channel.md AP-2405…AP-2409): the Threads list's rows, what a new message does to a cached list, and the line
 * under a thread's first message while the assistant works on it. Pure; web and phone share it.
 */
import {
  CHAT_THREAD_TEXT_MAX,
  type ChatRoom,
  type ChatSubject,
  type ChatThread,
  cardTitle,
  chatThreadHref,
  formatReplies,
  type Message,
  type ThreadSettle,
} from '@whombat/core';
import { doneWhen } from '../home/time';
import { lastReplyLabel } from '../threads';
import { lastOfMessage } from './inbox';

/** A row of the Threads list (AP-2407). */
export interface ThreadRow {
  rootId: string;
  room: ChatRoom;
  /** `/chat?thread=<root>`. */
  href: string;
  authorId: string;
  /** The first message's first line, plain. */
  text: string;
  subject: ChatSubject | null;
  /** “4 replies”, or null before the first. */
  replies: string | null;
  /** “Last reply 2 min ago” after replies; else when it was asked (“09:41”, “Fri”, “3 Oct”). */
  when: string;
  /** The assistant works on it now (“Neo is looking into it”). */
  working: boolean;
  /** Something in it waits for the person (contracts 3.8; chat-settle.md AP-6153). */
  waiting: boolean;
  /** Settled, and how (AP-6153); null while open. */
  settled: ThreadSettle | null;
}

/** The first non-empty line of a message, Markdown marks dropped: what a thread is called in a list. */
export function threadTitle(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .replace(/^[#>*\-\s]+/, '')
          .replace(/[*_`]/g, '')
          .trim(),
      )
      .find((l) => l.length > 0) ?? '';
  return line;
}

/**
 * What a thread is called from its first message, as the server's `chats.threads` says it: its words, else how many files
 * it has, else what its card is called (a guide's “Your email”), so a thread that starts with a card has a real title.
 */
export function rootText(m: Pick<Message, 'text' | 'attachments' | 'card'>): string {
  const text = m.text.slice(0, CHAT_THREAD_TEXT_MAX);
  if (text.trim()) return text;
  const files = m.attachments?.length ?? 0;
  if (files) return files === 1 ? 'A file' : `${files} files`;
  return m.card ? cardTitle(m.card).slice(0, CHAT_THREAD_TEXT_MAX) : '';
}

/** The title of an open thread's head: its first message's first line, or what `rootText` calls it. */
export function rootTitle(m: Pick<Message, 'text' | 'attachments' | 'card'>): string {
  return threadTitle(m.text) || threadTitle(rootText(m));
}

/** The Threads list's rows, newest activity first as the server sends them (CHT-07). */
export function threadRows(
  threads: readonly ChatThread[],
  now: Date | number,
  timeZone: string,
): ThreadRow[] {
  return threads.map((t) => ({
    rootId: t.rootId,
    room: t.room,
    href: chatThreadHref(t.room, t.rootId),
    authorId: t.authorId,
    text: threadTitle(t.text),
    subject: t.subject ?? null,
    replies: t.replyCount > 0 ? formatReplies(t.replyCount) : null,
    when: t.replyCount > 0 ? lastReplyLabel(t.lastAt, now, timeZone) : doneWhen(t.createdAt, now, timeZone),
    working: t.working,
    waiting: !!t.waiting,
    settled: t.settled ?? null,
  }));
}

/** A thread from its first message (a new top-level message, `chats.start`'s answer). */
export function threadOfMessage(m: Message, room: ChatRoom): ChatThread {
  return {
    conversationId: m.conversationId,
    room,
    rootId: m.id,
    authorId: m.authorId,
    text: rootText(m),
    subject: m.subject ?? null,
    createdAt: m.createdAt,
    replyCount: m.replyCount,
    lastAt: m.lastReplyAt ?? m.createdAt,
    working: false,
    settled: m.settled ?? null,
  };
}

/** Which threads a cached list holds: its room and, when asked by subject, only those about it. */
export interface ThreadListScope {
  room: ChatRoom;
  subjectKind?: string | null;
  subjectId?: string | null;
  /** `chats.threads`' `state` (contracts 3.8, CHS-10): only open threads, or only settled ones; absent: all. */
  state?: 'open' | 'settled' | null;
}

function about(scope: ThreadListScope, subject: ChatSubject | null | undefined): boolean {
  if (!scope.subjectKind && !scope.subjectId) return true;
  return (
    !!subject &&
    (!scope.subjectKind || subject.kind === scope.subjectKind) &&
    (!scope.subjectId || subject.id === scope.subjectId)
  );
}

/**
 * A list's pages with a message in them (AP-2408), newest first: a new top-level message of the list's room (and
 * subject) starts a thread at the top; a reply moves its thread to the top with one more reply and its time (an agent's
 * reply ends “is looking into it”); a root edited in place keeps its spot with its new words. Anything already counted
 * (the same reply from the send's answer and the event, an edit of a reply) changes nothing. `null` when the message
 * belongs to the list but its thread isn't loaded (a reply to an older thread): read the list again. `room` is the
 * message's conversation's room, or null when unknown (another conversation): then only a thread already listed moves.
 * A list of settled threads (`state: settled`) takes no new thread and keeps its rows: a reply opens its thread again,
 * which the server says with `chat.settled` (chat-settle.md CHS-04). A settled root that isn't listed stays out.
 * A root the list hasn't loaded goes where its last activity puts it: a new question at the top, an older one changed
 * (a reaction, an edit, a pin) among the loaded rows, or past them only when the list is `complete` (no older page).
 */
export function threadPagesWithMessage(
  pages: readonly (readonly ChatThread[])[],
  m: Message,
  scope: ThreadListScope,
  room: ChatRoom | null,
  agent: (principalId: string) => boolean = () => false,
  complete = false,
): ChatThread[][] | null {
  if (scope.state === 'settled' && m.threadRootId) return pages as ChatThread[][];
  const rootId = m.threadRootId ?? m.id;
  let found: ChatThread | undefined;
  for (const page of pages) {
    found = page.find((t) => t.rootId === rootId);
    if (found) break;
  }
  if (!m.threadRootId) {
    if (found) {
      const text = rootText(m);
      if (found.text === text) return pages as ChatThread[][];
      return pages.map((page) =>
        page.some((t) => t.rootId === rootId)
          ? page.map((t) => (t.rootId === rootId ? { ...t, text } : t))
          : (page as ChatThread[]),
      );
    }
    // A settled root isn't a new thread: settling sends its first message again, after it left the open list.
    if (scope.state === 'settled' || m.settled || room !== scope.room || !about(scope, m.subject))
      return pages as ChatThread[][];
    return placedByActivity(pages, threadOfMessage(m, room), complete);
  }
  // A subject's list only holds threads about it: one it doesn't have is about something else.
  if (!found)
    return room === scope.room && !scope.subjectKind && !scope.subjectId ? null : (pages as ChatThread[][]);
  if (Date.parse(m.createdAt) <= Date.parse(found.lastAt)) return pages as ChatThread[][];
  // The row's second line follows the newest reply with words or files (chat-inbox.md CIB-03).
  const last = lastOfMessage(m);
  const bumped: ChatThread = {
    ...found,
    replyCount: found.replyCount + 1,
    lastAt: m.createdAt,
    working: agent(m.authorId) ? false : found.working,
    ...(last ? { last } : {}),
  };
  const next = threadPagesWithout(pages, found.rootId) as ChatThread[][];
  next[0] = [bumped, ...(next[0] ?? [])];
  return next;
}

/**
 * The pages with a thread put before the first loaded row with no newer activity (newest first, so a new question goes
 * first); past the last loaded row only when nothing is older or nothing is loaded. Unchanged pages keep their arrays.
 */
function placedByActivity(
  pages: readonly (readonly ChatThread[])[],
  t: ChatThread,
  complete: boolean,
): ChatThread[][] {
  const at = Date.parse(t.lastAt);
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] as readonly ChatThread[];
    const j = page.findIndex((x) => Date.parse(x.lastAt) <= at);
    if (j < 0) continue;
    const next = [...pages] as ChatThread[][];
    next[i] = [...page.slice(0, j), t, ...page.slice(j)];
    return next;
  }
  const loaded = pages.some((p) => p.length > 0);
  if (loaded && !complete) return pages as ChatThread[][];
  const next = pages.length ? ([...pages] as ChatThread[][]) : [[]];
  const last = next.length - 1;
  next[last] = [...(next[last] ?? []), t];
  return next;
}

/** A list's pages without a thread whose first message is gone (`message.deleted` of a root). */
export function threadPagesWithout(
  pages: readonly (readonly ChatThread[])[],
  rootId: string,
): ChatThread[][] | null {
  let next: ChatThread[][] | null = null;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] as readonly ChatThread[];
    if (!page.some((t) => t.rootId === rootId)) continue;
    // Unchanged pages keep their arrays so the query cache can skip comparing their rows.
    next ??= [...pages] as ChatThread[][];
    next[i] = page.filter((t) => t.rootId !== rootId);
  }
  return next;
}

/** The newest thread about a subject in a list, or null (a thing page's Ask pane, CHT-23). */
export function newestThreadAbout(
  threads: readonly ChatThread[],
  subject: Pick<ChatSubject, 'kind' | 'id'>,
): ChatThread | null {
  return threads.find((t) => t.subject?.kind === subject.kind && t.subject.id === subject.id) ?? null;
}
