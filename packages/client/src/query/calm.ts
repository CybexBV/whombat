/**
 * Reads that many realtime frames ask to refetch at once (Home's overview: every turn of the assistant, every approval,
 * every widget's new points) are fetched at most once a window. The first frame refetches at once, so a single change
 * shows as fast as before; frames inside the window only mark the read out of date (a screen that opens meanwhile reads
 * it fresh) and one refetch follows at the end of the window. While a fetch is still on its way that one waits for it,
 * instead of cancelling it and starting over: on a slow connection a steady stream of frames would otherwise never
 * let an answer land.
 */
import type { QueryClient } from '@tanstack/query-core';
import { queryKeys } from './keys';

/** At most one refetch of a calm read per this long. */
export const CALM_REFETCH_MS = 1000;

interface Slot {
  /** When the last refetch was asked for. */
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CalmRefetches {
  slots: Map<string, Slot>;
  now: () => number;
  windowMs: number;
}

export function createCalmRefetches(now: () => number = Date.now, windowMs = CALM_REFETCH_MS): CalmRefetches {
  return { slots: new Map(), now, windowMs };
}

/** Invalidate every cached call of `endpointId`, refetching what is on screen at most once a window. */
export function invalidateCalmly(qc: QueryClient, calm: CalmRefetches, endpointId: string): void {
  const queryKey = queryKeys.scope(endpointId);
  let slot = calm.slots.get(endpointId);
  if (!slot) {
    slot = { last: Number.NEGATIVE_INFINITY, timer: null };
    calm.slots.set(endpointId, slot);
  }
  const now = calm.now();
  if (!slot.timer && now - slot.last >= calm.windowMs) {
    slot.last = now;
    void qc.invalidateQueries({ queryKey });
    return;
  }
  // Marked out of date only; the refetch comes at the end of the window.
  void qc.invalidateQueries({ queryKey, refetchType: 'none' });
  if (slot.timer) return;
  const s = slot;
  const fire = () => {
    // Still fetching: let that answer land, then read once more.
    if (qc.isFetching({ queryKey }) > 0) {
      s.timer = setTimeout(fire, calm.windowMs);
      return;
    }
    s.timer = null;
    s.last = calm.now();
    void qc.invalidateQueries({ queryKey });
  };
  s.timer = setTimeout(fire, Math.max(0, s.last + calm.windowMs - now));
}
