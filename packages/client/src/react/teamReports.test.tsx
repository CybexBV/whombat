// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { TeamReport, TeamReportsList } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { endpointKey } from '../query/keys';
import { fakeClient } from '../test/session';
import { WhombatClientProvider } from './context';
import {
  useActTeamReport,
  useCreateTeamReport,
  useTeamReport,
  useTeamReports,
  useTeamReportsEntry,
} from './teamReports';

const BURROW = 'mara';
const ID = 'tr_AAAAAAAAAAAAAAAAAAAA';
const NEW = 'tr_BBBBBBBBBBBBBBBBBBBB';

const report = (over: Partial<TeamReport> = {}): TeamReport => ({
  id: ID,
  number: 3,
  kind: 'bug',
  title: 'The backup page stays empty',
  status: 'needs_information',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_500,
  revision: 2,
  text: 'The backup page stays empty.',
  expected: '',
  context: { client: 'web' },
  messages: [{ id: 'm1', author: 'team', text: 'Which browser?', at: 1_700_000_500 }],
  ...over,
});

const list = (over: Partial<TeamReportsList> = {}): TeamReportsList => {
  const { text: _t, expected: _e, context: _c, messages: _m, ...summary } = report();
  return { available: true, reason: null, stale: false, reports: [{ ...summary, unread: true }], ...over };
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(respond: (method: string, url: string, body: Record<string, unknown>) => Response) {
  const sent: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const method = init.method ?? 'GET';
    sent.push({ method, url: String(url), body });
    return respond(method, String(url), body);
  });
  const client = fakeClient(fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} realtime={null} queryClient={queryClient} connect={false}>
      {children}
    </WhombatClientProvider>
  );
  const listed = () =>
    queryClient.getQueryData<TeamReportsList>(
      endpointKey(api.teamReports.list, { params: { burrow: BURROW } }),
    );
  return { sent, client, queryClient, wrapper, listed };
}

describe('reports to the Whombat Team in React', () => {
  it('asks nothing before the session says it speaks reports, then shows the entry', async () => {
    const { client, wrapper, sent } = setup(() => json(list()));
    const { result } = renderHook(() => useTeamReportsEntry(BURROW), { wrapper });
    expect(result.current).toBe(false);
    expect(sent).toHaveLength(0);
    act(() => client.session?.connect());
    await waitFor(() => expect(result.current).toBe(true));
    expect(sent[0]?.url).toContain('/team-reports');
    client.session?.close();
  });

  it('hides the entry from a person who can’t send and has no reports', async () => {
    const { client, wrapper, sent } = setup(() =>
      json(list({ available: false, reason: 'not_invited', reports: [] })),
    );
    const { result } = renderHook(() => useTeamReports(BURROW), { wrapper });
    act(() => client.session?.connect());
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.supported).toBe(true);
    expect(result.current.shown).toBe(false);
    client.session?.close();
  });

  it('clears a row’s dot once its report is read', async () => {
    const { client, wrapper, listed } = setup((_m, url) =>
      url.includes(`/team-reports/${ID}`) ? json({ report: report() }) : json(list()),
    );
    renderHook(() => useTeamReports(BURROW), { wrapper });
    act(() => client.session?.connect());
    await waitFor(() => expect(listed()?.reports[0]?.unread).toBe(true));
    const page = renderHook(() => useTeamReport(BURROW, ID), { wrapper });
    await waitFor(() => expect(page.result.current.report?.id).toBe(ID));
    await waitFor(() => expect(listed()?.reports[0]?.unread).toBe(false));
    client.session?.close();
  });

  it('puts a new report at the top of the list, and takes a withdrawn one out', async () => {
    const box = list();
    const { client, wrapper, listed, sent } = setup((method, url) => {
      if (method === 'POST' && url.endsWith('/team-reports')) {
        const made = report({ id: NEW, number: 4, status: 'new', messages: [] });
        const { text: _t, expected: _e, context: _c, messages: _m, ...summary } = made;
        box.reports = [{ ...summary, unread: false }, ...box.reports];
        return json({ report: made }, 201);
      }
      if (method === 'POST' && url.endsWith('/act')) {
        box.reports = box.reports.filter((r) => r.id !== ID);
        return json({ report: null });
      }
      return json(box);
    });
    renderHook(() => useTeamReports(BURROW), { wrapper });
    act(() => client.session?.connect());
    await waitFor(() => expect(listed()?.reports).toHaveLength(1));

    const create = renderHook(() => useCreateTeamReport(BURROW), { wrapper });
    const made = await act(() =>
      create.result.current.mutateAsync({
        kind: 'idea',
        text: 'Show the weather on the screen.',
        expected: '',
        context: { client: 'web', appVersion: '3.158.0' },
      }),
    );
    expect(made.id).toBe(NEW);
    expect(sent.find((s) => s.method === 'POST')?.body).toMatchObject({
      kind: 'idea',
      context: { client: 'web' },
    });
    await waitFor(() => expect(listed()?.reports.map((r) => r.id)).toEqual([NEW, ID]));

    const withdraw = renderHook(() => useActTeamReport(BURROW, ID), { wrapper });
    await act(() => withdraw.result.current.mutateAsync('withdraw'));
    expect(sent.some((s) => s.url.endsWith(`/team-reports/${ID}/act`) && s.body.action === 'withdraw')).toBe(
      true,
    );
    await waitFor(() => expect(listed()?.reports.map((r) => r.id)).toEqual([NEW]));
    client.session?.close();
  });
});
