// @vitest-environment jsdom
import { focusManager, QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { api } from '@whombat/core/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../query/keys';
import { fakeClient } from '../test/session';
import { WhombatClientProvider } from './context';
import { useHomeOverview } from './home';
import { createScreenFocus, ScreenFocusContext } from './screenFocus';

const B = { burrow: 'mara' };

function setup(withFocus: boolean) {
  let calls = 0;
  const fetch = vi.fn(async () => {
    calls += 1;
    return new Response(JSON.stringify({ widgets: [], calls }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  let inView = true;
  const focus = createScreenFocus(() => inView);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider
      client={fakeClient(fetch, { validateResponses: false })}
      realtime={null}
      queryClient={queryClient}
      connect={false}
    >
      {withFocus ? (
        <ScreenFocusContext.Provider value={focus}>{children}</ScreenFocusContext.Provider>
      ) : (
        children
      )}
    </WhombatClientProvider>
  );
  const key = queryKeys.scope('home.overview');
  return {
    queryClient,
    calls: () => calls,
    wrapper,
    invalidate: () => act(() => queryClient.invalidateQueries({ queryKey: key })),
    show: (next: boolean) =>
      act(() => {
        inView = next;
        focus.update();
      }),
  };
}

describe('reads on a screen out of view', () => {
  it('aren’t fetched again while it is out of view, and once when it shows again', async () => {
    const s = setup(true);
    const { result } = renderHook(() => useHomeOverview({ params: B }), { wrapper: s.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(s.calls()).toBe(1);
    s.show(false);
    await s.invalidate();
    await s.invalidate();
    // Coming back to the app doesn't fetch it either.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(s.calls()).toBe(1);
    s.show(true);
    await waitFor(() => expect(s.calls()).toBe(2));
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    // Nothing went out of date this time: showing again reads nothing.
    s.show(false);
    s.show(true);
    expect(s.calls()).toBe(2);
    act(() => focusManager.setFocused(undefined));
  });

  it('drawn out of view with data kept from before, read it when they show', async () => {
    const s = setup(true);
    const kept = { widgets: [], calls: 0 } as never;
    s.queryClient.setQueryData(queryKeys.endpoint(api.home.overview, { params: B }), kept, {
      updatedAt: Date.now() - 60_000,
    });
    s.show(false);
    renderHook(() => useHomeOverview({ params: B }), { wrapper: s.wrapper });
    await act(() => Promise.resolve());
    expect(s.calls()).toBe(0);
    s.show(true);
    await waitFor(() => expect(s.calls()).toBe(1));
  });

  it('keep their data out of view', async () => {
    const s = setup(true);
    const { result } = renderHook(() => useHomeOverview({ params: B }), { wrapper: s.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    s.show(false);
    expect(result.current.data).toBeDefined();
    // Still watched, so the cache doesn't drop it after a while out of view.
    const [query] = s.queryClient.getQueryCache().findAll({ queryKey: queryKeys.scope('home.overview') });
    expect(query?.getObserversCount()).toBe(1);
  });

  it('still wait for the caller’s own enabled', async () => {
    const s = setup(true);
    const { rerender } = renderHook(({ on }) => useHomeOverview({ params: B }, { enabled: on }), {
      wrapper: s.wrapper,
      initialProps: { on: false },
    });
    expect(s.calls()).toBe(0);
    rerender({ on: true });
    await waitFor(() => expect(s.calls()).toBe(1));
  });

  it('without a screen (the web) are fetched as always', async () => {
    const s = setup(false);
    const { result } = renderHook(() => useHomeOverview({ params: B }), { wrapper: s.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await s.invalidate();
    await waitFor(() => expect(s.calls()).toBe(2));
  });
});

describe('createScreenFocus', () => {
  it('is in view only while every screen it is drawn inside is', () => {
    let tabs = true;
    let chat = true;
    const page = createScreenFocus(() => tabs);
    const tab = createScreenFocus(() => chat, page);
    const heard = vi.fn();
    tab.subscribe(heard);
    const off = tab.follow();
    tabs = false;
    page.update();
    expect(tab.shown()).toBe(false);
    chat = false;
    tab.update();
    tabs = true;
    page.update();
    expect(tab.shown()).toBe(false);
    chat = true;
    tab.update();
    expect(tab.shown()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    tabs = false;
    page.update();
    expect(tab.shown()).toBe(true);
  });
});
