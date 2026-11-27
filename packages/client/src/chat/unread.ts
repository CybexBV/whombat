/**
 * Threads with something new in the person's Chat and Feedback rooms (Whombat thread-unread.md): the counts of
 * `chats.unread` by thread, and what a read does to them. Web and phone show a dot on such a thread and say “New
 * replies” to screen readers; the thread on screen never shows one, since it is being read.
 */
import type { ChatUnreadResponse } from '@whombat/core';
import { clientTree } from '../i18n/catalog';
import { CHAT_AREA_WORDS } from '../i18n/messages/chatWork/chat';

/** What a thread with something new says to screen readers (its dot shows it to everyone else), in a locale. */
export function threadNewLabel(locale?: string | null): string {
  return clientTree(locale, CHAT_AREA_WORDS).unread.newReplies;
}

/** What a thread with something new says to screen readers, in English. */
export const THREAD_NEW_LABEL = threadNewLabel();

const NONE: ReadonlyMap<string, number> = new Map();

/** Each listed thread's count of new messages, by its first message's id; empty before the first answer. */
export function threadUnreadCounts(data: ChatUnreadResponse | undefined): ReadonlyMap<string, number> {
  if (!data?.threads.length) return NONE;
  return new Map(data.threads.map((t) => [t.rootId, t.unread]));
}

/** The list once a thread was read to its end: the thread leaves it. */
export function withThreadRead(data: ChatUnreadResponse, rootId: string): ChatUnreadResponse {
  return data.threads.some((t) => t.rootId === rootId)
    ? { ...data, threads: data.threads.filter((t) => t.rootId !== rootId) }
    : data;
}

/** Whether a thread shows as new: it has something new and isn't the thread open on screen. */
export function threadShowsNew(
  counts: ReadonlyMap<string, number>,
  rootId: string,
  openRootId: string | null | undefined,
): boolean {
  return rootId !== openRootId && (counts.get(rootId) ?? 0) > 0;
}
