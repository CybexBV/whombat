/**
 * A thread in pages (contracts 0.55, CT-299; MX-09): the thread opens with its newest `THREAD_PAGE_SIZE` replies, and
 * “Load earlier replies” under the root asks for the page before the oldest one shown (`more.before`), as often as
 * there are more.
 * Pure: the screen keeps the newest page and the earlier ones as separate cached queries (realtime keeps each current);
 * `threadMessages` puts them together. A message whose card moved down the thread links to it (`movedCardLinks`).
 */
import { earlierCardLine, movedCardLink } from '@whombat/client';
import type { Message, MessagePage, ThreadView } from '@whombat/core';

/** Replies per page: the newest ones open the thread. */
export const THREAD_PAGE_SIZE = 50;

export const LOAD_EARLIER_REPLIES = 'Load earlier replies';

/** `messages.thread`'s query: the newest page, or the page before `before`. */
export function threadQuery(before?: string): { limit: number; before?: string } {
  return before ? { before, limit: THREAD_PAGE_SIZE } : { limit: THREAD_PAGE_SIZE };
}

/**
 * The thread as one list (root, then replies oldest first, each once) and where earlier replies start (null: none
 * before these). `earlier` are the pages loaded by “Load earlier replies”, in the order they were loaded (each one
 * further back); one still loading (undefined) ends what is known.
 */
export function threadMessages(
  newest: ThreadView | undefined,
  earlier: readonly (ThreadView | undefined)[],
): { messages: Message[]; more: { before: string } | null } {
  if (!newest) return { messages: [], more: null };
  const pages: ThreadView[] = [newest];
  for (const page of earlier) {
    if (!page) break;
    pages.push(page);
  }
  const seen = new Set<string>([newest.root.id]);
  const replies: Message[] = [];
  // A reply that arrives live lands in every cached page: keep it once, and order by time.
  for (const page of [...pages].reverse())
    for (const r of page.replies) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      replies.push(r);
    }
  replies.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const oldest = pages.at(-1);
  // While an earlier page is on its way, nothing more is offered.
  const loading = earlier.length > pages.length - 1;
  return { messages: [newest.root, ...replies], more: loading ? null : (oldest?.more ?? null) };
}

/**
 * What a thread shows while its replies load: its root as the room already has it (in a `messages.list` page), no
 * replies yet. The room's row is the same message, so a thread opens on its question instead of grey rows; nothing is
 * offered before the answer says there is more. Undefined when no room page has it.
 */
export function threadPlaceholder(
  lists: readonly ({ pages: readonly MessagePage[] } | undefined)[],
  rootId: string,
): ThreadView | undefined {
  for (const list of lists)
    for (const page of list?.pages ?? []) {
      const root = page.messages.find((m) => m.id === rootId);
      if (root)
        return { root, replies: [], conversationId: root.conversationId, where: '', topic: null, more: null };
    }
  return undefined;
}

/** The quiet link under a message whose card moved on: its words, and the message that holds the card now. */
export interface MovedCardLink {
  label: string;
  targetId: string;
  /** Its card as it was, folded: the line naming it within the thread (a council by its title when there are two). */
  earlierLine?: string | null;
}

const NO_LINKS: ReadonlyMap<string, MovedCardLink> = new Map();

/**
 * The links under a thread's messages whose council or Tasks card moved to its end with its news (Whombat
 * card-moves.md CM-07), by message id: “Tick what you want” above points at the card there. `messages` is the thread
 * as loaded; a card not in it gets no link.
 */
export function movedCardLinks(messages: readonly Message[]): ReadonlyMap<string, MovedCardLink> {
  let links: Map<string, MovedCardLink> | null = null;
  for (const m of messages) {
    const link = m.movedCard ? movedCardLink(m, messages) : null;
    if (!link) continue;
    links ??= new Map();
    links.set(m.id, m.earlierCard ? { ...link, earlierLine: earlierCardLine(m, messages) } : link);
  }
  return links ?? NO_LINKS;
}
