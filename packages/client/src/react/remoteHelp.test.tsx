// @vitest-environment jsdom
/**
 * Remote help's hook (remote-help.md AP-4443) against the fake: off, turned on through the dialog, a visit that shows,
 * a refusal in words, and Stop.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { RemoteHelpApi } from '../managed/remote-help';
import { createFakeRemoteHelp, type FakeRemoteHelpCaller } from '../managed/remote-help-fake';
import { OperationError } from '../session/managed-ops';
import { useRemoteHelp } from './remoteHelp';

const ME = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const caller: FakeRemoteHelpCaller = {
  accountId: 'acc_mara',
  name: 'Mara',
  endpoint: ME,
  passkeys: [],
};

function api(fake: ReturnType<typeof createFakeRemoteHelp>): RemoteHelpApi {
  const call = async (op: string, input: unknown = {}) => {
    const r = fake.call(op, input, caller);
    if (r.status >= 300) {
      const e = (r.body as { error: { code: string; message: string; details?: unknown } }).error;
      throw new OperationError(op, r.status, e.code, e.message, e.details);
    }
    return r.body as never;
  };
  return {
    get: () => call('remoteHelp.get'),
    confirmBegin: (choice) => call('remoteHelp.confirmBegin', choice),
    start: (input) => call('remoteHelp.start', input),
    stop: () => call('remoteHelp.stop'),
    visits: async (input) => ((await call('remoteHelp.visits', input ?? {})) as { visits: never[] }).visits,
    transcript: async () => {
      throw new Error('not here');
    },
    hasPasskey: async () => false,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe('useRemoteHelp', () => {
  it('turns it on with the dialog, lists a visit, words a refusal and stops', async () => {
    const fake = createFakeRemoteHelp();
    const { result } = renderHook(() => useRemoteHelp(api(fake)), { wrapper });
    await waitFor(() => expect(result.current.state?.grant).toBeNull());
    expect(result.current.hasPasskey).toBe(false);
    expect(result.current.visits).toEqual([]);

    const deps = { platform: null, endpoint: ME, confirm: async () => true };
    await act(async () => {
      expect(await result.current.turnOn({ level: 'fix', duration: 'day' }, deps)).toBe(true);
    });
    expect(result.current.state?.grant?.level).toBe('fix');

    fake.visit({ who: 'Claude' });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.visits?.[0]?.who).toBe('Claude'));

    fake.setEnvironment('prod');
    await act(async () => {
      expect(await result.current.turnOn({ level: 'fix', duration: 'forever' }, deps)).toBe(false);
    });
    expect(result.current.problem).toBe('Forever is only for test Whombats.');

    await act(async () => {
      expect(await result.current.stop()).toBe(true);
    });
    expect(result.current.state?.grant).toBeNull();
    expect(result.current.problem).toBeNull();
  });
});
