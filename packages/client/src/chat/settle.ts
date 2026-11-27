/**
 * Settling threads in Chat and Feedback (Whombat chat-settle.md CHS-01…CHS-12; contracts 3.8.0; app chat-settle.md
 * AP-6150…AP-6159, AP-6250…AP-6255): the words, what a settled thread's row says, the room without its settled threads
 * (they are in Settled) and what a settle or Open again does to a cached threads list. Pure; web and phone share it.
 */
import type { ChatThread, Message, ThreadSettle } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { formatUpdated } from '@whombat/core/text';
import { ApiError } from '../http/errors';
import { clientTree } from '../i18n/catalog';
import { CHAT_AREA_WORDS } from '../i18n/messages/chatWork/chat';
import { quietDaysWords } from './inbox';
import type { ThreadListScope } from './threads';

/** The words of settling (AP-6150…AP-6156), in a locale (English when none). */
export function settleWords(locale?: string | null) {
  const w = clientTree(locale, CHAT_AREA_WORDS).settle;
  return {
    settleThread: w.settleThread,
    settle: w.settle,
    openAgain: w.openAgain,
    /** The room head's button and the list of the room's settled threads it opens (AP-6250). */
    settled: w.settled,
    /** Beside a settled thread's time where it is shown in place. */
    settledTag: w.settledTag,
    /** That list with nothing in it. */
    noneSettled: w.noneSettled,
    settledToast: w.settledToast,
    undo: w.undo,
    /** Under a settled thread's reply box. */
    replyOpens: w.replyOpens,
    showMore: w.showMore,
    merged: w.merged,
    /** A thread where the assistant looked into a problem by itself, once the problem went away. */
    resolved: w.resolved,
    /** The sidebar's right-click menu of Chat and Feedback (AP-6155). */
    settleFinished: w.settleFinished,
    /** Feedback's entries in Chat's right-click menu (Feedback has no sidebar row of its own). */
    openFeedback: w.openFeedback,
    feedbackSettled: w.feedbackSettled,
    settleFinishedFeedback: w.settleFinishedFeedback,
    /** Settings → Profile → CHAT (AP-6156). */
    chat: w.chat,
    quiet: w.quiet,
    quietHint: w.quietHint,
    /** Plain words first; the hint names the pull request for the developer who connected GitHub. */
    mergedSwitch: w.mergedSwitch,
    mergedHint: w.mergedHint,
  };
}

/** The words of settling, in English. */
export const SETTLE_WORDS = settleWords();

/** The quiet days the Settings switch turns on (CHS-12: on = 3, off = never). */
export const SETTLE_QUIET_DAYS = 3;
/** How long the toast's Undo stays (AP-6151). */
export const SETTLE_UNDO_MS = 5000;
/** How many settled threads the Settled list shows at a time (AP-6153). */
export const SETTLED_PAGE = 10;

/** The note under Settings' CHAT switches (AP-6156). */
export function settleNote(agentName: string, locale?: string | null): string {
  return interpolate(clientTree(locale, CHAT_AREA_WORDS).settle.note, { agentName });
}

/** What Settle finished threads says when done (AP-6155). */
export function settleFinishedToast(n: number, locale?: string | null): string {
  const w = clientTree(locale, CHAT_AREA_WORDS).settle;
  if (n === 0) return w.nothingToSettle;
  return w.settledThreads(n);
}

/**
 * When a thread settled, after “Settled”: “2 hours ago”, “today”, “yesterday”, then “on Monday”, “last week”, “on 3
 * Mar” (core's `formatUpdated`, with “on” before a day or a date so the line reads as a sentence).
 */
