// @vitest-environment jsdom
/**
 * `useSearchPages` (Whombat search-pagination.md, whombat-app SRP-11): a new search that fails shows none of the last
 * search's rows, and pages of an older walk (a first page refetched since ends elsewhere) stop being fetched.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { api, type SearchResponse, type SearchResult } from '@whombat/core';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { endpointKey } from '../query/keys';
import { BURROW } from '../test/fixtures';
import { drivenRealtime, fakeClient } from '../test/session';
import { WhombatClientProvider } from './context';
import { useSearchPages } from './queries';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function result(id: string): SearchResult {
  return {
    id,
    type: 'MESSAGE',
    where: 'Chat · today 10:02',
    authorId: 'prn_mara',
    snippet: id,
    citedAs: null,
    link: { type: 'dm', room: 'chat' },
    createdAt: '2026-09-23T08:02:00.000Z',
    status: null,
  };
}

const page = (q: string, ids: string[], next: string | null): SearchResponse => ({
  query: q,
  results: ids.map(result),
  counts: {
    all: ids.length,
    threads: ids.length,
    patches: 0,
    runs: 0,
    canvases: 0,
    plans: 0,
    decisions: 0,
    automations: 0,
  },
  answer: null,
  next,
});

const errorBody = { error: { code: 'internal', message: 'Something went wrong.' } };

function setup(respond: (q: string, cursor: string | null) => Response) {
  const calls: { q: string; cursor: string | null }[] = [];
  const fetch = vi.fn(async (url: string) => {
    const u = new URL(url, 'http://whombat.test');
    const q = u.searchParams.get('q') ?? '';
    const cursor = u.searchParams.get('cursor');
    calls.push({ q, cursor });
    return respond(q, cursor);
  });
  const client = fakeClient(fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const realtime = drivenRealtime();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} realtime={realtime} queryClient={queryClient}>
      {children}
    </WhombatClientProvider>
  );
  return { calls, queryClient, wrapper };
}

const input = (q: string) => ({ params: { burrow: BURROW }, query: { q, type: 'all' as const } });

describe('useSearchPages', () => {
  it('shows none of the last search’s rows when a new search fails', async () => {
    const { wrapper } = setup((q) =>
      q === 'first' ? json(page(q, ['msg_a', 'msg_b'], null)) : json(errorBody, 500),
    );
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useSearchPages(input(q), { placeholderData: (prev) => prev }),
      { wrapper, initialProps: { q: 'first' } },
    );
    await waitFor(() => expect(result.current.results.map((r) => r.id)).toEqual(['msg_a', 'msg_b']));
    rerender({ q: 'second' });
    await waitFor(() => expect(result.current.first.isError).toBe(true));
    expect(result.current.results).toEqual([]);
  });

  it('stops fetching the pages of an older walk once the first page ends elsewhere', async () => {
    let firstNext = 'c1';
    const { calls, queryClient, wrapper } = setup((q, cursor) =>
      json(cursor ? page(q, [`msg_${cursor}`], null) : page(q, ['msg_a'], firstNext)),
    );
    const { result } = renderHook(() => useSearchPages(input('walk')), { wrapper });
    await waitFor(() => expect(result.current.next).toBe('c1'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.results.map((r) => r.id)).toEqual(['msg_a', 'msg_c1']));

    // The first page is fetched again and now ends elsewhere: the old second page drops out of the walk…
    firstNext = 'c1b';
    const firstKey = endpointKey(api.search.query, input('walk'));
    await act(() => queryClient.refetchQueries({ queryKey: firstKey }));
    await waitFor(() => expect(result.current.results.map((r) => r.id)).toEqual(['msg_a']));
    expect(result.current.next).toBe('c1b');
    // …and isn't fetched again when everything is (a resync, a focus).
    const before = calls.filter((c) => c.cursor === 'c1').length;
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(calls.filter((c) => c.cursor === null).length).toBeGreaterThanOrEqual(3));
    expect(calls.filter((c) => c.cursor === 'c1').length).toBe(before);
    const old = queryClient.getQueryCache().find({
      queryKey: endpointKey(api.search.query, {
        ...input('walk'),
        query: { ...input('walk').query, cursor: 'c1' },
      }),
    });
    expect(old?.getObserversCount() ?? 0).toBe(0);
  });
});
