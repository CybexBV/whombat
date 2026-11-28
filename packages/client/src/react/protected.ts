/**
 * What's protected and restore tests (Whombat backup-trust.md; `protected.get`, `restoreTests.set`, `restoreTests.run`):
 * the page's one read, the switch per Proxmox server and *Test one now*. A Whombat before session minor 22 has none
 * of them: the links to the page stay hidden there.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ProtectedView, type RestoreTestServer } from '@whombat/core';
import { PROTECTED_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import type { CommitResult } from '../http/types';
import { queryKeys } from '../query/keys';
import { useSessionProtocol, useWhombat } from './context';
import { queryHook } from './queries';

/** Everything that holds data and where its copies are. */
export const useProtectedView = queryHook(api.protected.get);

/** Whether this Whombat has the page. */
export function useProtectedSupported(): boolean {
  return protocolAtLeast(useSessionProtocol(), PROTECTED_MINOR);
}

/** The view after a change: the server's tests as the Whombat answered, the rest read again. */
function useAfterChange(burrow: string) {
  const qc = useQueryClient();
  return (result: CommitResult<RestoreTestServer>) => {
    const key = queryKeys.endpoint(api.protected.get, { params: { burrow } });
    if (result.status === 'ok')
      qc.setQueryData<ProtectedView>(key, (old) =>
        old
          ? {
              ...old,
              restoreTests: old.restoreTests.map((s) =>
                s.serverId === result.data.serverId ? result.data : s,
              ),
            }
          : old,
      );
    void qc.invalidateQueries({ queryKey: key });
  };
}

/** Turn a server's weekly restore tests on or off, and choose its machines (none chosen: all). */
export function useSetRestoreTests(burrow: string) {
  const { client } = useWhombat();
  const after = useAfterChange(burrow);
  return useMutation<
    CommitResult<RestoreTestServer>,
    Error,
    { serverId: string; on: boolean; guests?: string[] }
  >({
    mutationFn: ({ serverId, on, guests }) =>
      client.request(api.restoreTests.set, {
        params: { burrow, serverId },
        body: { on, ...(guests ? { guests } : {}) },
      }),
    onSuccess: after,
  });
}

/** Test one machine now (`guest`), else the one whose turn it is. */
export function useRunRestoreTest(burrow: string) {
  const { client } = useWhombat();
  const after = useAfterChange(burrow);
  return useMutation<CommitResult<RestoreTestServer>, Error, { serverId: string; guest?: string }>({
    mutationFn: ({ serverId, guest }) =>
      client.request(api.restoreTests.run, {
        params: { burrow, serverId },
        body: guest ? { guest } : {},
      }),
    onSuccess: after,
  });
}
