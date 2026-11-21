/**
 * Chat and Feedback as a mail inbox on the phone (Whombat chat-inbox.md; app chat-inbox-phone.md): what TalkBack and
 * VoiceOver hear for a thread's row, what its swipes and long press offer, where the “New” line goes in a thread that
 * opened with something new, how tall the message box may grow, and a thread's root from the inbox's list while the
 * thread loads. The rows themselves are the shared `inboxRows`. Pure; the screen is `screens/ChatInbox.tsx`.
 */
import { type HumanTone, toneFor } from '@whombat/avatars';
import { INBOX_WORDS, type InboxFilter, type InboxRow, newCountLabel, PROMPT_WORDS } from '@whombat/client';
import { CHAT_THREAD_TEXT_MAX, type ChatThread, type Message, type ThreadView } from '@whombat/core';
import { SETTLE_COPY } from './threadSettle';

/**
 * “Firmware for the access points, 2 new messages, waiting for you, Neo: Shall I…, 10:48”. The name before the line is
 * always said, the assistant's too (the row shows its face instead); a repository's name is said after the title when
 * the title doesn't say it already.
 */
export function inboxRowLabel(
  row: Pick<InboxRow, 'title' | 'who' | 'line' | 'when' | 'unread' | 'waiting' | 'working'> &
    Partial<Pick<InboxRow, 'repoName'>>,
): string {
  const status = row.waiting
    ? INBOX_WORDS.waitingForYou.toLowerCase()
    : row.working
      ? INBOX_WORDS.working.toLowerCase()
      : null;
  const line = row.line ? (row.who ? `${row.who}: ${row.line}` : row.line) : null;
  const repo =
    row.repoName && !row.title.toLocaleLowerCase().includes(row.repoName.toLocaleLowerCase())
      ? row.repoName
      : null;
  return [row.title, repo, row.unread > 0 ? newCountLabel(row.unread) : null, status, line, row.when]
    .filter(Boolean)
    .join(', ');
}

/** The tile behind a repository's letter: one of the avatars' tones, chosen from its name, so it keeps its colour. */
export function repoTone(name: string): HumanTone {
  return toneFor(name.toLocaleLowerCase());
}

export type InboxMark = 'unread' | 'read';

/** What a row's swipes do: left settles it (when it can settle now), right marks it unread or read. */
export interface InboxSwipe {
  settle: boolean;
  /** Read with something new: Mark as read; read and something in it came from someone else: Mark as unread. */
  mark: InboxMark | null;
}

export function inboxSwipe(row: Pick<InboxRow, 'settleable' | 'markable' | 'unread'>): InboxSwipe {
  return {
    settle: row.settleable,
    mark: row.unread > 0 ? 'read' : row.markable ? 'unread' : null,
  };
}

/** The ids of a row's actions: its long-press menu's and its screen reader actions. */
export type InboxActionId = 'settle' | 'mark_unread' | 'mark_read' | 'copy_link' | 'share';

export interface InboxAction {
  id: InboxActionId;
  title: string;
}

/**
 * A row's actions, as the swipes have them and then the thread's link: Settle, Mark as unread or as read, Copy link
 * (where the thread has a web address) and Share (Chat on a box).
 */
export function inboxActions(swipe: InboxSwipe, options: { link: boolean; share: boolean }): InboxAction[] {
  const out: InboxAction[] = [];
  if (swipe.settle) out.push({ id: 'settle', title: SETTLE_COPY.settleThread });
  if (swipe.mark === 'unread') out.push({ id: 'mark_unread', title: INBOX_WORDS.markUnread });
  if (swipe.mark === 'read') out.push({ id: 'mark_read', title: INBOX_WORDS.markRead });
  if (options.link) out.push({ id: 'copy_link', title: 'Copy link' });
  if (options.share) out.push({ id: 'share', title: 'Share' });
  return out;
}

/** A pick from a row's menu or a screen reader action: one of `inboxActions`' ids, or null for one it never sent. */
export function parseInboxAction(id: string): InboxActionId | null {
  return id === 'settle' || id === 'mark_unread' || id === 'mark_read' || id === 'copy_link' || id === 'share'
    ? id
    : null;
}