export function settledWhen(
  at: string,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string {
  const when = formatUpdated(at, now, timeZone, locale);
  return /ago$|geleden$|^today$|^yesterday$|^just now$|^last week$|^vandaag$|^gisteren$|^zojuist$|^vorige week$/.test(
    when,
  )
    ? when
    : interpolate(clientTree(locale, CHAT_AREA_WORDS).settle.onWhen, { when });
}

/** “Settled 2 hours ago”: the line of a settled thread that is open (AP-6154) and a `person` row's meta. */
export function settledLine(
  at: string,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string {
  return interpolate(clientTree(locale, CHAT_AREA_WORDS).settle.settledLine, {
    when: settledWhen(at, now, timeZone, locale),
  });
}

/**
 * A settled row's line in Settled (AP-6153): “Settled yesterday” when the person settled it, “Settled by itself after 3
 * quiet days”, “Settled when its pull request merged”, “Settled when the problem went away”. `quietDays` is the person's choice (`Preferences.chat`); the
 * thread doesn't say how many days it waited, and a choice turned off since reads as the default.
 */
export function settledMeta(
  settled: ThreadSettle,
  now: Date | number,
  timeZone: string,
  quietDays: number | null,
  locale?: string | null,
): string {
  const w = clientTree(locale, CHAT_AREA_WORDS).settle;
  if (settled.how === 'quiet')
    return interpolate(w.byItself, { words: quietDaysWords(quietDays ?? SETTLE_QUIET_DAYS, locale) });
  if (settled.how === 'merged') return w.merged;
  if (settled.how === 'resolved') return w.resolved;
  return settledLine(settled.at, now, timeZone, locale);
}

/**
 * Why a settle or Open again didn't happen, as a toast (AP-6151): the server's own words when it refused (“Neo is still
 * working on this.”, “This thread waits for your answer.”, CHS-03), else a plain retry.
 */
export function settleRefusalText(outcome: unknown, settled: boolean, locale?: string | null): string {
  if (outcome instanceof ApiError && outcome.status < 500 && outcome.message) return outcome.message;
  if (outcome && typeof outcome === 'object' && 'status' in outcome) {
    const o = outcome as { status: unknown; message?: unknown };
    if (o.status === 'blocked' && typeof o.message === 'string' && o.message) return o.message;
  }
  const w = clientTree(locale, CHAT_AREA_WORDS).settle;
  return settled ? w.couldntSettle : w.couldntOpen;
}

/**
 * Whether a thread may be settled now: open, the assistant neither works on it nor waits for an answer (CHS-03), and no
 * work handed over from it goes on (T3 Code, a council, a delegation), which the server would refuse to settle.
 */
export function canSettle(
  t: Pick<ChatThread, 'working' | 'waiting' | 'settled' | 'handedOver'> | null | undefined,
): boolean {
  return !!t && !t.settled && !t.working && !t.waiting && !t.handedOver;
}

/* The room (AP-6251) ---------------------------------------------------------------------------------------------- */

type RootLike = Pick<Message, 'id' | 'threadRootId' | 'settled'>;

/** A settled thread's first message, which the room leaves to Settled; a message still being sent never is. */
export function isSettledRoot(m: RootLike): boolean {
  return !!m.settled && !m.threadRootId && !m.id.startsWith('msg_local-');
}

/**
 * The room without its settled threads (AP-6251): their first messages go, except `keep` (the thread a link or the open
 * thread points at, so it can be found). Replies stay. The same array when nothing is settled.
 */
export function withoutSettled<M extends RootLike>(
  messages: readonly M[],
  keep?: string | null,
): readonly M[] {
  if (!messages.some((m) => isSettledRoot(m) && m.id !== keep)) return messages;
  return messages.filter((m) => !isSettledRoot(m) || m.id === keep);
}

/**
 * Where the “New” line goes once settled threads are left out (AP-6251): above `unreadFrom` when it shows, else above
 * the first message after it that does; null when none does.
 */
export function shownUnreadFrom(
  all: readonly Pick<Message, 'id'>[],
  shown: readonly Pick<Message, 'id'>[],
  unreadFrom: string | null,
): string | null {
  if (!unreadFrom || all === shown) return unreadFrom;
  const at = all.findIndex((m) => m.id === unreadFrom);
  if (at < 0) return unreadFrom;
  const visible = new Set(shown.map((m) => m.id));
  return all.slice(at).find((m) => visible.has(m.id))?.id ?? null;
}

/** Whether a thread belongs in a list asked by subject (any thread does in a list that isn't). */
export function threadAbout(scope: ThreadListScope, t: Pick<ChatThread, 'subject'>): boolean {
  if (!scope.subjectKind && !scope.subjectId) return true;
  return (
    !!t.subject &&
    (!scope.subjectKind || t.subject.kind === scope.subjectKind) &&
    (!scope.subjectId || t.subject.id === scope.subjectId)
  );
}

/** Two settles are the same (both open, or the same time and way). */
export function sameThreadSettle(
  a: ThreadSettle | null | undefined,
  b: ThreadSettle | null | undefined,
): boolean {
  return (a ?? null) === (b ?? null) || (!!a && !!b && a.at === b.at && a.how === b.how);
}

/** Puts `t` among the loaded threads by `order` (newest first); past the last loaded one only when nothing is older. */
function placed(
  pages: readonly (readonly ChatThread[])[],
  t: ChatThread,
  order: (x: ChatThread) => number,
  complete: boolean,
): ChatThread[][] {
  const out = pages.map((p) => [...p]);
  const value = order(t);
  for (const page of out) {
    const at = page.findIndex((x) => order(x) < value);
    if (at >= 0) {
      page.splice(at, 0, t);
      return out;
    }
  }
  if (complete || !out.some((p) => p.length)) {
    if (!out.length) out.push([]);
    (out.at(-1) as ChatThread[]).push(t);
  }
  return out;
}

/**
 * A list's pages after a thread settled (`settled`) or opened again (null) (CHS-01, CHS-05, CHS-10): a list of every
 * thread changes the row in place; an `open` list loses a settled thread and takes one opened again by its last
 * activity; a `settled` list takes a settled one by when it settled and loses one opened again. `thread` is the
 * thread as known (from the server's answer or another list); `complete`: the list has no older page. The same
 * pages when nothing changes; null when the thread belongs in the list but isn't known (read the list again).
 */
export function threadPagesSettled(
  pages: readonly (readonly ChatThread[])[],
  change: { rootId: string; settled: ThreadSettle | null; thread?: ChatThread | null },
  scope: ThreadListScope,
  complete: boolean,
): ChatThread[][] | null {
  const { rootId, settled } = change;
  const listed = pages.flat().find((t) => t.rootId === rootId);
  const known = change.thread ?? listed ?? null;
  const without = () => pages.map((p) => p.filter((t) => t.rootId !== rootId));
  const state = scope.state ?? null;
  if (state === null) {
    if (!listed || sameThreadSettle(listed.settled, settled)) return pages as ChatThread[][];
    return pages.map((p) => p.map((t) => (t.rootId === rootId ? { ...t, settled } : t)));
  }
  const belongs = state === 'settled' ? !!settled : !settled;
  if (!belongs) return listed ? without() : (pages as ChatThread[][]);
  if (listed && sameThreadSettle(listed.settled, settled)) return pages as ChatThread[][];
  if (!known) return null;
  if (!threadAbout(scope, known)) return pages as ChatThread[][];
  const row: ChatThread = { ...known, settled };
  const order = (x: ChatThread) => Date.parse(state === 'settled' ? (x.settled?.at ?? x.lastAt) : x.lastAt);
  return placed(listed ? without() : pages, row, order, complete);
}

/** A first page's `settledCount` after `delta` (a thread settled: +1, opened again: −1); absent stays absent. */
export function withSettledCount<P extends { settledCount?: number }>(page: P, delta: number): P {
  if (page.settledCount === undefined || delta === 0) return page;
  return { ...page, settledCount: Math.max(0, page.settledCount + delta) };
}
