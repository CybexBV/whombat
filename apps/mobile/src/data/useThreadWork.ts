/**
 * Work in a channel's threads (docs/decisions/card-settle.md AP-735), for the reply rows: the burrow's live runs (the
 * cached `runs.list?status=live`, kept current by `run.updated`) and who thinks in which thread (the conversation's
 * typing entries, every thread). Runs without `threadRootId` (an older server) just don't show.
 */
import { hashKey, replaceEqualDeep, useQueryClient } from '@tanstack/react-query';
import { queryKeys, type TypingEntry } from '@whombat/client/query';
import { subscribeCacheEntry, useHandoffs, useRuns } from '@whombat/client/react';
import { type Handoff, TYPING_TTL_MS } from '@whombat/core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n';
import type { People } from './people';
import { liveTyping, type ThreadWorkView, threadWorkView } from './working';

const NO_TYPING: TypingEntry[] = [];
const NO_HANDOFFS: readonly Handoff[] = [];

/**
 * Every typing / thinking entry of a conversation, in all its threads (the `useTyping` cache, unfiltered). It listens to
 * its own cache entry through the client's shared hub, not to every change in the cache (AP-914), and the list stays the
 * same array until an entry comes, goes or expires, so the reply rows built from it don't re-render for nothing.
 */
function useConversationTyping(conversationId: string | null): TypingEntry[] {
  const qc = useQueryClient();
  const key = queryKeys.typing(conversationId ?? '-');
  const hash = hashKey(key);
  const subscribe = useCallback((cb: () => void) => subscribeCacheEntry(qc, hash, cb), [qc, hash]);
  const entries = useSyncExternalStore(
    subscribe,
    () => qc.getQueryData(key) ?? NO_TYPING,
    () => NO_TYPING,
  );
  // Entries expire unless refreshed: look again when the next one would.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (entries.length) setNow(Date.now());
  }, [entries]);
  const shown = useMemo(() => liveTyping(entries, now), [entries, now]);
  const next = Math.min(...shown.map((e) => e.expiresAt));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(next - Date.now(), TYPING_TTL_MS)) + 1,
    );
    return () => clearTimeout(timer);
  }, [next]);
  return conversationId ? shown : NO_TYPING;
}

/**
 * `(rootId) => what its reply row says about work in the thread`; nothing is asked for while `enabled` is false. A root
 * whose work reads the same gets the same object as before, so its memoised row doesn't re-render (AP-901).
 */
export function useThreadWork(
  slug: string,
  conversationId: string | null,
  enabled: boolean,
  people: People,
): (rootId: string) => ThreadWorkView | null {
  const { rawLocale } = useI18n();
  const runs = useRuns(enabled ? { params: { burrow: slug }, query: { status: 'live' } } : null);
  const typing = useConversationTyping(enabled ? conversationId : null);
  // What the agent handed to T3 Code from which thread (t3code-handoff.md AP-6611).
  const handoffs = useHandoffs(slug, conversationId, enabled);
  const live = runs.data?.runs;
  const shown = useRef(new Map<string, ThreadWorkView | null>());
  return useMemo(() => {
    const list = live ?? [];
    const byRoot = new Map<string, Handoff[]>();
    for (const h of handoffs) if (h.rootId) byRoot.set(h.rootId, [...(byRoot.get(h.rootId) ?? []), h]);
    return (rootId: string) => {
      const view = replaceEqualDeep(
        shown.current.get(rootId) ?? null,
        threadWorkView(rootId, list, typing, people, byRoot.get(rootId) ?? NO_HANDOFFS, rawLocale),
      );
      shown.current.set(rootId, view);
      return view;
    };
  }, [live, typing, people, handoffs, rawLocale]);
}
