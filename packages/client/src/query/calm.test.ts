import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { api } from '@whombat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalmRefetches, invalidateCalmly } from './calm';
import { endpointKey } from './keys';

const key = endpointKey(api.home.overview, { params: { burrow: 'acme' } });

/** A client with the overview on screen (an observer) whose fetches are counted and answer after `answerMs`. */
function onScreen(answerMs = 0) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } });
  let fetches = 0;
  const observer = new QueryObserver(qc, {
    queryKey: key,
    queryFn: async () => {
      fetches += 1;
      if (answerMs) await new Promise((ok) => setTimeout(ok, answerMs));
      return { n: fetches };
    },
  });
  const off = observer.subscribe(() => {});
  return { qc, fetches: () => fetches, off };
}

describe('invalidateCalmly', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches the first change at once, then once at the end of the window for a burst', async () => {
    const { qc, fetches, off } = onScreen();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches()).toBe(1);
    const calm = createCalmRefetches(Date.now, 1000);
    invalidateCalmly(qc, calm, 'home.overview');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches()).toBe(2);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100);
      invalidateCalmly(qc, calm, 'home.overview');
    }
    // Marked out of date at once (a screen that opens now reads it fresh), fetched later.
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect(fetches()).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetches()).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetches()).toBe(3);
    off();
  });

  it('lets a slow answer land before reading again', async () => {
    const { qc, fetches, off } = onScreen(1500);
    await vi.advanceTimersByTimeAsync(1500);
    const calm = createCalmRefetches(Date.now, 1000);
    invalidateCalmly(qc, calm, 'home.overview');
    await vi.advanceTimersByTimeAsync(200);
    invalidateCalmly(qc, calm, 'home.overview');
    expect(fetches()).toBe(2);
    // The window ends while the first refetch is still on its way: it isn't cancelled.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetches()).toBe(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetches()).toBe(3);
    expect(qc.getQueryData(key)).toEqual({ n: 2 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(qc.getQueryData(key)).toEqual({ n: 3 });
    off();
  });

  it('refetches at once again after a quiet window', async () => {
    const { qc, fetches, off } = onScreen();
    await vi.advanceTimersByTimeAsync(0);
    const calm = createCalmRefetches(Date.now, 1000);
    invalidateCalmly(qc, calm, 'home.overview');
    await vi.advanceTimersByTimeAsync(1200);
    invalidateCalmly(qc, calm, 'home.overview');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches()).toBe(3);
    off();
  });
});