/** The words under the filters when a filter shows nothing: a title and, for some, a line under it. */
export function inboxEmpty(filter: InboxFilter): { title: string; hint: string | null } {
  if (filter === 'unread') return { title: INBOX_WORDS.nothingNew, hint: INBOX_WORDS.nothingNewHint };
  if (filter === 'waiting') return { title: INBOX_WORDS.nothingWaits, hint: null };
  return { title: INBOX_WORDS.allSettled, hint: INBOX_WORDS.allSettledHint };
}

/* The “New” line in a thread ------------------------------------------------------------------------------------ */

/**
 * Where a thread that opened with `unread` new messages had been read up to: the message just before its first new one,
 * found by counting back over messages by someone else (after the person's marker there are only those, since writing
 * in a thread reads it). Null when nothing is new, or when the first new message is the thread's first or not loaded:
 * a line at the very top says nothing.
 */
export function threadReadUpTo(
  messages: readonly Pick<Message, 'id' | 'authorId' | 'deletedAt'>[],
  unread: number,
  me: string,
): string | null {
  if (unread <= 0) return null;
  let left = unread;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.authorId === me || m.deletedAt || m.id.startsWith('msg_local-')) continue;
    left -= 1;
    if (left === 0) return messages[i - 1]?.id ?? null;
  }
  return null;
}

/* The message box ------------------------------------------------------------------------------------------------ */

/** The message box's least height cap: about five lines, as it always had. */
export const COMPOSER_MIN_CAP = 120;
/** Share of the screen's height a long message may grow the box to before it scrolls inside. */
export const COMPOSER_SCREEN_SHARE = 0.4;

/** The “+” line that opens the saved prompts, and what it does for a screen reader. */
export const PROMPTS_ADD = 'prompts';
export const PROMPTS_HINT = 'Opens your prompts';

/**
 * What a screen reader calls the message box's “+”, by what it offers: the paperclip's words when it has only files,
 * the prompts' when only those, both otherwise.
 */
export function plusLabel(ids: readonly string[]): string {
  const prompts = ids.includes(PROMPTS_ADD);
  const files = ids.some((id) => id !== PROMPTS_ADD);
  if (files && prompts) return 'Attach a photo or file, or use a prompt';
  return prompts ? PROMPT_WORDS.title : 'Attach a photo or file';
}

/** How tall the message box's text may grow on a screen `height` tall: 40 % of it, never under 120. */
export function composerMaxHeight(height: number): number {
  return Math.max(COMPOSER_MIN_CAP, Math.round(height * COMPOSER_SCREEN_SHARE));
}

/* A thread's root from the inbox --------------------------------------------------------------------------------- */

/**
 * A thread's first message as the inbox's cached list has it, shown while the thread loads: only when the list holds
 * its whole first line (a text cut at the list's limit would show cut) and it had no files. Undefined otherwise.
 */
export function threadPlaceholderFromList(
  lists: readonly ({ pages: readonly { threads: readonly ChatThread[] }[] } | undefined)[],
  rootId: string,
): ThreadView | undefined {
  for (const list of lists)
    for (const page of list?.pages ?? []) {
      const t = page.threads.find((x) => x.rootId === rootId);
      if (!t) continue;
      if (t.text.length >= CHAT_THREAD_TEXT_MAX || !t.text.trim()) return undefined;
      const root: Message = {
        id: t.rootId,
        conversationId: t.conversationId,
        authorId: t.authorId,
        createdAt: t.createdAt,
        editedAt: null,
        text: t.text,
        mentions: [],
        card: null,
        suggestions: [],
        more: null,
        attachments: [],
        reactions: [],
        threadRootId: null,
        replyCount: t.replyCount,
        lastReplyAt: t.replyCount > 0 ? t.lastAt : null,
        threadParticipantIds: [],
        clientId: null,
        subject: t.subject ?? null,
        settled: t.settled ?? null,
      };
      return { root, replies: [], conversationId: t.conversationId, where: '', topic: null, more: null };
    }
  return undefined;
}

/**
 * Whether a thread's messages on screen can place its “New” line and read it: not while they are the room's copy of its
 * root, nor while the thread is being read again. A copy from before (kept on the phone, or from before the connection
 * came back) can lack what is new, and the line would go above messages already read, and the read stop short of them.
 */
export function threadReadable(thread: { rootOnly: boolean; fetching: boolean }): boolean {
  return !thread.rootOnly && !thread.fetching;
}
