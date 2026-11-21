import { QueryCache, QueryClient, QueryObserver } from '@tanstack/query-core';
import { describe, expect, it, vi } from 'vitest';
import { cachedData, endpointQueries, patchEndpoint, refetchOwedReads } from './cache';
import { endpointScope, QUERY_ROOT } from './keys';

const key = (id: string, conversationId = 'cnv_chat', infinite = false) =>
  [QUERY_ROOT, id, { burrow: 'burrow', conversationId }, {}, ...(infinite ? ['infinite'] : [])] as const;

describe('endpoint cache lookups', () => {
  it('does not revisit unrelated queries on repeated endpoint reads and patches', () => {
    const qc = new QueryClient();
    qc.setQueryData(key('messages.list'), { count: 1 });
    for (let i = 0; i < 128; i++) qc.setQueryData(key(`unrelated.${i}`), i);
    const scans = vi.spyOn(qc.getQueryCache(), 'getAll');
    expect(endpointQueries(qc, 'messages.list')).toHaveLength(1);
    expect(scans).toHaveBeenCalledTimes(1);
    scans.mockClear();
    for (let i = 0; i < 10; i++) {
      expect(endpointQueries(qc, 'messages.list', { conversationId: 'cnv_chat' })).toHaveLength(1);
      expect(cachedData(qc, 'messages.list')).toHaveLength(1);
      patchEndpoint(qc, 'messages.list', (data) => data);
    }
    expect(scans).not.toHaveBeenCalled();
  });

  it('matches endpoint prefixes and partial params as the query cache does', () => {
    const qc = new QueryClient();
    const keys = [
      key('messages.list'),
      key('messages.list', 'cnv_chat', true),
      key('messages.list', 'cnv_other'),
      key('messages.thread'),
      ['other', 'messages.list', { conversationId: 'cnv_chat' }, {}],
      [QUERY_ROOT, 'messages.list'],
    ];
    for (const k of keys) qc.setQueryData(k, { count: 1 });
    for (const params of [undefined, {}, { conversationId: 'cnv_chat' }, { conversationId: 'absent' }]) {
      expect(endpointQueries(qc, 'messages.list', params)).toEqual(
        qc.getQueryCache().findAll({ queryKey: endpointScope('messages.list', params) }),
      );
    }
    patchEndpoint<{ count: number }>(qc, 'messages.list', (d) => ({ count: d.count + 1 }), {
      conversationId: 'cnv_chat',
    });
    expect(qc.getQueryData(keys[0] ?? [])).toEqual({ count: 2 });
    expect(qc.getQueryData(keys[1] ?? [])).toEqual({ count: 2 });
    expect(qc.getQueryData(keys[2] ?? [])).toEqual({ count: 1 });
  });

  it('follows additions, removal, clear and data updates across clients sharing a cache', () => {
    const cache = new QueryCache();
    const first = new QueryClient({ queryCache: cache });
    const second = new QueryClient({ queryCache: cache });
    const chat = key('messages.list');
    const other = key('messages.list', 'cnv_other');
    expect(endpointQueries(first, 'messages.list')).toEqual([]);
    second.setQueryData(chat, 1);
    expect(cachedData<number>(first, 'messages.list')).toEqual([{ key: chat, data: 1 }]);
    first.setQueryData(chat, 2);
    second.setQueryData(other, 3);
    second.removeQueries({ queryKey: chat, exact: true });
    expect(cachedData<number>(first, 'messages.list')).toEqual([{ key: other, data: 3 }]);
    cache.clear();
    expect(endpointQueries(second, 'messages.list')).toEqual([]);
    first.setQueryData(chat, 4);
    expect(cachedData<number>(second, 'messages.list')).toEqual([{ key: chat, data: 4 }]);
  });

  it('ignores additions removed by an earlier cache subscriber', () => {
    const cache = new QueryCache();
    const qc = new QueryClient({ queryCache: cache });
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === 'added') cache.remove(event.query);
    });
    expect(endpointQueries(qc, 'messages.list')).toEqual([]);
    qc.setQueryData(key('messages.list'), 1);
    expect(cache.getAll()).toEqual([]);
    expect(endpointQueries(qc, 'messages.list')).toEqual([]);
    unsubscribe();
    qc.setQueryData(key('messages.list'), 2);
    expect(cachedData<number>(qc, 'messages.list')).toEqual([{ key: key('messages.list'), data: 2 }]);
  });

  it('skips unpopulated and malformed data keys while patching a stable snapshot', () => {
    const qc = new QueryClient();
    const first = key('messages.list');
    const second = key('messages.list', 'cnv_other');
    const added = key('messages.list', 'cnv_added');
    qc.setQueryData(first, { count: 1 });
    qc.setQueryData(second, { count: 2 });
    qc.getQueryCache().build(qc, { queryKey: key('messages.list', 'cnv_empty') });
    qc.setQueryData([QUERY_ROOT, 'messages.list'], { count: 5 });
    const visited: string[] = [];
    patchEndpoint<{ count: number }>(qc, 'messages.list', (data, parsed) => {
      visited.push(String(parsed.params.conversationId));
      if (parsed.params.conversationId === 'cnv_chat') qc.setQueryData(added, { count: 3 });
      return { count: data.count + 1 };
    });
    expect(visited).toEqual(['cnv_chat', 'cnv_other']);
    expect(qc.getQueryData(first)).toEqual({ count: 2 });
    expect(qc.getQueryData(second)).toEqual({ count: 3 });
    expect(qc.getQueryData(added)).toEqual({ count: 3 });
    expect(endpointQueries(qc, 'messages.list')).toHaveLength(5);
  });
});

