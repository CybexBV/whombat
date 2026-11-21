import { threadWorkLine, type WorkLine } from '@whombat/client';
import type { ChatThread, Handoff } from '@whombat/core';
import { useCallback, useMemo } from 'react';
import { useTicker } from '../messaging/useRoom';

/**
 * Each thread's work line (`threadWorkLine`), read again once a minute so its spoken minutes stay true. `threads` give
 * a council's or checklist's progress; `handoffs` are the conversation's, T3 Code's work from any thread.
 */
export function useWorkLines(
  threads: readonly ChatThread[],
  handoffs: readonly Handoff[],
): (rootId: string) => WorkLine | null {
  const minute = useTicker(true, 60_000);
  const lines = useMemo(() => {
    const byRoot = new Map<string, Handoff[]>();
    for (const h of handoffs) if (h.rootId) byRoot.set(h.rootId, [...(byRoot.get(h.rootId) ?? []), h]);
    const out = new Map<string, WorkLine>();
    const roots = new Set([...threads.map((t) => t.rootId), ...byRoot.keys()]);
    const work = new Map(threads.map((t) => [t.rootId, t]));
    for (const rootId of roots) {
      const line = threadWorkLine(work.get(rootId) ?? {}, byRoot.get(rootId) ?? [], minute);
      if (line) out.set(rootId, line);
    }
    return out;
  }, [threads, handoffs, minute]);
  return useCallback((rootId: string) => lines.get(rootId) ?? null, [lines]);
}
