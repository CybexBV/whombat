/**
 * Update for Docker Compose apps (Whombat app-updates.md): the box asks through the approval card, the same one the
 * assistant's update brings, and answers its number; the card opens over this page (`?approval=`). Nothing runs before
 * the yes.
 */
import { useHostsChange } from '@whombat/client/hosts/react';
import { useSessionProtocol } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { APP_UPDATES_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { useCallback } from 'react';
import { useSearchUpdate } from '../../../app/routing/navigation';
import { useChangeRunner } from '../parts';

/**
 * Whether this Whombat updates Compose apps (session minor 22). An older box sends no apps, and its servers' helpers
 * aren't what is old: the page says nothing about app updates then. Without a session the page is its own box's.
 */
export function useAppUpdatesOn(): boolean {
  const protocol = useSessionProtocol();
  return protocol === null || protocolAtLeast(protocol, APP_UPDATES_MINOR);
}

export function useAppUpdate(burrow: string, serverId: string) {
  const change = useHostsChange(api.hosts.manage);
  const { run, busy } = useChangeRunner();
  const updateSearch = useSearchUpdate();
  const ask = useCallback(
    async (apps: string[]) => {
      const out = await run(
        () =>
          change.mutateAsync({
            params: { burrow, serverId },
            body: { op: 'app.update', platform: 'host', params: { apps } },
          }),
        null,
      );
      const n = out.ok ? out.data.approvalNumber : undefined;
      if (n != null) void updateSearch((prev) => ({ ...prev, approval: n }));
    },
    [run, change, burrow, serverId, updateSearch],
  );
  return { ask, busy };
}
