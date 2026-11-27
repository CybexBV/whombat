import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ThreadWork, threadWork } from '@whombat/client';
import { cachedMe, queryKeys, type TypingEntry } from '@whombat/client/query';
import { useHandoffs, useRuns } from '@whombat/client/react';
import type { Handoff, Run } from '@whombat/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebI18n } from '../../i18n/provider';

const NO_RUNS: readonly Run[] = [];
const NO_HANDOFFS: readonly Handoff[] = [];
const NO_TYPING: readonly TypingEntry[] = [];

/**
 * Work in a conversation's threads for their reply rows (docs/decisions/card-settle.md AP-735): the burrow's live runs
 * (`runs.list?status=live`, kept current by `run.updated`; a run without `threadRootId`, from an older runtime, shows
 * nowhere), who is thinking in which thread (the conversation's typing entries, every thread) and what the agent handed
 * to T3 Code from which thread (`conversations.handoffs`, t3code-handoff.md AP-6611). Returns the lookup the message
 * list asks per root message.
 */
export function useThreadWork(
  burrow: string,
  conversationId: string | undefined,
): (rootId: string) => ThreadWork | null {
  const { tag: uiLocale } = useWebI18n();
  const qc = useQueryClient();
  const { data: runs } = useRuns(conversationId ? { params: { burrow }, query: { status: 'live' } } : null, {
    retry: false,
  });
  // Realtime-only state (no request): the entry the `typing` reducer writes, read for every thread at once.
  const { data: entries } = useQuery<TypingEntry[]>({
    queryKey: queryKeys.typing(conversationId ?? '-'),
    queryFn: skipToken,
  });
  const typing: readonly TypingEntry[] = entries ?? NO_TYPING;
  const [now, setNow] = useState(() => Date.now());
  // Entries are checked against the clock as this renders, so new ones count without a second render to read the time;
  // `now` moves only when the next one expires.
  const clock = Math.max(now, Date.now());
  const nextExpiry = Math.min(...typing.map((e) => e.expiresAt).filter((at) => at > clock));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [nextExpiry]);

  const me = cachedMe(qc);
  const live = runs?.runs ?? NO_RUNS;
  const thinking = useMemo(() => {
    const at = Math.max(now, Date.now());
    return typing.filter((e) => e.expiresAt > at && e.principalId !== me);
  }, [typing, now, me]);
  const handoffs = useHandoffs(burrow, conversationId);
  const byRoot = useMemo(() => {
    const map = new Map<string, Handoff[]>();
    for (const h of handoffs) if (h.rootId) map.set(h.rootId, [...(map.get(h.rootId) ?? []), h]);
    return map;
  }, [handoffs]);
  return useCallback(
    (rootId: string) => threadWork(rootId, live, thinking, byRoot.get(rootId) ?? NO_HANDOFFS, uiLocale),
    [live, thinking, byRoot, uiLocale],
  );
}
