// @vitest-environment jsdom
/**
 * The desk's hooks (desk-display-web.md AP-3001, AP-3002): `desk.get` under its endpoint key, a change shown at once and
 * put back when refused, the unlock request gone once answered or expired.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../query/keys';
import type { DeskScreen, DeskVoice } from './contract';
import { createFakeDesk, type FakeDeskPerson, fakeDeskApi } from './fake';
import { DESK_TEXT } from './model';
import { DESK_QUERY_KEY, useDesk, useDeskActions, useDeskListen, useDeskUnlockRequest } from './react';

const JOHN: FakeDeskPerson = { personId: 'prn_john', name: 'John' };

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const desk = createFakeDesk();
  desk.call('desk.startPairing', {}, JOHN);
  desk.call('desk.pair', { code: desk.letters(), pin: '246810' }, JOHN);
  return { qc, wrapper, desk, api: fakeDeskApi(desk, JOHN) };
}

describe('desk hooks', () => {
  it('reads desk.get where `desk.changed` refetches it', async () => {
    const { qc, wrapper, api } = setup();
    const { result } = renderHook(() => useDesk(api), { wrapper });
    await waitFor(() => expect(result.current.data?.paired?.name).toBe('John'));
    expect(qc.getQueryCache().findAll({ queryKey: queryKeys.scope('desk.get') })).toHaveLength(1);
  });

  it('waits without a desk', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useDesk(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('shows a change at once and puts it back when refused', async () => {
    const { qc, wrapper, api } = setup();
    const { result } = renderHook(() => ({ desk: useDesk(api), actions: useDeskActions(api) }), { wrapper });
    await waitFor(() => expect(result.current.desk.data).toBeDefined());
    await act(() => result.current.actions.update({ lockedView: 'everything' }));
    expect(qc.getQueryData<{ settings: { lockedView: string } }>(DESK_QUERY_KEY)?.settings.lockedView).toBe(
      'everything',
    );
    const refusing = { ...api, update: () => Promise.reject(new Error('no')) };
    const { result: other } = renderHook(() => useDeskActions(refusing), { wrapper });
    await act(() => expect(other.current.update({ lockedView: 'time' })).rejects.toThrow());
    expect(qc.getQueryData<{ settings: { lockedView: string } }>(DESK_QUERY_KEY)?.settings.lockedView).toBe(
      'everything',
    );
  });

  it('moves the switch at once, takes the pairing from the answer, and puts it back when refused', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const desk = createFakeDesk({
      display: { connected: true, real: false, builtIn: false, name: 'QEMU Monitor' },
    });
    const api = fakeDeskApi(desk, JOHN);
    const { result } = renderHook(() => ({ desk: useDesk(api), actions: useDeskActions(api) }), { wrapper });
    await waitFor(() => expect(result.current.desk.data?.on).toBe(false));
    await act(() => result.current.actions.setScreen(true));
    expect(qc.getQueryData<DeskScreen>(DESK_QUERY_KEY)?.paired?.name).toBe('John');

    let seen: boolean | undefined;
    const refusing = {
      ...api,
      setScreen: () => {
        seen = qc.getQueryData<DeskScreen>(DESK_QUERY_KEY)?.on;
        return Promise.reject(new Error('no'));
      },
    };
    const { result: other } = renderHook(() => useDeskActions(refusing), { wrapper });
    await act(() => expect(other.current.setScreen(false)).rejects.toThrow());
    expect(seen).toBe(false);
    expect(qc.getQueryData<DeskScreen>(DESK_QUERY_KEY)?.on).toBe(true);
  });

  it('drops the unlock request once answered', async () => {
    const { wrapper, api, desk } = setup();
    desk.requestUnlock();
    const { result } = renderHook(
      () => ({ request: useDeskUnlockRequest(api), actions: useDeskActions(api) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.request).not.toBeNull());
    await act(() =>
      result.current.actions.answerUnlock({ id: result.current.request?.id as string, unlock: true }),
    );
    await waitFor(() => expect(result.current.request).toBeNull());
    expect(desk.unlocked()).toBe(true);
  });

  it('Listen: one sample at a time, again from memory, stopped when pressed again; a failure in words', async () => {
    const desk = createFakeDesk({ hardware: { voices: ['heart', 'bella', 'george'] } });
    desk.call('desk.startPairing', {}, JOHN);
    desk.call('desk.pair', { code: desk.letters(), pin: '246810' }, JOHN);
    const base = fakeDeskApi(desk, JOHN);
    const asked: DeskVoice[] = [];
    const api = {
      ...base,
      voiceSample: (voice: DeskVoice) => {
        asked.push(voice);
        return base.voiceSample(voice);
      },
    };
    // Playing lasts until the test ends it, or until it is stopped.
    const plays: { wav: Uint8Array; signal: AbortSignal; end: () => void }[] = [];
    const play = (wav: Uint8Array, signal: AbortSignal) =>
      new Promise<void>((end) => {
        plays.push({ wav, signal, end });
        signal.addEventListener('abort', () => end());
      });
    const failed: string[] = [];
    const { result } = renderHook(() =>
      useDeskListen(api, { assistant: 'Neo', play, onFailed: (t) => failed.push(t) }),
    );
    act(() => result.current.toggle('heart'));
    expect(result.current.playing).toBe('heart');
    await waitFor(() => expect(plays).toHaveLength(1));
    // Another voice stops the first.
    act(() => result.current.toggle('bella'));
    expect(plays[0]?.signal.aborted).toBe(true);
    expect(result.current.playing).toBe('bella');
    await waitFor(() => expect(plays).toHaveLength(2));
    act(() => plays[1]?.end());
    await waitFor(() => expect(result.current.playing).toBeNull());
    // Heart again: from memory, not from the box.
    act(() => result.current.toggle('heart'));
    await waitFor(() => expect(plays).toHaveLength(3));
    expect(asked).toEqual(['heart', 'bella']);
    // Pressed again while it plays: stops.
    act(() => result.current.toggle('heart'));
    expect(plays[2]?.signal.aborted).toBe(true);
    expect(result.current.playing).toBeNull();
    expect(failed).toEqual([]);
    // A voice the box doesn't list: its words; a device that can't play: “couldn’t play”.
    act(() => result.current.toggle('emma'));
    await waitFor(() => expect(failed).toHaveLength(1));
    expect(failed[0]).toContain('voice');
    const { result: broken } = renderHook(() =>
      useDeskListen(api, {
        assistant: 'Neo',
        play: () => Promise.reject(new Error('NotAllowedError')),
        onFailed: (t) => failed.push(t),
      }),
    );
    act(() => broken.current.toggle('george'));
    await waitFor(() => expect(failed).toHaveLength(2));
    expect(failed[1]).toBe(DESK_TEXT.sampleFailed);
    expect(broken.current.playing).toBeNull();
  });
});
