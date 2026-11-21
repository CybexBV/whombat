// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApplianceSession, ConnectionState, SessionInfo } from '../session/types';
import type { ApplianceSummary } from './control';
import { useDirectoryEntry, useLeaveWhenGone, useOpenWhenLetIn } from './react';

/** A session whose state the test moves. */
function sessionAt(initial: ConnectionState) {
  let state = initial;
  const listeners = new Set<(s: ConnectionState) => void>();
  const session = {
    state: () => state,
    onState: (l: (s: ConnectionState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as ApplianceSession;
  const move = (next: ConnectionState) => {
    state = next;
    for (const l of listeners) l(next);
  };
  return { session, move };
}

const openOn = (channel: SessionInfo['channel'], accountId: string | null): ConnectionState => ({
  status: 'open',
  info: {
    channel,
    account: accountId ? { id: accountId, name: 'Mara', principals: [] } : null,
  } as SessionInfo,
});

const summary = (device: string): ApplianceSummary => ({
  device,
  orgId: 'org_1',
  name: 'Burrow HQ',
  state: 'claimed',
  contentPeerId: 'peer',
  lastSeenAt: null,
  revocationsPending: 0,
});

describe('the managed app’s shared hooks', () => {
  it('leaves a Whombat once control says it is retired or gone', () => {
    const { session, move } = sessionAt({ status: 'connecting', attempt: 1 });
    const onGone = vi.fn();
    renderHook(() => useLeaveWhenGone(session, onGone));
    expect(onGone).not.toHaveBeenCalled();
    act(() => move({ status: 'closed', reason: 'appliance_retired' }));
    expect(onGone).toHaveBeenCalledWith('retired');
    renderHook(() => useLeaveWhenGone(null, onGone));
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('opens a Whombat that let this device in already, once', () => {
    const { session, move } = sessionAt(openOn('enroll', null));
    const onIn = vi.fn();
    renderHook(() => useOpenWhenLetIn(session, onIn));
    expect(onIn).not.toHaveBeenCalled();
    act(() => move(openOn('app', 'acc_mara')));
    act(() => move(openOn('app', 'acc_mara')));
    expect(onIn).toHaveBeenCalledTimes(1);
    expect(onIn).toHaveBeenCalledWith('acc_mara');
  });

  it('finds a Whombat in the directory, or says it is missing or unreachable', async () => {
    const appliances = vi.fn(async () => [summary('dev_a')]);
    const env = { control: { appliances } };
    const found = renderHook(() => useDirectoryEntry(env, 'org_1', 'dev_a'));
    expect(found.result.current).toBeNull();
    await waitFor(() => expect(found.result.current).toMatchObject({ device: 'dev_a' }));
    expect(appliances).toHaveBeenCalledWith('org_1');
    const missing = renderHook(() => useDirectoryEntry(env, 'org_1', 'dev_b'));
    await waitFor(() => expect(missing.result.current).toBe('missing'));
    const down = { control: { appliances: async () => Promise.reject(new Error('offline')) } };
    const unreachable = renderHook(() => useDirectoryEntry(down, 'org_1', 'dev_a'));
    await waitFor(() => expect(unreachable.result.current).toBe('unreachable'));
  });
});
