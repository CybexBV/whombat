import { useHostsFleet, useHostsLive, useHostsStatus } from '@whombat/client/hosts/react';
import { useBurrowContext } from '../../messaging/useRoom';

/** The fleet as the Servers list reads it: the same queries as the sidebar, so one request each. */
export function useServerFleet(burrow: string) {
  const { bootstrap } = useBurrowContext(burrow);
  useHostsLive(bootstrap?.burrow.id);
  const status = useHostsStatus({ params: { burrow } }, { retry: false });
  const present = status.data?.present === true;
  const fleet = useHostsFleet(present ? { params: { burrow }, query: {} } : null, { retry: 1 });
  return { status, present, fleet, servers: fleet.data?.servers ?? null };
}
