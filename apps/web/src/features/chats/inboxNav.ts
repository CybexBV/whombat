/**
 * Chat and Feedback as an inbox (Whombat chat-inbox.md): whether the list sits beside the open thread, and the list's
 * order as shown, so the open thread's own Settle can open the thread under it. The thread lives in the shell's pane,
 * not under the room's screen, so the order is handed over here rather than through props.
 */

import { nextRootAfter } from '@whombat/client';
import type { ChatRoom } from '@whombat/core';
import { useEffect, useState } from 'react';

/**
 * Wide enough for the list and the thread side by side: the shell's own pane breakpoint, where the main column is
 * about 1000px. Keep in sync with `.main[data-beside]` in ShellLayout.module.css.
 */
export const INBOX_SPLIT_MEDIA = '(min-width: 1240px)';

/** The list column's width beside the open thread. Keep in sync with ChatRoomScreen.module.css and ShellLayout's. */
export const INBOX_LIST_WIDTH = 392;

const splitQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(INBOX_SPLIT_MEDIA)
    : null;

/** True while the window is wide enough for the list beside the open thread; false where nothing can tell (tests). */
export function useInboxSplit(): boolean {
  const [split, setSplit] = useState(() => splitQuery()?.matches ?? false);
  useEffect(() => {
    const query = splitQuery();
    if (!query) return;
    const change = () => setSplit(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return split;
}

const shown = new Map<ChatRoom, readonly string[]>();

/** The room's rows as the list shows them now (its filter applied), newest first. */
export function setInboxOrder(room: ChatRoom, rootIds: readonly string[]): void {
  shown.set(room, rootIds);
}

/** The thread to open once `rootId` is settled from its own head: the one under it in the list, else above; or null. */
export function inboxNextAfter(room: ChatRoom, rootId: string): string | null {
  return nextRootAfter(
    (shown.get(room) ?? []).map((id) => ({ rootId: id })),
    rootId,
  );
}
