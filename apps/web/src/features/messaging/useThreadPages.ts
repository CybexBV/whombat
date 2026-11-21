/**
 * A thread in pages (docs/decisions/web-messages.md WX-11; contracts 0.55 CT-299, `messages.thread_paging`): the
 * newest `THREAD_PAGE` replies first, then each “Load earlier replies” one page further back (`before`: the oldest
 * reply loaded). Every page is its own cached `messages.thread` query, so realtime edits, reactions and removals reach
 * all of them; the replies are merged by id and time (the reducers add a new reply to every page of its thread). A
 * Whombat without paging answers every reply at once and no `more`, as before.
 */
import { useQueries } from '@tanstack/react-query';
import { useThread, useWhombat } from '@whombat/client/react';
import { api, type Message } from '@whombat/core';
import { useCallback, useMemo, useState } from 'react';

/** Replies per page. */
export const THREAD_PAGE = 50;
export const LOAD_EARLIER_REPLIES = 'Load earlier replies';

type ThreadData = NonNullable<ReturnType<typeof useThread>['data']>;

/** The replies of every page, once each (the newest copy), oldest first. */
export function mergeThreadPages(pages: readonly (ThreadData | undefined)[]): Message[] {
  const byId = new Map<string, { m: Message; order: number }>();
  let order = 0;
  // Oldest page first, so the newest page's copy of a reply wins.
  for (const page of pages) for (const m of page?.replies ?? []) byId.set(m.id, { m, order: order++ });
  return [...byId.values()]
    .sort((a, b) => a.m.createdAt.localeCompare(b.m.createdAt) || a.order - b.order)
    .map((x) => x.m);
}

export function useThreadPages(burrow: string, threadId: string) {
  const { queries } = useWhombat();
  const params = { burrow, messageId: threadId };
  const newest = useThread({ params, query: { limit: THREAD_PAGE } });
  // The `before` of each earlier page asked for, newest first.
  const [cursors, setCursors] = useState<string[]>([]);
  const earlier = useQueries({
    queries: cursors.map((before) => ({
      ...queries.endpoint(api.messages.thread, { params, query: { before, limit: THREAD_PAGE } }),
      staleTime: 30_000,
    })),
    // Re-run only when a page's answer changes, so the merged replies keep their identity otherwise.
    combine: (results) => ({
      data: results.map((r) => r.data as ThreadData | undefined),
      loading: results.some((r) => r.isPending),
    }),
  });
  const replies = useMemo(
    () => mergeThreadPages([...earlier.data].reverse().concat(newest.data)),
    [earlier.data, newest.data],
  );
  const oldest = cursors.length ? earlier.data.at(-1) : newest.data;
  const loadingEarlier = earlier.loading;
  const more = oldest?.more ?? null;
  const loadEarlier = useCallback(() => {
    if (!more || loadingEarlier) return;
    setCursors((c) => (c.includes(more.before) ? c : [...c, more.before]));
  }, [more, loadingEarlier]);
  return {
    data: newest.data,
    error: newest.error,
    refetch: newest.refetch,
    replies,
    /** Earlier replies exist (or are loading): the button shows. */
    more: loadingEarlier ? { before: '' } : more,
    loadingEarlier,
    loadEarlier,
  };
}
