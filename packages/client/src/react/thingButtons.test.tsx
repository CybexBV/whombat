// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ThingPageButton } from '@whombat/core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../query/keys';
import { fakeClient } from '../test/session';
import { WhombatClientProvider } from './context';
import { useControlGuesses, useStepperDraft, useThingButtons } from './thingButtons';

const BURROW = 'mara';
const THING = 'connection:con_seerr';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(respond: (body: unknown) => Response | Promise<Response>) {
  const sent: unknown[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    return respond(body);
  });
  const client = fakeClient(fetch);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} realtime={null} queryClient={queryClient} connect={false}>
      {children}
    </WhombatClientProvider>
  );
  return { fetch, sent, queryClient, wrapper };
}

const approve: ThingPageButton = { action: 'approve', target: 'req_12', label: 'Approve', allowed: true };
const decline: ThingPageButton = {
  action: 'decline',
  target: 'req_12',
  label: 'Decline',
  allowed: true,
  confirm: { title: 'Decline Dune?', body: 'Anna is told.', button: 'Decline' },
};

afterEach(() => vi.useRealTimers());

describe('useThingButtons (AP-4538…AP-4540)', () => {
  it('runs a button at once, says the server’s words and reads the page again', async () => {
    const { sent, wrapper, queryClient } = setup(() =>
      json({ message: 'Approved Dune', changeId: 'chg_1' }, 202),
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const notes: [string, string][] = [];
    const { result } = renderHook(() => useThingButtons(BURROW, THING, (m, o) => notes.push([m, o])), {
      wrapper,
    });
    const onDone = vi.fn();
    act(() => result.current.press(approve, { onDone }));
    expect(result.current.running(approve)).toBe(true);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent).toEqual([{ action: 'approve', target: 'req_12' }]);
    expect(notes).toEqual([['Approved Dune', 'done']]);
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ ok: true, sent: true });
    expect(result.current.running(approve)).toBe(false);
    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(queryKeys.scope('things.page', { burrow: BURROW, thing: THING }));
    expect(keys).toContainEqual(queryKeys.scope('home.overview', { burrow: BURROW }));
  });

  it('asks first when the button has a question; cancelling sends nothing', async () => {
    const { sent, wrapper } = setup(() => json({ message: 'Declined Dune' }, 202));
    const notes: string[] = [];
    const { result } = renderHook(() => useThingButtons(BURROW, THING, (m) => notes.push(m)), { wrapper });
    const onDone = vi.fn();
    act(() => result.current.press(decline, { onDone }));
    expect(result.current.asking?.confirm.button).toBe('Decline');
    act(() => result.current.cancel());
    expect(result.current.asking).toBeNull();
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false, sent: false }));
    act(() => result.current.press(decline));
    act(() => result.current.confirm());
    expect(result.current.asking?.busy).toBe(true);
    await waitFor(() => expect(result.current.asking).toBeNull());
    expect(sent).toEqual([{ action: 'decline', target: 'req_12' }]);
    expect(notes).toEqual(['Declined Dune']);
  });

  it('does nothing for a button the viewer may not press', () => {
    const { fetch, wrapper } = setup(() => json({ message: 'x' }, 202));
    const { result } = renderHook(() => useThingButtons(BURROW, THING, () => {}), { wrapper });
    act(() => result.current.press({ ...approve, allowed: false, reason: 'Look only.' }));
    expect(result.current.asking).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the value a switch chose, and says a refusal in the server’s words', async () => {
    const { sent, wrapper } = setup(() =>
      json({ error: { code: 'forbidden', message: 'Look only: Whombat changes nothing here.' } }, 403),
    );
    const notes: [string, string][] = [];
    const { result } = renderHook(() => useThingButtons(BURROW, THING, (m, o) => notes.push([m, o])), {
      wrapper,
    });
    const onDone = vi.fn();
    const toggle: ThingPageButton = {
      action: 'toggle',
      target: 'light.kitchen',
      label: 'Kitchen',
      allowed: true,
    };
    act(() => result.current.press(toggle, { value: true, onDone }));
    expect(result.current.running(toggle, true)).toBe(true);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent).toEqual([{ action: 'toggle', target: 'light.kitchen', value: true }]);
    expect(notes).toEqual([['Look only: Whombat changes nothing here.', 'failed']]);
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ ok: false, sent: true });
  });
});

describe('useControlGuesses (AP-4534)', () => {
  it('keeps a guess until a read after the answer, drops a failed one at once', () => {
    const { result, rerender } = renderHook(({ readAt }) => useControlGuesses(readAt), {
      initialProps: { readAt: 100 },
    });
    act(() => result.current.guess('light.kitchen', true));
    act(() => result.current.guess('light.hall', true));
    expect(result.current.guesses['light.kitchen']?.value).toBe(true);
    act(() => result.current.done('light.kitchen', { ok: true, at: 200 }));
    act(() => result.current.done('light.hall', { ok: false, at: 200 }));
    expect(result.current.guesses['light.hall']).toBeUndefined();
    rerender({ readAt: 150 });
    expect(result.current.guesses['light.kitchen']?.value).toBe(true);
    rerender({ readAt: 250 });
    expect(result.current.guesses['light.kitchen']).toBeUndefined();
  });
});

describe('useStepperDraft (AP-4533)', () => {
  it('moves the figure a step per press and sends the last one once the presses stop', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const stepper = { min: 7, max: 30, step: 0.5 };
    const { result } = renderHook(() => useStepperDraft(21, stepper, send));
    act(() => result.current.step(1));
    act(() => result.current.step(1));
    act(() => result.current.step(1));
    expect(result.current.shown).toBe(22.5);
    expect(result.current.waiting).toBe(true);
    expect(send).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(22.5);
    expect(result.current.waiting).toBe(false);
  });

  it('sends nothing when the presses come back to where it was, and sends a pending figure when it goes', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const stepper = { min: 7, max: 30, step: 0.5 };
    const { result, unmount } = renderHook(() => useStepperDraft(21, stepper, send));
    act(() => result.current.step(1));
    act(() => result.current.step(-1));
    act(() => vi.runAllTimers());
    expect(send).not.toHaveBeenCalled();
    act(() => result.current.step(-1));
    unmount();
    expect(send).toHaveBeenCalledWith(20.5);
  });
});
