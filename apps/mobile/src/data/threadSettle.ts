/**
 * Settling threads on the phone (Whombat chat-settle.md CHS-01…CHS-12; app chat-settle.md AP-6150…AP-6159, the phone's
 * AP-6157, AP-6250…AP-6255): the words, a settled thread's line (“Settled yesterday”), what a thread offers (Settle, Open
 * again or nothing while the assistant works on it, it waits for the person or work handed over from it goes on), Chat
 * and Feedback without their settled
 * threads (they are in Settled), the two switches of Profile's CHAT, and what a settle does to the cached messages and
 * thread lists (at once, put back when refused, and from `chat.settled`). Pure; the screens are `SettledScreen`,
 * `ChatView` and `ThreadScreen`, the writes `useThreadSettle.ts`.
 */
import type { InfiniteData } from '@tanstack/query-core';
import { type AgentWords, canSettle, quietDaysWords } from '@whombat/client';
import {
  type ChatPreferences,
  type ChatThread,
  type ChatThreadsResponse,
  DEFAULT_CHAT_PREFERENCES,
  formatUpdated,
  type Message,
  type Preferences,
  type ThreadSettle,
} from '@whombat/core';
import type { ChatItem } from './messages';

/** The words (verbatim, AP-6150…AP-6157); `{Agent}` is the assistant's name. */
export const SETTLE_COPY = {
  /** The thread header's button. */
  settle: 'Settle',
  /** A thread's swipe in Chat and Feedback. */
  swipe: 'Settle',
  /** The ⋯ panel beside it, and beside Settled's Open again. */
  more: 'More',
  /** The long-press menu's item and what TalkBack calls the swipe. */
  settleThread: 'Settle',
  openAgain: 'Open again',
  /** The toast with Undo (AP-6151). */
  settled: 'Settled.',
  /** Under a settled thread's reply box (AP-6154). */
  replyOpens: 'A reply opens it again.',
  /** After the time of a settled thread's first message still in its room (the one a link opens at, AP-6251). */
  mark: 'Settled',
  showMore: 'Show more',
  /** Profile → CHAT (AP-6156); when threads settle by themselves is `INBOX_WORDS.quietChoice`. */
  chat: 'CHAT',
  merged: 'Settle when its code is merged',
  mergedHint: 'When the pull request a thread asked for is merged on GitHub',
  note: (w: Pick<AgentWords, 'Name'>) =>
    `Never while ${w.Name} is still working on it or waiting for your answer. A new message opens a thread again.`,
  /** TalkBack's hints. */
  settleHint: 'Puts this thread in Settled. A new message brings it back.',
  openAgainHint: 'Brings this thread back to the room',
} as const;

/** The quiet days a settle by itself is told in when the person's choice is Never now (the default's). */
export const QUIET_DAYS_ON = 3;

/** The words for “Settled {when}”: `2 hours ago`, `yesterday`, `Monday`, `3 Mar`. */
export function settledWhen(settled: ThreadSettle, now: Date | number, timeZone: string): string {
  return `Settled ${formatUpdated(settled.at, now, timeZone)}`;
}

/**
 * A settled row's line in Settled (AP-6153): “Settled {when}” for one the person settled, “Settled by itself after 3
 * quiet days”, “Settled when its pull request merged” and “Settled when the problem went away” for the automatic
 * ones. A quiet one counts the days the
 * person's choice says now (the settle itself doesn't carry them; the switch only ever sets 3).
 */
export function settledRowLine(
  settled: ThreadSettle,
  now: Date | number,
  timeZone: string,
  quietDays: number | null = DEFAULT_CHAT_PREFERENCES.settleQuietDays,
): string {
  switch (settled.how) {
    case 'person':
      return settledWhen(settled, now, timeZone);
    case 'quiet':
      return `Settled by itself ${quietDaysWords(quietDays ?? QUIET_DAYS_ON)}`;
    case 'merged':
      return 'Settled when its pull request merged';
    case 'resolved':
      return 'Settled when the problem went away';
  }
}

/* What a thread offers ------------------------------------------------------------------------------------------- */

export type SettleOffer = 'settle' | 'open_again' | null;

/**
 * Settle on an open thread, Open again on a settled one, nothing while the assistant works on it, something in it waits
 * for the person or work handed over from it goes on (a T3 Code thread, a council, a delegation; Whombat
 * delegate.md): the swipe, the long press and the thread's header all ask this, and it asks the shared
 * `canSettle`, so the phone offers Settle where the web does and the server takes it.
 */
export function settleOffer(thread: {
  settled?: ThreadSettle | null;
  working?: boolean;
  waiting?: boolean;
  handedOver?: boolean;
}): SettleOffer {
  if (thread.settled) return 'open_again';
  const open = {
    settled: null,
    working: !!thread.working,
    waiting: !!thread.waiting,
    handedOver: !!thread.handedOver,
  };
  return canSettle(open) ? 'settle' : null;
}

/* Settled and the room ------------------------------------------------------------------------------------------ */

/** Settled's rows: settled threads only, the latest settled first (CHS-10), whatever a cached list still holds. */
export function settledShelf(threads: readonly ChatThread[]): (ChatThread & { settled: ThreadSettle })[] {
  return threads
    .filter((t): t is ChatThread & { settled: ThreadSettle } => !!t.settled)
    .sort((a, b) => Date.parse(b.settled.at) - Date.parse(a.settled.at));
}

