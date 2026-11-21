/** A pull to refresh ends when its reads answer, or as soon as they wait to get online. */
import { onlineManager, QueryClient, QueryObserver } from '@tanstack/query-core';
import { afterEach, describe, expect, it } from 'vitest';
import { pullSettled, pullTargets } from './pullRefresh';

const KEY = ['whombat', 'chats.threads', { burrow: 'b' }, { room: 'chat', state: 'open' }, 'infinite'];
const SETTLED = ['whombat', 'chats.threads', { burrow: 'b' }, { room: 'chat', state: 'settled' }, 'infinite'];

afterEach(() => onlineManager.setOnline(true));

describe('a pull to refresh', () => {
  it('ends when its reads have answered', async () => {
    const qc = new QueryClient();
    let answer: (v: string) => void = () => {};
    const read = qc.fetchQuery({ queryKey: KEY, queryFn: () => new Promise<string>((r) => (answer = r)) });
    let ended = false;
    const pull = pullSettled(qc, [read], pullTargets(qc, { exact: [KEY] })).then(() => (ended = true));
    await Promise.resolve();
    expect(ended).toBe(false);
    answer('threads');
    await pull;
    expect(ended).toBe(true);
  });

  it('ends when a read fails', async () => {
    const qc = new QueryClient();
    const read = qc.fetchQuery({
      queryKey: KEY,
      queryFn: () => Promise.reject(new Error('no')),
      retry: false,
    });
    await pullSettled(qc, [read], pullTargets(qc, { exact: [KEY] }));
    expect(qc.getQueryState(KEY)?.status).toBe('error');
  });

  it('offline, ends at once while the read waits, and the read goes on once online', async () => {
    onlineManager.setOnline(false);
    const qc = new QueryClient();
    // Mounted, as the app's provider does: it then hears the phone get online.
    qc.mount();
    const read = qc.fetchQuery({ queryKey: KEY, queryFn: async () => 'threads' });
    await pullSettled(qc, [read], pullTargets(qc, { exact: [KEY] }));
    expect(qc.getQueryState(KEY)?.fetchStatus).toBe('paused');
    onlineManager.setOnline(true);
    await expect(read).resolves.toBe('threads');
    expect(qc.getQueryState(KEY)?.status).toBe('success');
    qc.unmount();
  });

  it('another list of the same kind left waiting doesn’t end it', async () => {
    const qc = new QueryClient();
    // The settled list went to wait while the phone was offline, and nothing woke it (the client isn't mounted).
    onlineManager.setOnline(false);
    void qc.fetchQuery({ queryKey: SETTLED, queryFn: async () => 'settled' }).catch(() => {});
    onlineManager.setOnline(true);
    expect(qc.getQueryState(SETTLED)?.fetchStatus).toBe('paused');
    let answer: (v: string) => void = () => {};
    const read = qc.fetchQuery({ queryKey: KEY, queryFn: () => new Promise<string>((r) => (answer = r)) });
    let ended = false;
    const pull = pullSettled(qc, [read], pullTargets(qc, { exact: [KEY] })).then(() => (ended = true));
    // Something changes in the cache meanwhile: the pull looks again, and still waits.
    qc.setQueryData(['whombat', 'chats.unread'], { threads: [] });
    await Promise.resolve();
    expect(ended).toBe(false);
    answer('threads');
    await pull;
    expect(ended).toBe(true);
  });

  it('asks for the exact list and the reads on screen under a key, not those off screen', () => {
    const qc = new QueryClient();
    const unread = (room: string) => ['whombat', 'chats.unread', { burrow: 'b' }, { room }];
    qc.setQueryData(unread('chat'), { threads: [] });
    qc.setQueryData(unread('feedback'), { threads: [] });
    qc.setQueryData(KEY, { pages: [] });
    const off = new QueryObserver(qc, {
      queryKey: unread('chat'),
      queryFn: async () => ({ threads: [] }),
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => {});
    const hashes = pullTargets(qc, { exact: [KEY, null], active: [['whombat', 'chats.unread']] });
    off();
    const cache = qc.getQueryCache();
    expect(hashes.sort()).toEqual(
      [cache.find({ queryKey: KEY })?.queryHash, cache.find({ queryKey: unread('chat') })?.queryHash].sort(),
    );
  });
});
