/**
 * Where a thread of Chat or Feedback stands, as its row in the room says it (docs/decisions/chat-threads-cards.md):
 * read only from the thread's own flags (`ChatThread.waiting`, `working`, `handedOver`, `settled`), never guessed from
 * its replies. Pure; web and phone share it.
 */
import type { ChatThread } from '@whombat/core';

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

/** The words of a thread's stage and of its replies row. */
export const THREAD_STAGE_WORDS = {
  waiting: 'Waiting for you',
  working: (assistant: string) => `${assistant} is working`,
  handedOver: 'Handed over',
  settled: 'Settled',
  /** A thread's first message nobody answered yet. */
  noReplies: 'No replies yet',
  /** The end of a replies row's name for screen readers. */
  open: 'open the thread',
} as const;

/** “Waiting for you”, “Neo is working”, “Handed over”, “Settled”. */
export function threadStageWord(stage: ThreadStage, assistant: string): string {
  return stage === 'working' ? THREAD_STAGE_WORDS.working(assistant) : THREAD_STAGE_WORDS[stage];
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
}): string {
  return [
    parts.replies,
    parts.unread ?? null,
    parts.stage ? threadStageWord(parts.stage, parts.assistant) : null,
    parts.text?.trim() || null,
    THREAD_STAGE_WORDS.open,
  ]
    .filter(Boolean)
    .join(', ');
}