describe('a live change to a cached read', () => {
  const read = (qc: QueryClient) => qc.getQueryState(key('messages.list'));

  it('changes what it shows, not when it was read', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const qc = new QueryClient();
      qc.setQueryData(key('messages.list'), { count: 1 });
      vi.setSystemTime(5 * 24 * 3600_000);
      patchEndpoint<{ count: number }>(qc, 'messages.list', (d) => ({ count: d.count + 1 }));
      expect(read(qc)?.data).toEqual({ count: 2 });
      // Days old still: the read after a quiet while and the stale time ask for it again.
      expect(read(qc)?.dataUpdatedAt).toBe(1_000);
      expect(
        qc
          .getQueryCache()
          .find({ queryKey: key('messages.list') })
          ?.isStaleByTime(15_000),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failure and an invalidation, so the retry and the catch-up still come', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(key('messages.list'), { count: 1 });
    await qc
      .fetchQuery({ queryKey: key('messages.list'), queryFn: () => Promise.reject(new Error('lost')) })
      .catch(() => {});
    patchEndpoint<{ count: number }>(qc, 'messages.list', (d) => ({ count: d.count + 1 }));
    expect(read(qc)).toMatchObject({ data: { count: 2 }, status: 'error', isInvalidated: true });
    expect(read(qc)?.error).toBeInstanceOf(Error);

    const other = new QueryClient();
    other.setQueryData(key('messages.list'), { count: 1 });
    await other.invalidateQueries({ queryKey: key('messages.list') });
    patchEndpoint<{ count: number }>(other, 'messages.list', (d) => ({ count: d.count + 1 }));
    expect(read(other)).toMatchObject({ data: { count: 2 }, status: 'success', isInvalidated: true });
  });

  it('survives an answer on its way that is cancelled', async () => {
    const qc = new QueryClient();
    qc.setQueryData(key('messages.list'), { count: 1 });
    const fetching = qc.fetchQuery({
      queryKey: key('messages.list'),
      queryFn: () => new Promise<{ count: number }>(() => {}),
    });
    patchEndpoint<{ count: number }>(qc, 'messages.list', (d) => ({ count: d.count + 1 }));
    await qc.cancelQueries({ queryKey: key('messages.list') });
    await fetching.catch(() => {});
    expect(read(qc)?.data).toEqual({ count: 2 });
  });
});

describe('reads owed when the connection opens', () => {
  it('asks again the reads on screen that failed or were marked, and only those', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const asked: string[] = [];
    const watch = (conversationId: string, enabled = true) =>
      new QueryObserver(qc, {
        queryKey: key('messages.list', conversationId),
        queryFn: () => {
          asked.push(conversationId);
          return { count: 1 };
        },
        enabled,
      }).subscribe(() => {});
    for (const id of ['fresh', 'owed', 'hidden']) qc.setQueryData(key('messages.list', id), { count: 0 });
    qc.getQueryCache()
      .find({ queryKey: key('messages.list', 'owed') })
      ?.invalidate();
    qc.getQueryCache()
      .find({ queryKey: key('messages.list', 'hidden') })
      ?.invalidate();
    const offs = [watch('fresh'), watch('owed'), watch('hidden', false)];
    await vi.waitFor(() =>
      expect(qc.getQueryState(key('messages.list', 'owed'))).toMatchObject({
        data: { count: 1 },
        fetchStatus: 'idle',
      }),
    );
    expect(asked).toEqual(['owed']);
    asked.length = 0;
    qc.getQueryCache()
      .find({ queryKey: key('messages.list', 'owed') })
      ?.invalidate();
    await refetchOwedReads(qc);
    // Out of view (disabled): it catches up as it comes into view.
    expect(asked).toEqual(['owed']);
    for (const off of offs) off();
  });
});
