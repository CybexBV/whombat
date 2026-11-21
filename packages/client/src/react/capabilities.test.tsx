// @vitest-environment jsdom
/**
 * Agent capabilities' hooks (spend.md SP-01, SP-02): the spend reads refetch every time a screen showing them opens.
 */
import { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { spendOverview, spendWeek } from '@whombat/fixtures';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BURROW } from '../test/fixtures';
import { drivenRealtime, fakeClient } from '../test/session';
import { WhombatClientProvider } from './context';
import { useAgentSpend, useSpendDaily, useSpendOverview } from './queries';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(respond: (url: string, init: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  const client = fakeClient(fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const realtime = drivenRealtime();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} realtime={realtime} queryClient={queryClient}>
      {children}
    </WhombatClientProvider>
  );
  return { fetch, queryClient, wrapper };
}

describe('spend hooks', () => {
  it('are read hooks of their endpoints', () => {
    expect(useSpendOverview.endpoint.id).toBe('spend.overview');
    expect(useAgentSpend.endpoint.id).toBe('spend.week');
    expect(useSpendDaily.endpoint.id).toBe('spend.daily');
  });

  it('read the overview again every time a screen opens, however fresh the cache is', async () => {
    const { fetch, wrapper } = setup((url) =>
      url.endsWith(`/burrows/${BURROW}/spend`) ? json(spendOverview()) : json({}, 404),
    );
    const input = { params: { burrow: BURROW } };
    const first = renderHook(() => useSpendOverview(input), { wrapper });
    await waitFor(() => expect(first.result.current.data?.totals.month.turns).toBeGreaterThan(0));
    first.unmount();
    const again = renderHook(() => useSpendOverview(input), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(again.result.current.data?.totals.month.turns).toBeGreaterThan(0);
  });

  it('read the agent’s week', async () => {
    const week = spendWeek();
    const { wrapper } = setup((url) =>
      url.endsWith(`/burrows/${BURROW}/spend/week`) ? json(week) : json({}, 404),
    );
    const { result } = renderHook(() => useAgentSpend({ params: { burrow: BURROW } }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toEqual(week));
  });
});
