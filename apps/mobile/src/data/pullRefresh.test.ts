/** A pull to refresh ends when its reads answer, or as soon as they wait to get online. */
import { onlineManager, QueryClient } from '@tanstack/query-core';
import { afterEach, describe, expect, it } from 'vitest';
import { pullSettled } from './pullRefresh';

const KEY = ['whombat', 'chats.threads', { burrow: 'b' }, { room: 'chat', state: 'open' }, 'infinite'];
const watched = [{ queryKey: ['whombat', 'chats.threads'] }];

afterEach(() => onlineManager.setOnline(true));

describe('a pull to refresh', () => {
  it('ends when its reads have answered', async () => {
    const qc = new QueryClient();
    let answer: (v: string) => void = () => {};
    const read = qc.fetchQuery({ queryKey: KEY, queryFn: () => new Promise<string>((r) => (answer = r)) });
    let ended = false;
    const pull = pullSettled(qc, [read], watched).then(() => (ended = true));
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
    await pullSettled(qc, [read], watched);
    expect(qc.getQueryState(KEY)?.status).toBe('error');
  });

  it('offline, ends at once while the read waits, and the read goes on once online', async () => {
    onlineManager.setOnline(false);
    const qc = new QueryClient();
    // Mounted, as the app's provider does: it then hears the phone get online.
    qc.mount();
    const read = qc.fetchQuery({ queryKey: KEY, queryFn: async () => 'threads' });
    await pullSettled(qc, [read], watched);
    expect(qc.getQueryState(KEY)?.fetchStatus).toBe('paused');
    onlineManager.setOnline(true);
    await expect(read).resolves.toBe('threads');
    expect(qc.getQueryState(KEY)?.status).toBe('success');
    qc.unmount();
  });
});