/**
 * The room's items without its settled threads (AP-6251): they are in Settled. A left-out thread's day divider goes to
 * the next item of its day, and its “New” line to the next item shown; the one a link opens at (`keep`) stays, marked.
 */
export function withoutSettledItems(items: readonly ChatItem[], keep: string | null = null): ChatItem[] {
  if (!items.some((i) => i.settled && i.id !== keep)) return items as ChatItem[];
  const out: ChatItem[] = [];
  let day: string | null = null;
  let unread = false;
  for (const item of items) {
    // A day of only settled threads leaves no divider behind.
    if (item.day) day = null;
    if (item.settled && item.id !== keep) {
      day = item.day ?? day;
      unread ||= item.unread;
      continue;
    }
    out.push(day || unread ? { ...item, day: item.day ?? day, unread: item.unread || unread } : item);
    day = null;
    unread = false;
  }
  return out;
}

/* Profile → CHAT ----------------------------------------------------------------------------------------------- */

/** The person's choices, the defaults when none are stored (CHS-06). */
export function chatPreferencesOf(preferences: Pick<Preferences, 'chat'> | undefined): ChatPreferences {
  return preferences?.chat ?? DEFAULT_CHAT_PREFERENCES;
}

/** The merged pull request switch turned: the whole `chat` to save (`me.updatePreferences` replaces it whole). */
export function withMergedSwitch(p: ChatPreferences, on: boolean): ChatPreferences {
  return { ...p, settleMerged: on };
}

/** When threads settle by themselves, chosen: after so many quiet days, or never (null). */
export function withQuietDays(p: ChatPreferences, days: number | null): ChatPreferences {
  return { ...p, settleQuietDays: days };
}

/* The cache ---------------------------------------------------------------------------------------------------- */

function sameSettle(a: ThreadSettle | null | undefined, b: ThreadSettle | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.at === b.at && a.how === b.how;
}

/** A message as it reads once its thread settled or opened again: only the thread's first message carries it. */
export function messageWithSettle(m: Message, rootId: string, settled: ThreadSettle | null): Message {
  if (m.id !== rootId || sameSettle(m.settled, settled)) return m;
  return { ...m, settled };
}

/** Which threads a cached list holds (`chats.threads`' `state`): all of them, the open ones or the settled ones. */
export type ThreadListState = 'open' | 'settled' | undefined;

export interface SettleChange {
  rootId: string;
  /** The thread's settle now; null: open again. */
  settled: ThreadSettle | null;
  /** The thread as a list would show it, to put into a list that doesn't have it yet; absent: that list is read again. */
  thread?: ChatThread | null;
  /** How the shelf's count moves: +1 settled, −1 opened again, 0 when unknown or unchanged. */
  delta: -1 | 0 | 1;
}

/** Puts `t` into newest-first pages by `order`, in the page whose span holds it; returns null when none does. */
function insertSorted(
  pages: readonly ChatThread[][],
  t: ChatThread,
  order: (x: ChatThread) => number,
  last: boolean,
): ChatThread[][] | null {
  const key = order(t);
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] as ChatThread[];
    const end = page.at(-1);
    // A later page starts where this one ends: the thread belongs here when it is newer than this page's last one, or
    // this is the last page and nothing older is still to come.
    if (end && order(end) > key && !(i === pages.length - 1 && last)) continue;
    const at = page.findIndex((x) => order(x) < key);
    const next = [...page];
    next.splice(at < 0 ? page.length : at, 0, t);
    return pages.map((p, n) => (n === i ? next : p));
  }
  return null;
}

/**
 * A cached `chats.threads` list after a settle or Open again (AP-6158): a list of every thread marks the row; the open
 * list drops a settled thread and takes one opened again where its last activity puts it; the shelf takes a settled
 * one at the top (latest settled first) and drops one opened again. The shelf's count follows `delta` on a first page
 * that has it. Null when the list can't be made right here (a thread to add that isn't known): read it again.
 */
export function threadsWithSettle(
  data: InfiniteData<ChatThreadsResponse>,
  state: ThreadListState,
  change: SettleChange,
): InfiniteData<ChatThreadsResponse> | null {
  const { rootId, settled } = change;
  const pages = data.pages.map((p) => p.threads);
  const has = pages.some((p) => p.some((t) => t.rootId === rootId));
  const mark = (t: ChatThread) =>
    t.rootId === rootId && !sameSettle(t.settled, settled) ? { ...t, settled } : t;
  let next: ChatThread[][] | null = pages;
  const keep = state === undefined || (state === 'open' ? !settled : !!settled);
  if (!keep) next = has ? pages.map((p) => p.filter((t) => t.rootId !== rootId)) : pages;
  else if (has) next = pages.map((p) => p.map(mark));
  else if (state !== undefined && change.thread) {
    const row = { ...change.thread, settled };
    const last = data.pages.at(-1)?.next == null;
    next =
      state === 'open'
        ? insertSorted(pages, row, (x) => Date.parse(x.lastAt), last)
        : [[row, ...(pages[0] ?? [])], ...pages.slice(1)];
  } else if (state !== undefined) next = null;
  if (next === null) return null;
  const counted = change.delta !== 0 && data.pages[0]?.settledCount !== undefined;
  if (next.every((p, i) => p === pages[i]) && !counted) return data;
  return {
    ...data,
    pages: data.pages.map((p, i) => ({
      ...p,
      threads: next[i] ?? [],
      ...(i === 0 && counted && p.settledCount !== undefined
        ? { settledCount: Math.max(0, p.settledCount + change.delta) }
        : {}),
    })),
  };
}
