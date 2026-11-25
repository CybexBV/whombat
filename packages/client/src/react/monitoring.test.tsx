// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeptQuiet, ThingPage, ThingWatch } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../query/keys';
import { fakeClient } from '../test/session';
import { WhombatClientProvider } from './context';
import { type SheetOutcome, useKeepQuiet, useSetWatchLimit } from './monitoring';

const BURROW = 'mara';
const THING = 'connection:con_unifi';
const SERVER = 'server:pve-02';
const TZ = 'Europe/Amsterdam';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const kept: KeptQuiet = {
  id: 'qw_1',
  words: 'Quiet until 23:00 · Moving the NAS',
  since: '2026-11-24T20:00:00.000Z',
  until: '2026-11-24T22:00:00.000Z',
  note: 'Moving the NAS',
  canEnd: true,
};

const watch: ThingWatch = {
  mayChange: true,
  checks: [
    {
      check: 'host.disk.space_high',
      name: 'Disks filling up',
      nature: 'problem',
      on: true,
      perItem: true,
      exceptions: [],
      limit: { unit: '%', min: 1, max: 100, defaultValue: 90, value: 95, items: [] },
    },
  ],
};

function setup(respond: (url: string, body: Record<string, unknown>) => Response) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url: decodeURIComponent(String(url)), body });
    return respond(decodeURIComponent(String(url)), body);
  });
  const client = fakeClient(fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const pageKey = queryKeys.endpoint(api.things.page, { params: { burrow: BURROW, thing: THING } });
  queryClient.setQueryData(pageKey, { id: THING, tabs: [] } as unknown as ThingPage);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} realtime={null} queryClient={queryClient} connect={false}>
      {children}
    </WhombatClientProvider>
  );
  return { sent, queryClient, wrapper, pageKey };
}

describe('useKeepQuiet', () => {
  it('keeps a thing quiet: the page carries it at once, the toast says until when with Undo that ends it', async () => {
    const { sent, wrapper, queryClient, pageKey } = setup((url) =>
      json({ keptQuiet: url.endsWith('/end') ? null : kept }),
    );
    const notes: { message: string; undo?: () => void; failed?: boolean }[] = [];
    const { result } = renderHook(
      () =>
        useKeepQuiet(BURROW, THING, {
          name: 'UniFi',
          timeZone: TZ,
          note: (message, o) => notes.push({ message, ...o }),
        }),
      { wrapper },
    );
    let done: SheetOutcome | null = null;
    await act(async () => {
      done = await result.current.keep({ until: kept.until, note: 'Moving the NAS' });
    });
    expect(done).toBe(true);
    expect(sent[0]?.url).toContain(`/things/${THING}/keep-quiet`);
    expect(sent[0]?.body).toEqual({ until: kept.until, note: 'Moving the NAS' });
    expect(queryClient.getQueryData<ThingPage>(pageKey)?.keptQuiet?.id).toBe('qw_1');
    expect(notes[0]?.message).toMatch(/^Quiet until /);
    act(() => notes[0]?.undo?.());
    await waitFor(() => expect(notes.at(-1)?.message).toContain('UniFi'));
    expect(sent.at(-1)?.url).toContain('/keep-quiet/end');
    expect(queryClient.getQueryData<ThingPage>(pageKey)?.keptQuiet).toBeUndefined();
  });

  it('gives a refusal’s words back to the open sheet instead of a toast behind it, and changes nothing', async () => {
    const { wrapper, queryClient, pageKey } = setup(() =>
      json({ error: { code: 'not_allowed', message: 'You can’t keep this quiet.' } }, 403),
    );
    const notes: { message: string; failed?: boolean }[] = [];
    const { result } = renderHook(
      () =>
        useKeepQuiet(BURROW, THING, {
          name: 'UniFi',
          timeZone: TZ,
          note: (message, o) => notes.push({ message, ...o }),
        }),
      { wrapper },
    );
    let done: SheetOutcome = true;
    await act(async () => {
      done = await result.current.keep({ minutes: 60 });
    });
    expect(done).toEqual({ problem: 'You can’t keep this quiet.' });
    expect(notes).toEqual([]);
    expect(queryClient.getQueryData<ThingPage>(pageKey)?.keptQuiet).toBeUndefined();
  });
});

describe('useSetWatchLimit', () => {
  it('sets a limit, takes the server’s watch list and offers Undo of the change', async () => {
    const { sent, wrapper, queryClient } = setup(() => json({ watch, changeId: 'chg_limit_1' }));
    const watchKey = queryKeys.endpoint(api.things.watch, { params: { burrow: BURROW, thing: SERVER } });
    queryClient.setQueryData(watchKey, { ...watch, checks: [] });
    const notes: { message: string; undo?: () => void }[] = [];
    const { result } = renderHook(
      () => useSetWatchLimit(BURROW, SERVER, { note: (message, o) => notes.push({ message, ...o }) }),
      { wrapper },
    );
    await act(async () => {
      await result.current.set({
        check: 'host.disk.space_high',
        name: 'Disks filling up',
        unit: '%',
        limit: 95,
      });
    });
    expect(sent[0]?.url).toContain(`/things/${SERVER}/watch/limit`);
    expect(sent[0]?.body).toEqual({ check: 'host.disk.space_high', limit: 95 });
    expect(queryClient.getQueryData<ThingWatch>(watchKey)?.checks[0]?.limit?.value).toBe(95);
    expect(notes[0]?.message).toContain('95 %');
    expect(typeof notes[0]?.undo).toBe('function');
  });

  it('gives the hub’s refusal back to the open sheet, toasts nothing and keeps the watch list', async () => {
    const refusal = 'Set it below the critical limit of 90 °C.';
    const { wrapper, queryClient } = setup(() =>
      json({ error: { code: 'invalid_request', message: refusal } }, 400),
    );
    const watchKey = queryKeys.endpoint(api.things.watch, { params: { burrow: BURROW, thing: SERVER } });
    queryClient.setQueryData(watchKey, watch);
    const notes: { message: string }[] = [];
    const { result } = renderHook(
      () => useSetWatchLimit(BURROW, SERVER, { note: (message, o) => notes.push({ message, ...o }) }),
      { wrapper },
    );
    let done: SheetOutcome = true;
    await act(async () => {
      done = await result.current.set({
        check: 'host.sensor.temp_high',
        name: 'Running hot',
        unit: '°C',
        limit: 92,
      });
    });
    expect(done).toEqual({ problem: refusal });
    expect(notes).toEqual([]);
    expect(result.current.busy).toBe(false);
    expect(queryClient.getQueryData<ThingWatch>(watchKey)?.checks[0]?.limit?.value).toBe(95);
  });
});
