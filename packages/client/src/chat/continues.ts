/**
 * When a message reads as the next part of the one before (chat-polish.md AP-6144): the same author, moments later.
 * It then shows without its author's face, name and time on web and phone alike; a later one says them again, so a
 * reply that came after a pause shows when it came.
 */
import type { Message } from '@whombat/core';

/** The same author within this long reads as one message. */
export const CONTINUE_MS = 5 * 60_000;

/** Whether `m` continues the message before it (same author, moments later, neither deleted). */
export function continuesMessage(
  prev: Pick<Message, 'authorId' | 'createdAt' | 'deletedAt'> | null | undefined,
  m: Pick<Message, 'authorId' | 'createdAt' | 'deletedAt'>,
): boolean {
  if (!prev || prev.authorId !== m.authorId || prev.deletedAt || m.deletedAt) return false;
  const gap = Date.parse(m.createdAt) - Date.parse(prev.createdAt);
  return gap >= 0 && gap <= CONTINUE_MS;
}
