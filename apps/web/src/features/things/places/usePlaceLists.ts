/**
 * The Servers and Connections lists (servers-connections-places.md) from the reads Overview already
 * makes — Home's things and its tiles, the hosts fleet — so a place asks nothing new. The rows and their words are the
 * shared `serverPlaceRows` and `connectionPlaceRows`; this only gathers their inputs.
 */
import {
  connectionPlaceRows,
  homeSection,
  homeSections,
  overviewTiles,
  type PlaceRow,
  serverPlaceRows,
  serverQuietWords,
  type ThingPlace,
  thingRows,
} from '@whombat/client';
import { addServerHref, isHostsUnavailable } from '@whombat/client/hosts';
import { useHomeOverview, useTheAgent } from '@whombat/client/react';
import { useMemo } from 'react';
import { ADD_CONNECTION_HREF } from '../../../app/shell/assistantSidebarModel';
import { useOverviewFleet } from '../../home/OverviewServers';
import { useBurrowContext, useNow } from '../../messaging/useRoom';

export interface PlaceLists {
  servers: PlaceRow[];
  connections: PlaceRow[];
  /** Home has answered: until then a page isn't known to be in a place. */
  known: boolean;
  /**
   * Each place's rows are final: Home has answered or failed, and for Servers the hosts service's status and (where
   * it runs) the fleet too. Connections doesn't wait for the hosts service.
   */
  settled: Record<ThingPlace, boolean>;
  /** Home's read failed and nothing is known: the list says so, with Retry. */
  failed: boolean;
  /** The hosts service can't be reached: an empty Servers says so rather than “No servers yet.”. */
  hostsDown: boolean;
  /** Read Home and the servers again. */
  retry: () => void;
  /** Add a server (on Overview's Servers section) with the hosts service; else null. */
  addServer: string | null;
  /** Add a connection, for whoever may add one; else null. */
  addConnection: string | null;
}

export function usePlaceLists(burrow: string): PlaceLists {
  const { me, timeZone } = useBurrowContext(burrow);
  const now = useNow(30_000);
  const hosts = useOverviewFleet(burrow);
  const home = useHomeOverview({ params: { burrow } }, { retry: false });
  const { data } = home;
  const homeFailed = !data && !!home.error;
  const refetchHome = home.refetch;
  const refetchFleet = hosts.fleet.refetch;
  const refetchStatus = hosts.status.refetch;
  const hostsPresent = hosts.present;
  const hostsDown =
    isHostsUnavailable(hosts.status.error) ||
    (hosts.present && !!hosts.fleet.error) ||
    // Without the hosts service there is nothing to reach: not an outage.
    (hosts.status.data?.present === true && hosts.status.data.healthy === false);
  const { agent } = useTheAgent(burrow);
  const canAdd = me?.kind === 'person';
  const agentName = agent?.name ?? null;
  const hostsSettled =
    (!!hosts.status.data || !!hosts.status.error) &&
    (!hosts.present || !!hosts.fleet.data || !!hosts.fleet.error);
  return useMemo(() => {
    const things = data?.things ?? [];
    const rows = thingRows(things);
    const serverIds = new Set(things.filter((t) => t.kind === 'server').map((t) => t.id));
    const serverRows = rows.filter((r) => serverIds.has(r.id));
    const connectionRows = rows.filter((r) => !serverIds.has(r.id));
    const sections = data
      ? homeSections(data, { now, timeZone, servers: hosts.present, canAddConnection: canAdd })
      : [];
    const tileRows = homeSection(sections, 'things')?.rows ?? [];
    const tiles = data ? overviewTiles(tileRows, things, now, timeZone, agentName) : null;
    return {
      servers: serverPlaceRows(
        hosts.servers,
        serverRows,
        now,
        timeZone,
        serverQuietWords(things, now, timeZone),
      ),
      connections: connectionPlaceRows(connectionRows, tiles),
      known: !!data,
      settled: { servers: (!!data || homeFailed) && hostsSettled, connections: !!data || homeFailed },
      failed: homeFailed,
      hostsDown,
      retry: () => {
        void refetchHome();
        void refetchStatus();
        if (hostsPresent) void refetchFleet();
      },
      addServer: hosts.present ? addServerHref().replace('?', '?tab=servers&') : null,
      addConnection: canAdd ? ADD_CONNECTION_HREF : null,
    };
  }, [
    data,
    homeFailed,
    refetchHome,
    refetchFleet,
    refetchStatus,
    hostsPresent,
    hostsDown,
    hosts.servers,
    hosts.present,
    hostsSettled,
    now,
    timeZone,
    canAdd,
    agentName,
  ]);
}
