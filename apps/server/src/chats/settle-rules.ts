/**
 * The rules of settling a thread of a person's Chat or Feedback room (docs/decisions/chat-settle.md): pure, so the
 * commands, the automatic round and the tests share them. `settle.ts` gathers what they read.
 */
import {
  type ChatPreferences,
  DEFAULT_CHAT_PREFERENCES,
  type Preferences,
  type ThreadSettle,
  type ThreadSettledHow,
} from '@whombat/core';
import { assistantCalled } from '../home/assistant-name';

const DAY_MS = 24 * 60 * 60_000;

/** The person's choices, the defaults where they made none. */
export function chatPreferencesOf(preferences: Partial<Preferences> | null | undefined): ChatPreferences {
  return preferences?.chat ?? DEFAULT_CHAT_PREFERENCES;
}

/** What keeps a thread from settling: the agent works on it, or something in it waits for the person. */
export interface ThreadBusy {
  working: boolean;
  waiting: boolean;
}

/** The refusal's words, or null when the thread may settle. Working is said first: it is what ends first. */
export function settleRefusal(busy: ThreadBusy, agentName: string | null | undefined): string | null {
  if (busy.working) return `${assistantCalled(agentName)} is still working on this.`;
  if (busy.waiting) return 'This thread waits for your answer.';
  return null;
}

/** What the automatic round knows about one open thread. */
export interface SettleCandidate extends ThreadBusy {
  /** Its last message's time (`coalesce(last_reply_at, created_at)` of its first message). */
  lastAt: Date;
  /** Opened again by hand, and no message since: the person's choice beats the timer. */
  keptOpen: boolean;
  /** A message of the thread is pinned: the person keeps it in view. */
  pinned: boolean;
  /** Something in it is new to the person (chat-inbox.md CIB-08): it stays until they have read it. Absent: false. */
  unread?: boolean;
  /** When the latest pull request of its runs merged or closed after the person's last message in it; null: none. */
  endedAt: Date | null;
}

/**
 * How the thread settles by itself now, or null. A merged or closed pull request wins over quiet days: it says better
 * why the thread is done, and its time is when the work ended.
 */
export function autoSettle(c: SettleCandidate, prefs: ChatPreferences, now: Date): ThreadSettle | null {
  if (c.working || c.waiting || c.keptOpen || c.pinned || c.unread) return null;
  if (prefs.settleMerged && c.endedAt) return settleOf('merged', c.endedAt);
  if (
    prefs.settleQuietDays !== null &&
    c.lastAt.getTime() <= quietCutoff(now, prefs.settleQuietDays).getTime()
  )
    return settleOf('quiet', c.lastAt);
  return null;
}

/** A thread whose last message is at or before this has been quiet for `days`. */
export function quietCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

function settleOf(how: ThreadSettledHow, at: Date): ThreadSettle {
  return { at: at.toISOString(), how };
}

/** `Message.settled` and `ChatThread.settled` from a first message's columns; null while the thread is open. */
export function threadSettleOf(row: {
  settledAt: Date | null;
  settledHow: ThreadSettledHow | null;
}): ThreadSettle | null {
  return row.settledAt && row.settledHow ? settleOf(row.settledHow, row.settledAt) : null;
}

/**
 * The Settled shelf pages by when threads settled, so threads settled together never share a moment: one that would
 * settle in the same millisecond as an earlier one in the list goes a millisecond before it.
 */
export function apartInTime<T extends { settle: ThreadSettle }>(settles: readonly T[]): T[] {
  const taken = new Set<number>();
  return settles.map((s) => {
    const at = Date.parse(s.settle.at);
    let t = at;
    while (taken.has(t)) t -= 1;
    taken.add(t);
    return t === at ? s : { ...s, settle: { ...s.settle, at: new Date(t).toISOString() } };
  });
}
