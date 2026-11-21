// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ThingPage, ThingPageNotice, ThingWatch } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../query/keys';
import { fakeClient } from '../test/session';
import { WhombatClientProvider } from './context';
import { useQuietActions } from './quiet';

const BURROW = 'mara';
const THING = 'connection:con_unifi';
const TZ = 'Europe/Amsterdam';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const hallway: ThingPageNotice = {
  id: 'ap-hallway',
  tone: 'warn',
  icon: 'network',
  title: 'Hallway AP is offline',
  nature: 'problem',
  check: 'unifi.device_offline',
  subject: { id: 'device:abc', name: 'Hallway AP' },
  ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
};

const page = {
  id: THING,
  tabs: [
    {
      key: 'overview',
      label: 'Overview',
      panels: [{ kind: 'notices', id: 'worth', title: 'Worth a look', items: [hallway] }],
    },
  ],
} as unknown as ThingPage;

const watch: ThingWatch = {
  mayChange: true,
  checks: [
    {
      check: 'unifi.device_offline',
      name: 'Access points going offline',
      nature: 'problem',
      on: true,
      perItem: true,
      exceptions: [],
    },
  ],
};

function setup(respond: (url: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url: decodeURIComponent(String(url)), body });
    return respond(String(url), body);
  });
  const client = fakeClient(fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const pageKey = queryKeys.endpoint(api.things.page, { params: { burrow: BURROW, thing: THING } });
  const watchKey = queryKeys.endpoint(api.things.watch, { params: { burrow: BURROW, thing: THING } });
  queryClient.setQueryData(pageKey, page);
  queryClient.setQueryData(watchKey, watch);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} realtime={null} queryClient={queryClient} connect={false}>
      {children}
    </WhombatClientProvider>
  );
  const line = () => {
    const p = queryClient.getQueryData<ThingPage>(pageKey);
    const panel = p?.tabs[0]?.panels[0];
    return panel?.kind === 'notices' ? panel.items[0] : undefined;
  };
  return { sent, queryClient, wrapper, line, watchKey };
}

describe('useQuietActions (AP-4804, AP-4805)', () => {
  it('greys the line at once, takes the server’s answer, says so with Undo, and undoes', async () => {
    const quiet = {
      state: 'ignored',
      words: 'until it’s back online',
      by: { id: 'prn_john', name: 'John' },
      at: '2026-10-22T09:00:00.000Z',
    };
    const { sent, wrapper, line, queryClient } = setup((_u, body) =>
      json({ notice: body.notice, quiet: body.how === 'undo' ? null : quiet }),
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const notes: { message: string; undo?: () => void; failed?: boolean }[] = [];
    const { result } = renderHook(
      () =>
        useQuietActions(BURROW, THING, { timeZone: TZ, note: (message, o) => notes.push({ message, ...o }) }),
      { wrapper },
    );
    act(() => result.current.ignore(hallway));
    await waitFor(() => expect(line()?.quiet).toBeTruthy());
    await waitFor(() => expect(notes).toHaveLength(1));
    expect(sent[0]?.url).toContain('/things/connection:con_unifi/quiet');
    expect(sent[0]?.body).toEqual({
      notice: { check: 'unifi.device_offline', subject: 'device:abc' },
      how: 'ignore',
    });
    expect(line()?.quiet?.by?.name).toBe('John');
    expect(notes[0]?.message).toBe('Ignored. You’ll hear if it changes.');
    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(queryKeys.scope('things.watch', { burrow: BURROW, thing: THING }));
    expect(keys).toContainEqual(queryKeys.scope('home.overview', { burrow: BURROW }));
    act(() => notes[0]?.undo?.());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body.how).toBe('undo');
    await waitFor(() => expect(line()?.quiet).toBeUndefined());
  });

  it('puts the line back and says why when it is refused', async () => {
    const { wrapper, line } = setup(() =>
      json(
        {
          error: {
            code: 'not_allowed',
            message: 'Only those who manage it can quiet what Whombat watches here.',
          },
        },
        403,
      ),
    );
    const notes: { message: string; failed?: boolean }[] = [];
    const { result } = renderHook(
      () =>
        useQuietActions(BURROW, THING, { timeZone: TZ, note: (message, o) => notes.push({ message, ...o }) }),
      { wrapper },
    );
    act(() => result.current.snooze(hallway));
    await waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]).toMatchObject({ failed: true });
    expect(notes[0]?.message).toContain('manage');
    expect(line()?.quiet).toBeUndefined();
  });

  it('stops watching an item: the line goes, the watch list takes the answer, Undo watches it again', async () => {
    const stopped: ThingWatch = {
      ...watch,
      checks: [
        {
          ...(watch.checks[0] as ThingWatch['checks'][number]),
          exceptions: [
            { subject: hallway.subject, state: 'stopped', words: 'always', at: '2026-10-22T09:00:00.000Z' },
          ],
        },
      ],
    };
    const { sent, wrapper, line, queryClient, watchKey } = setup((_u, body) =>
      json(body.watched ? watch : stopped),
    );
    const notes: { message: string; undo?: () => void }[] = [];
    const { result } = renderHook(
      () =>
        useQuietActions(BURROW, THING, { timeZone: TZ, note: (message, o) => notes.push({ message, ...o }) }),
      { wrapper },
    );
    act(() => result.current.stop(hallway));
    expect(line()).toBeUndefined();
    await waitFor(() => expect(notes).toHaveLength(1));
    expect(sent[0]?.body).toEqual({
      check: 'unifi.device_offline',
      subject: hallway.subject,
      watched: false,
    });
    expect(notes[0]?.message).toBe('Whombat stopped watching Hallway AP.');
    expect(queryClient.getQueryData<ThingWatch>(watchKey)?.checks[0]?.exceptions).toHaveLength(1);
    act(() => notes[0]?.undo?.());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body.watched).toBe(true);
    await waitFor(() =>
      expect(queryClient.getQueryData<ThingWatch>(watchKey)?.checks[0]?.exceptions).toEqual([]),
    );
  });
});
