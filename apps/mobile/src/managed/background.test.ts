/** The appliance connection while the app is away (AP-925, AP-926). */
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import type { ResyncSignal } from '@whombat/client';
import { patchEndpoint } from '@whombat/client/query';
import type { ConnectionState } from '@whombat/client/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_GRACE_MS,
  BUSY_RETRY_MS,
  createBackgroundRelease,
  createFreshness,
  FAILED_READ_RETRY_MS,
  failedReadDue,
  QUIET_READ_MS,
  retryFailedReads,
} from './background';

const OPEN = { status: 'open', info: {} } as unknown as ConnectionState;

function fakeSession(busy = () => false) {
  let state: ConnectionState = OPEN;
  const listeners = new Set<(s: ConnectionState) => void>();
  const set = (next: ConnectionState) => {
    state = next;
    for (const l of [...listeners]) l(next);
  };
  const session = {
    state: () => state,
    onState(l: (s: ConnectionState) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    connect: vi.fn(() => set({ status: 'connecting', attempt: 0 })),
    reconnectNow: vi.fn(),
    suspend: vi.fn(() => {
      if (busy()) return false;
      set({ status: 'idle' });
      return true;
    }),
  };
  return { session, set };
}

/** Lets the release's `keep()` answer. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('the connection in the background (AP-925)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is let go after the grace, and opens at once back in the foreground', async () => {
    const { session } = fakeSession();
    const release = createBackgroundRelease({ session, keep: async () => false });
    release.background();
    await vi.advanceTimersByTimeAsync(BACKGROUND_GRACE_MS - 1);
    expect(session.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(session.state()).toEqual({ status: 'idle' });
    release.foreground();
    expect(session.connect).toHaveBeenCalledTimes(1);
    release.dispose();
  });

  it('a quick look at another app keeps it', async () => {
    const { session } = fakeSession();
    const release = createBackgroundRelease({ session, keep: async () => false });
    release.background();
    await vi.advanceTimersByTimeAsync(30_000);
    release.foreground();
    await vi.advanceTimersByTimeAsync(BACKGROUND_GRACE_MS);
    expect(session.suspend).not.toHaveBeenCalled();
    // Still open: nothing to reconnect.
    expect(session.connect).not.toHaveBeenCalled();
    expect(session.reconnectNow).not.toHaveBeenCalled();
    release.dispose();
  });

  it('keeps it while a live activity is on screen or work is under way, and asks again', async () => {
    let live = true;
    let busy = true;
    const { session } = fakeSession(() => busy);
    const release = createBackgroundRelease({ session, keep: async () => live });
    release.background();
    await vi.advanceTimersByTimeAsync(BACKGROUND_GRACE_MS);
    await settle();
    expect(session.suspend).not.toHaveBeenCalled();
    live = false;
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
    await settle();
    expect(session.suspend).toHaveBeenCalledTimes(1);
    expect(session.state().status).toBe('open');
    busy = false;
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
    await settle();
    expect(session.state()).toEqual({ status: 'idle' });
    release.dispose();
  });

  it('opened again while away (a push needed it), it goes again after the grace', async () => {
    const { session, set } = fakeSession();
    const release = createBackgroundRelease({ session, keep: async () => false });
    release.background();
    await vi.advanceTimersByTimeAsync(BACKGROUND_GRACE_MS);
    await settle();
    expect(session.suspend).toHaveBeenCalledTimes(1);
    set(OPEN);
    await vi.advanceTimersByTimeAsync(BACKGROUND_GRACE_MS);
    await settle();
    expect(session.suspend).toHaveBeenCalledTimes(2);
    expect(session.state()).toEqual({ status: 'idle' });
    release.dispose();
  });

  it('back in the foreground while reconnecting: no backoff wait', () => {
    const { session, set } = fakeSession();
    const release = createBackgroundRelease({ session, keep: async () => false });
    release.background();
    set({ status: 'reconnecting', attempt: 3, reason: 'offline', retryAt: 0 });
    release.foreground();
    expect(session.reconnectNow).toHaveBeenCalledTimes(1);
    expect(session.connect).not.toHaveBeenCalled();
    release.dispose();
  });

  it('a session that ended stays ended', () => {
    const { session, set } = fakeSession();
    const release = createBackgroundRelease({ session, keep: async () => false });
    set({ status: 'closed', reason: 'revoked' });
    release.foreground();
    expect(session.connect).not.toHaveBeenCalled();
    release.dispose();
  });
});

describe('refetching on coming back', () => {
  function fakeRealtime() {
    const listeners = new Set<(signal: ResyncSignal) => void>();
    return {
      onResync(l: (signal: ResyncSignal) => void) {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      resync: () => {
        for (const l of [...listeners]) l({ reason: 'reconnect', topics: ['me:prn_1'] });
      },
    };
  }

  it('nothing after a stay in the background whose live updates resumed', () => {
    const { session, set } = fakeSession();
    const realtime = fakeRealtime();
    const fresh = createFreshness(session, realtime, () => 300);
    // Let go in the background, and on coming back not open yet: the subscription will say.
    set({ status: 'idle' });
    expect(fresh.missed(50)).toBe(false);
    set({ status: 'connecting', attempt: 0 });
    expect(fresh.missed(50)).toBe(false);
    set(OPEN);
    expect(fresh.missed(50)).toBe(false);
    fresh.dispose();
  });

  it('reads answered before the live updates came back without resuming', () => {
    let t = 100;
    const { session, set } = fakeSession();
    const realtime = fakeRealtime();
    const fresh = createFreshness(session, realtime, () => t);
    t = 200;
    realtime.resync();
    expect(fresh.missed(150)).toBe(true);
    expect(fresh.missed(250)).toBe(false);
    // Down again: wait for the subscription's answer rather than asking now.
    set({ status: 'connecting', attempt: 1 });
    expect(fresh.missed(150)).toBe(false);
    fresh.dispose();
    t = 300;
    realtime.resync();
    set(OPEN);
    expect(fresh.missed(250)).toBe(false);
  });

  it('a read nothing changed for a while, even when the live updates kept up', () => {
    let t = 1_000;
    const { session, set } = fakeSession();
    const fresh = createFreshness(session, fakeRealtime(), () => t);
    t += QUIET_READ_MS;
    expect(fresh.missed(1_000)).toBe(false);
    t += 1;
    expect(fresh.missed(1_000)).toBe(true);
    // Asked while not open too: it waits for the connection.
    set({ status: 'connecting', attempt: 0 });
    expect(fresh.missed(1_000)).toBe(true);
    expect(fresh.missed(t - 10)).toBe(false);
    fresh.dispose();
  });
});

describe('a read that failed', () => {
  const failed = (error: unknown, errorUpdatedAt = 0, fetchStatus = 'idle') => ({
    state: { status: 'error', error, errorUpdatedAt, fetchStatus },
  });

  it('is due 30 s after it failed, unless the box said no or it is being asked', () => {
    const now = FAILED_READ_RETRY_MS;
    expect(
      failedReadDue(
        { state: { status: 'success', error: null, errorUpdatedAt: 0, fetchStatus: 'idle' } },
        now,
      ),
    ).toBe(false);
    expect(failedReadDue(failed(new Error('timed out')), now)).toBe(true);
    expect(failedReadDue(failed(new Error('timed out'), 1), now)).toBe(false);
    expect(failedReadDue(failed({ status: 503 }), now)).toBe(true);
    expect(failedReadDue(failed({ status: 429 }), now)).toBe(true);
    expect(failedReadDue(failed({ status: 404 }), now)).toBe(false);
    expect(failedReadDue(failed({ status: 403 }), now)).toBe(false);
    expect(failedReadDue(failed(new Error('timed out'), 0, 'fetching'), now)).toBe(false);
  });

  it('is asked again while live updates keep changing it, on screen and in the foreground only', async () => {
    vi.useFakeTimers();
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const key = ['whombat', 'runs.log', { burrow: 'hq', number: 1 }, {}];
      let calls = 0;
      let fail = true;
      const queryFn = async () => {
        calls++;
        if (fail) throw new Error('timed out');
        return { lines: calls };
      };
      qc.setQueryData(key, { lines: 0 });
      const off = new QueryObserver(qc, { queryKey: key, queryFn, staleTime: Infinity }).subscribe(() => {});
      await qc.refetchQueries({ queryKey: key }).catch(() => {});
      expect(qc.getQueryState(key)?.status).toBe('error');
      let foreground = true;
      const stop = retryFailedReads(qc, { foreground: () => foreground });
      // A live line every second: TanStack's own interval would start over each time and never come.
      const lines = setInterval(
        () => patchEndpoint<{ lines: number }>(qc, 'runs.log', (d) => ({ lines: d.lines + 1 })),
        1_000,
      );
      fail = false;
      foreground = false;
      await vi.advanceTimersByTimeAsync(40_000);
      expect(calls).toBe(1);
      foreground = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(2);
      expect(qc.getQueryState(key)?.status).toBe('success');
      clearInterval(lines);
      stop();
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});
