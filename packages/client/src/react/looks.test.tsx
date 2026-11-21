// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { HomeOverview, LookResearch, ThingPage } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LookFixOutcome } from '../home/lookResearch';
import { queryKeys } from '../query/keys';
import { fakeClient } from '../test/session';
import { WhombatClientProvider } from './context';
import { useFixLook } from './looks';

const BURROW = 'mara';
const KEY = 'connection:con_home-assistant';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const found: LookResearch = {
  key: KEY,
  state: 'found',
  title: 'Zigbee stopped working in Home Assistant',
  summary: 'After this morning’s update, Zigbee didn’t start again.',
  fix: 'Restart Zigbee',
  threadRootId: 'msg_look-ha' as LookResearch['threadRootId'],
  at: '2026-10-27T09:12:00Z',
};

function setup(respond: () => Response) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : {} });
    return respond();
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const homeKey = queryKeys.endpoint(api.home.overview, { params: { burrow: BURROW } });
  const pageKey = queryKeys.endpoint(api.things.page, { params: { burrow: BURROW, thing: KEY } });
  queryClient.setQueryData(homeKey, {
    needsYou: [{ id: 'ny_ha', research: found }],
  } as unknown as HomeOverview);
  queryClient.setQueryData(pageKey, { id: KEY, research: found } as unknown as ThingPage);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider
      client={fakeClient(fetch)}
      realtime={null}
      queryClient={queryClient}
      connect={false}
    >
      {children}
    </WhombatClientProvider>
  );
  return {
    sent,
    wrapper,
    queryClient,
    home: () => queryClient.getQueryData<HomeOverview>(homeKey)?.needsYou[0]?.research,
    page: () => queryClient.getQueryData<ThingPage>(pageKey)?.research,
  };
}

describe('useFixLook (LR-08)', () => {
  it('sends the look’s key, reads fixing at once and takes the server’s answer', async () => {
    const { fix: _fix, ...rest } = found;
    const { sent, wrapper, home, page } = setup(() => json({ research: { ...rest, state: 'fixing' } }));
    const outcomes: LookFixOutcome[] = [];
    const { result } = renderHook(() => useFixLook(BURROW, (o) => outcomes.push(o)), { wrapper });
    act(() => result.current.mutate(found));
    await waitFor(() => expect(home()?.state).toBe('fixing'));
    expect(page()?.state).toBe('fixing');
    expect(page()?.fix).toBeUndefined();
    await waitFor(() => expect(outcomes).toEqual(['ok']));
    expect(sent[0]?.url).toContain(`/burrows/${BURROW}/looks/fix`);
    expect(sent[0]?.body).toEqual({ key: KEY });
  });

  it('puts the step back and says why when there is none any more', async () => {
    const { wrapper, home, page } = setup(() =>
      json({ error: { code: 'not_found', message: 'That look went.' } }, 404),
    );
    const outcomes: LookFixOutcome[] = [];
    const { result } = renderHook(() => useFixLook(BURROW, (o) => outcomes.push(o)), { wrapper });
    act(() => result.current.mutate(found));
    await waitFor(() => expect(outcomes).toEqual(['gone']));
    expect(home()).toEqual(found);
    expect(page()?.fix).toBe('Restart Zigbee');
  });
});
