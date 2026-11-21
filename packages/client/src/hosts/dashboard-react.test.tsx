// @vitest-environment jsdom
/**
 * `useServerDashboard` (dashboards.md DS-02, DS-16; AP-2005): one read of the server's page shared with its head, the
 * range's history, the storages' 30 days and the busiest guests' small lines, built into the Summary's panels; a new
 * range reads again while the previous one stays on screen.
 */
import { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WhombatClientProvider } from '../react/context';
import { BURROW } from '../test/fixtures';
import { drivenRealtime, fakeClient } from '../test/session';
import { withDashboardFixtures } from './dashboard-fixtures';
import { useServerDashboard } from './react';

const NOW = Date.parse('2026-10-18T16:00:00Z');

function setup() {
  const handle = withDashboardFixtures(() => null, NOW);
  const fetch = vi.fn(async (url: string) => {
    const u = new URL(url, 'http://x');
    const path = u.pathname.replace(/^.*\/burrows\/[^/]+\/hosts/, '');
    const answer = handle({ method: 'GET', path, query: Object.fromEntries(u.searchParams), body: {} });
    return new Response(JSON.stringify(answer?.body ?? { error: { code: 'not_found', message: 'No.' } }), {
      status: answer?.status ?? 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = fakeClient(fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const realtime = drivenRealtime();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} realtime={realtime} queryClient={queryClient}>
      {children}
    </WhombatClientProvider>
  );
  const urls = () => fetch.mock.calls.map(([url]) => decodeURIComponent(String(url)));
  return { fetch, wrapper, urls };
}

describe('useServerDashboard', () => {
  it('reads the page, the range, the storages’ 30 days and the busiest guests, and builds the Summary', async () => {
    const { wrapper, urls } = setup();
    const { result } = renderHook(
      () =>
        useServerDashboard({
          burrow: BURROW,
          serverId: 'pve-02',
          range: '24h',
          timeZone: 'Europe/Amsterdam',
        }),
      { wrapper },
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      const t = result.current.panels?.find((p) => p.id === 'guests');
      expect(t?.kind === 'table' && t.rows[0]?.cells.trend?.spark?.length).toBe(96);
    });
    expect(result.current.head?.badge).toBe('Running warm');
    // The storage card is a Technical detail; the Storage tile says the soonest forecast.
    const storage = result.current.details?.find((p) => p.id === 'storage');
    expect(storage?.kind === 'bars' && storage.items[0]?.sub).toBe('Full in about 5 months');
    const figures = result.current.panels?.find((p) => p.id === 'figures');
    expect(figures?.kind === 'kpis' && figures.items.find((k) => k.key === 'storage')?.sub).toContain(
      'Full in about 5 months',
    );
    expect(result.current.verdict?.sentence).toMatch(/^pve-02 /);
    const read = urls();
    expect(read.filter((u) => /servers\/pve-02\?range=24h$/.test(u))).toHaveLength(1);
    expect(read.some((u) => /metrics\?range=24h&series=cpu_pct,mem_pct,/.test(u))).toBe(true);
    expect(read.some((u) => /metrics\?range=30d&series=vol_pct:storage:local-lvm,/.test(u))).toBe(true);
    expect(read.filter((u) => /guests\/pve:\d+\/metrics\?range=24h&series=cpu_pct$/.test(u))).toHaveLength(5);
  });

  it('keeps the previous range on screen, with its own words, until the new one comes', async () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ range }: { range: '24h' | '7d' }) =>
        useServerDashboard({ burrow: BURROW, serverId: 'raspi', range }),
      { wrapper, initialProps: { range: '24h' } },
    );
    const column = () => {
      const t = result.current.panels?.find((p) => p.id === 'guests');
      return t?.kind === 'table' ? t.columns[3]?.label : null;
    };
    await waitFor(() => expect(result.current.series?.range).toBe('24h'));
    expect(column()).toBe('24 h');
    rerender({ range: '7d' });
    expect(result.current.series?.range).toBe('24h');
    expect(column()).toBe('24 h');
    await waitFor(() => expect(result.current.series?.range).toBe('7d'));
    expect(column()).toBe('7 d');
  });

  it('waits without a server', () => {
    const { wrapper, fetch } = setup();
    const { result } = renderHook(
      () => useServerDashboard({ burrow: BURROW, serverId: null, range: '24h' }),
      {
        wrapper,
      },
    );
    expect(result.current).toMatchObject({ panels: null, head: null, loading: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
