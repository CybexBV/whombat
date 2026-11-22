// @vitest-environment jsdom
/**
 * The Find My tab's reads from the apps: a read when the tab opens on an old read (not while the Mac's screen can't be
 * used, not on a fresh one), the answer in the cache at once so the asking-again starts, and the exact picture.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WhombatClientProvider } from '../react/context';
import { BURROW } from '../test/fixtures';
import { drivenRealtime, fakeClient } from '../test/session';
import { useFindMyTab } from './findmy-react';
import { createHostsFixtures } from './fixtures';
import { FIND_MY_FIXTURE_READ_MS } from './fixtures-findmy';
import { MAC_SERVER } from './fixtures-mac';

const NOW = Date.parse('2026-11-22T12:00:00Z');

function setup() {
  let now = NOW;
  const fx = createHostsFixtures(NOW, { mac: { listed: true, clock: () => now } });
  const posts: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x');
    const path = u.pathname.replace(/^.*\/burrows\/[^/]+\/hosts/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === 'POST') posts.push(path);
    const answer = fx.handle({
      method: init?.method ?? 'GET',
      path,
      query: Object.fromEntries(u.searchParams),
      body,
    });
    return new Response(JSON.stringify(answer?.body ?? { error: { code: 'not_found', message: 'No.' } }), {
      status: answer?.status ?? 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={fakeClient(fetch)} realtime={drivenRealtime()} queryClient={queryClient}>
      {children}
    </WhombatClientProvider>
  );
  const tab = (canRead = true) =>
    renderHook(() => useFindMyTab({ burrow: BURROW, serverId: MAC_SERVER, canRead, clock: () => now }), {
      wrapper,
    });
  return {
    tab,
    posts,
    later: (ms: number) => {
      now += ms;
    },
  };
}

describe('useFindMyTab', () => {
  it('reads when the tab opens on nothing read, and shows the read under way at once', async () => {
    const { tab, posts } = setup();
    const { result } = tab();
    await waitFor(() => expect(result.current.state?.reading).toBe(true));
    expect(posts).toEqual([`/servers/${MAC_SERVER}/find-my/refresh`]);
  });

  it('doesn’t read while the Mac’s screen can’t be used', async () => {
    const { tab, posts } = setup();
    const { result } = tab(false);
    await waitFor(() => expect(result.current.state).toBeDefined());
    expect(result.current.state?.reading).toBe(false);
    expect(posts).toEqual([]);
  });

  it('doesn’t read again on a fresh read, and takes an exact picture when asked', async () => {
    const { tab, posts, later } = setup();
    const first = tab();
    await waitFor(() => expect(first.result.current.state?.reading).toBe(true));
    later(FIND_MY_FIXTURE_READ_MS);
    first.unmount();

    const again = tab();
    await waitFor(() => expect(again.result.current.state?.readAt).not.toBeNull());
    expect(posts).toHaveLength(1);
    let problem: string | null = 'unset';
    await act(async () => {
      problem = await again.result.current.showExactly('b6b64347cde5');
    });
    expect(problem).toBeNull();
    // The answer goes into the cache as it comes.
    await waitFor(() =>
      expect(again.result.current.state?.exact).toMatchObject({ person: 'b6b64347cde5', state: 'taking' }),
    );
    expect(posts.at(-1)).toBe(`/servers/${MAC_SERVER}/find-my/exact`);
  });
});
