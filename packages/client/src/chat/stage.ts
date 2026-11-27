/**
 * Where a thread of Chat or Feedback stands, as its row in the room says it (docs/decisions/chat-threads-cards.md):
 * read only from the thread's own flags (`ChatThread.waiting`, `working`, `handedOver`, `settled`), never guessed from
 * its replies. Pure; web and phone share it.
 */
import type { ChatThread } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { CHAT_AREA_WORDS } from '../i18n/messages/chatWork/chat';

/** In the order one wins over another: what waits for the person first, a settled thread last. */
export const THREAD_STAGES = ['waiting', 'working', 'handedOver', 'settled'] as const;
export type ThreadStage = (typeof THREAD_STAGES)[number];

export type ThreadStageFlags = Partial<Pick<ChatThread, 'waiting' | 'working' | 'handedOver' | 'settled'>>;

/** The stage a thread's flags say, or null: an open thread with nothing going on (it is not Settled). */
export function threadStage(flags: ThreadStageFlags | null | undefined): ThreadStage | null {
  if (!flags) return null;
  if (flags.waiting) return 'waiting';
  if (flags.working) return 'working';
  if (flags.handedOver) return 'handedOver';
  if (flags.settled) return 'settled';
  return null;
}

/** The words of a thread's stage and of its replies row, in a locale (English when none). */
export function threadStageWords(locale?: string | null) {
  const w = clientTree(locale, CHAT_AREA_WORDS).stage;
  return {
    waiting: w.waiting,
    working: (assistant: string) => interpolate(w.working, { assistant }),
    handedOver: w.handedOver,
    settled: w.settled,
    /** A thread's first message nobody answered yet. */
    noReplies: w.noReplies,
    /** The end of a replies row's name for screen readers. */
    open: w.open,
  };
}

/** The words of a thread's stage and of its replies row, in English. */
export const THREAD_STAGE_WORDS = threadStageWords();

/** “Waiting for you”, “Neo is working”, “Handed over”, “Settled”. */
export function threadStageWord(stage: ThreadStage, assistant: string, locale?: string | null): string {
  const w = locale ? threadStageWords(locale) : THREAD_STAGE_WORDS;
  return stage === 'working' ? w.working(assistant) : w[stage];
}

/**
 * The replies row's name for screen readers, every fact once: “3 replies, Waiting for you, Why is pve-02 using so much
 * memory?, open the thread”; “No replies yet, Neo is working, …”. `replies` is the row's own words for its count.
 */
export function threadRowLabel(parts: {
  replies: string;
  stage: ThreadStage | null;
  assistant: string;
  /** The thread's first words, when the row stands for a thread whose question isn't read beside it. */
  text?: string | null;
  /** “New replies” where the unread marker says so (thread-unread.md TU-05). */
  unread?: string | null;
  /** The person's language (English when none). */
  locale?: string | null;
}): string {
  return [
    parts.replies,
    parts.unread ?? null,
    parts.stage ? threadStageWord(parts.stage, parts.assistant, parts.locale) : null,
    parts.text?.trim() || null,
    (parts.locale ? threadStageWords(parts.locale) : THREAD_STAGE_WORDS).open,
  ]
    .filter(Boolean)
    .join(', ');
}
