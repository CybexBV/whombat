/**
 * The Servers and Connections lists (servers-connections-places.md) from the reads Overview already makes — Home's
 * things, the hosts service's status and fleet — so opening a place or the Places sheet asks nothing new. And the row
 * each place opened last, kept on this phone, which a place opens on from the two-page width when it is still listed.
 */
import { homeThingRows, overviewTiles, type ThingPlace } from '@whombat/client';
import { isHostsUnavailable } from '@whombat/client/hosts';
import { useHostsFleet, useHostsStatus } from '@whombat/client/hosts/react';
import { useHomeOverview } from '@whombat/client/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { STORAGE_KEYS } from '../lib/kv';
import { secureStore } from '../lib/storage';
import { useBurrowBase, useNow } from './BurrowProvider';
import { type PlaceLists, placeLists } from './places';
import { useAgentWords } from './useAgent';

export interface PlaceListsRead extends PlaceLists {
  /** Home's things or the fleet are still being read the first time. */
  loading: Record<ThingPlace, boolean>;
  /** Home's read failed and nothing is known: the list says so (pull down reads again). */
  failed: boolean;
  /** The hosts service can't be reached right now. */
  hostsDown: boolean;
  /** Reads Home and the servers again; settles once every read has answered. */
  refetch: () => Promise<void>;
}

export function usePlaceLists(): PlaceListsRead {
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const assistant = useAgentWords();
  const { rawLocale } = useI18n();
  const home = useHomeOverview({ params: { burrow: slug } });
  const status = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const present = status.data?.present === true;
  const fleet = useHostsFleet(present ? { params: { burrow: slug } } : null, { retry: false });
  const things = home.data?.things;
  const tiles = useMemo(
    () =>
      things
        ? overviewTiles(
            homeThingRows(things, now, timeZone, rawLocale),
            things,
            now,
            timeZone,
            assistant.name,
            rawLocale,
          )
        : null,
    [things, now, timeZone, assistant.name, rawLocale],
  );
  const lists = useMemo(
    () =>
      placeLists({
        things,
        fleet: fleet.data?.servers,
        hosts: present,
        tiles,
        now: now.getTime(),
        timeZone,
        locale: rawLocale,
      }),
    [things, fleet.data?.servers, present, tiles, now, timeZone, rawLocale],
  );
  const refetchHome = home.refetch;
  const refetchFleet = fleet.refetch;
  const refetchStatus = status.refetch;
  const refetch = useCallback(async () => {
    // The hosts service's status too: once it was down, only reading it again finds it back.
    await Promise.allSettled([refetchHome(), refetchStatus(), ...(present ? [refetchFleet()] : [])]);
  }, [refetchHome, refetchFleet, refetchStatus, present]);
  return {
    ...lists,
    // Until its reads have answered or failed a place's rows aren't final, so it doesn't decide what to open from half
    // of them: Connections waits for Home, Servers for Home and the hosts service (its status and, where it runs, the
    // fleet).
    loading: {
      connections: !home.data && !home.error,
      servers:
        (!home.data && !home.error) ||
        (!status.data && !status.error) ||
        (present && !fleet.data && !fleet.error),
    },
    // The hosts service can't be reached, says it isn't well, or its fleet couldn't be read.
    hostsDown:
      isHostsUnavailable(status.error) ||
      (present && !!fleet.error) ||
      (status.data?.present === true && status.data.healthy === false),
    failed: !home.data && !!home.error,
    refetch,
  };
}

const LAST_KEYS: Record<ThingPlace, string> = {
  servers: STORAGE_KEYS.placeServers,
  connections: STORAGE_KEYS.placeConnections,
};

/**
 * The thing id the place opened last, kept on this phone: undefined until the phone said, then the id or null.
 * `keep` remembers the one opened now.
 */
export function useLastInPlace(place: ThingPlace): [string | null | undefined, (thingId: string) => void] {
  const { slug } = useBurrowBase();
  // One per Whombat: another Whombat's server of the same name was never looked at there.
  const key = `${LAST_KEYS[place]}.${slug.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const [last, setLast] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setLast(undefined);
    secureStore.get(key).then(
      (raw) => {
        if (alive) setLast(raw || null);
      },
      () => {
        if (alive) setLast(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [key]);
  const keep = useCallback(
    (thingId: string) => {
      setLast(thingId);
      void secureStore.set(key, thingId).catch(() => {});
    },
    [key],
  );
  return [last, keep];
}
