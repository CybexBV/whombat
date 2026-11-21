// @vitest-environment jsdom
/**
 * A Mac's screen step from the apps (Whombat macos-servers.md): the Mac's password goes with `account.set`'s request and
 * nowhere else. TanStack keeps a mutation's variables in its cache after it settles, so the account rides sealed.
 */
import { onlineManager, QueryClient } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WhombatClientProvider } from '../react/context';
import { BURROW } from '../test/fixtures';
import { drivenRealtime, fakeClient } from '../test/session';
import { createHostsFixtures } from './fixtures';
import { MAC_SERVER } from './fixtures-mac';
import { useHostScreenStep } from './react';

const NOW = Date.parse('2026-11-17T10:00:00Z');
const SECRET = 'mac-pass-5512';

function setup() {
  const fx = createHostsFixtures(NOW, { mac: { listed: true, clock: () => NOW, scenario: 'setup' } });
  const bodies: unknown[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x');
    const path = u.pathname.replace(/^.*\/burrows\/[^/]+\/hosts/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === 'POST') bodies.push(body);
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
  return { wrapper, queryClient, bodies };
}

describe('useHostScreenStep', () => {
  it('sends the Mac’s password once and keeps it nowhere after the call', async () => {
    const { wrapper, queryClient, bodies } = setup();
    const { result } = renderHook(() => useHostScreenStep(BURROW, MAC_SERVER, 'studio'), { wrapper });
    let outcome: Awaited<ReturnType<typeof result.current.step>> | undefined;
    await act(async () => {
      outcome = await result.current.step({ op: 'account.set', account: { user: 'mara', password: SECRET } });
    });
    expect(outcome?.ok).toBe(true);
    expect(outcome?.text).toContain('mara');
    // It went with the request…
    expect(bodies).toEqual([{ op: 'account.set', account: { user: 'mara', password: SECRET } }]);
    // …and the mutation cache's copy of the variables doesn't hold it.
    const mutations = queryClient.getMutationCache().getAll();
    expect(mutations).toHaveLength(1);
    const kept = JSON.stringify(mutations.map((m) => m.state.variables));
    expect(kept).toContain('account.set');
    expect(kept).not.toContain(SECRET);
    const variables = mutations[0]?.state.variables as { account?: { take(): unknown } } | undefined;
    expect(variables?.account?.take()).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('doesn’t wait for the network with the password in its box', async () => {
    const { wrapper, queryClient } = setup();
    onlineManager.setOnline(false);
    try {
      const { result } = renderHook(() => useHostScreenStep(BURROW, MAC_SERVER, 'studio'), { wrapper });
      await act(async () => {
        await result.current.step({ op: 'account.set', account: { user: 'mara', password: SECRET } });
      });
      // The step ran (the request took the account out) instead of pausing until the network came back.
      const [mutation] = queryClient.getMutationCache().getAll();
      expect(mutation?.state.isPaused).toBe(false);
      const variables = mutation?.state.variables as { account?: { take(): unknown } } | undefined;
      expect(variables?.account?.take()).toBeUndefined();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('sends a step without an account as it is', async () => {
    const { wrapper, bodies } = setup();
    const { result } = renderHook(() => useHostScreenStep(BURROW, MAC_SERVER, 'studio'), { wrapper });
    await act(async () => {
      await result.current.step({ op: 'ui.open', target: 'accessibility' });
    });
    expect(bodies).toEqual([{ op: 'ui.open', target: 'accessibility' }]);
  });
});
