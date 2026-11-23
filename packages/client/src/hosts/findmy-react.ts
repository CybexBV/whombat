/**
 * Find My on a Mac's page in React (docs/implementation/macos/findmy.md §5), the same on the web and the phone: what
 * Whombat read last, asked again every couple of seconds while a read or a picture is under way; a read when the tab
 * opens on an old read and every quarter of an hour while it stays open; the exact picture of one person; and the map,
 * drawn by the Mac at the card's size. The map and the pictures are larger than one session message, so the session
 * reads them through an export stream by itself.
 */
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { api } from '@whombat/core/contracts';
import {
  HOST_FIND_MY_POLL_MS,
  HOST_FIND_MY_REFRESH_MS,
  type HostFindMy,
  type HostFindMyMap,
} from '@whombat/core/domain';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MacChoice } from '../connections/choices';
import type { CommitResult } from '../http/types';
import { queryKeys } from '../query/keys';
import { useWhombat } from '../react/context';
import { queryHook, useCatalogConnections } from '../react/queries';
import { commitOutcomeText, hostErrorInfo } from './errors';
import {
  type FindMyConnectionLink,
  type FindMyRegion,
  findMyAtHome,
  findMyConnectionOf,
  findMyMacs,
  findMyMapQuery,
  findMyPolls,
  findMyStale,
} from './findmy';
import { isMacServer } from './macos';

const useFindMyRead = queryHook(api.hosts.findMy);
const useFleet = queryHook(api.hosts.fleet);
/** The Mac's map picture (`hosts.findMyMap`), an export read. `useFindMyMap` keeps the last one on screen. */
export const useHostFindMyMap = queryHook(api.hosts.findMyMap);
/** Find My's own map of one person (`hosts.findMyPicture`), an export read. `useFindMyPicture` follows `exact`. */
export const useHostFindMyPicture = queryHook(api.hosts.findMyPicture);

/** What Whombat read last from a Mac's Find My, asked again every 2 s while a read or a picture is under way. */
export function useHostFindMy(burrow: string, serverId: string | null) {
  return useFindMyRead(serverId ? { params: { burrow, serverId } } : null, {
    retry: false,
    refetchInterval: (q) => (findMyPolls(q.state.data) ? HOST_FIND_MY_POLL_MS : false),
  });
}

type Ask = { kind: 'refresh' } | { kind: 'exact'; person: string };

/**
 * `hosts.findMyRefresh` and `hosts.findMyExact`: each answers the whole state, which replaces the cached read at once,
 * so the 2-second asking starts without waiting for the next read.
 */
export function useHostFindMyAsk(burrow: string, serverId: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<HostFindMy>, Error, Ask>({
    mutationFn: (ask) => {
      const params = { burrow, serverId };
      return ask.kind === 'refresh'
        ? client.request(api.hosts.findMyRefresh, { params, body: {} })
        : client.request(api.hosts.findMyExact, { params, body: { person: ask.person } });
    },
    onSuccess: (result) => {
      if (result.status === 'ok')
        qc.setQueryData(queryKeys.endpoint(api.hosts.findMy, { params: { burrow, serverId } }), result.data);
    },
  });
}

export interface FindMyTabState {
  /** What was read last; undefined until the first answer. */
  state: HostFindMy | undefined;
  /** The read itself failed (an older box, the session down). */
  error: Error | null;
  /** A refresh request is on its way (not the read on the Mac: `state.reading`). */
  asking: boolean;
  /** Read again now; resolves to why it couldn't start, or null. */
  readNow: () => Promise<string | null>;
  /** Take the exact picture of one person; resolves to why it couldn't start, or null. */
  showExactly: (person: string) => Promise<string | null>;
}

/**
 * The Find My tab's reads: the state, a read when the tab opens and the last read is older than two minutes (once the
 * Mac's screen can be used), again every 15 minutes while it stays open, and a new map once a read brought new places.
 * `clock` is the app's (the phone's demo world runs its own).
 */
export function useFindMyTab({
  burrow,
  serverId,
  canRead,
  clock = Date.now,
}: {
  burrow: string;
  serverId: string;
  canRead: boolean;
  clock?: () => number;
}): FindMyTabState {
  const read = useHostFindMy(burrow, serverId);
  const ask = useHostFindMyAsk(burrow, serverId);
  const qc = useQueryClient();
  const mutate = useRef(ask.mutateAsync);
  mutate.current = ask.mutateAsync;

  const run = useCallback(async (a: Ask): Promise<string | null> => {
    try {
      const result = await mutate.current(a);
      return commitOutcomeText(result);
    } catch (error) {
      return hostErrorInfo(error).message;
    }
  }, []);
  const readNow = useCallback(() => run({ kind: 'refresh' }), [run]);
  const showExactly = useCallback((person: string) => run({ kind: 'exact', person }), [run]);

  // Once a tab opening: when the state is known and the screen can be used (it may come to be while the tab is open).
  const opened = useRef(false);
  const data = read.data;
  const now = useRef(clock);
  now.current = clock;
  useEffect(() => {
    if (opened.current || !canRead || !data) return;
    opened.current = true;
    if (findMyStale(data, now.current())) void readNow();
  }, [canRead, data, readNow]);

  useEffect(() => {
    if (!canRead) return;
    const t = setInterval(() => void readNow(), HOST_FIND_MY_REFRESH_MS);
    return () => clearInterval(t);
  }, [canRead, readNow]);

  // New places draw a new map (the Mac keeps one for a minute, so an unchanged read costs nothing).
  const readAt = data?.readAt ?? null;
  const lastReadAt = useRef(readAt);
  useEffect(() => {
    if (readAt === lastReadAt.current) return;
    lastReadAt.current = readAt;
    void qc.invalidateQueries({ queryKey: queryKeys.scope(api.hosts.findMyMap, { burrow, serverId }) });
  }, [readAt, qc, burrow, serverId]);

  return { state: data, error: read.error, asking: ask.isPending, readNow, showExactly };
}

export interface FindMyMapState {
  /** The picture on screen with the size it was asked at (its points are in that size). */
  shown: { map: HostFindMyMap; ask: { w: number; h: number } } | null;
  /** A new picture is being drawn (the last one stays meanwhile). */
  drawing: boolean;
  error: Error | null;
}

/**
 * The map at `ask` points in the app's theme, around `region` once someone zoomed (null: the Mac fits everyone). While
 * a new one is drawn — a zoom, a theme, a wider card — the last picture stays on screen.
 */
export function useFindMyMap({
  burrow,
  serverId,
  ask,
  dark,
  region,
  enabled,
}: {
  burrow: string;
  serverId: string;
  ask: { w: number; h: number } | null;
  dark: boolean;
  region: FindMyRegion | null;
  enabled: boolean;
}): FindMyMapState {
  const q = useHostFindMyMap(
    enabled && ask ? { params: { burrow, serverId }, query: findMyMapQuery(ask, dark, region) } : null,
    // The Mac keeps a drawn map for a minute.
    { retry: false, staleTime: 60_000 },
  );
  const last = useRef<FindMyMapState['shown']>(null);
  if (q.data && ask && last.current?.map !== q.data) last.current = { map: q.data, ask };
  if (!enabled) last.current = null;
  return { shown: last.current, drawing: q.isFetching, error: q.error };
}

/**
 * The exact picture of `person` once `state.exact` says it is ready; nothing while it is taken. Not kept once nobody
 * looks (a new “Show exactly” fetches the new picture, never the one before).
 */
export function useFindMyPicture({
  burrow,
  serverId,
  state,
  person,
}: {
  burrow: string;
  serverId: string;
  state: HostFindMy | undefined;
  person: string | null;
}) {
  const e = state?.exact;
  const ready = !!person && e?.person === person && e.state === 'ready';
  return useHostFindMyPicture(ready && person ? { params: { burrow, serverId }, query: { person } } : null, {
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
}

/**
 * The Find My connection that reads Find My on the Mac `serverId`, for the one link on the Mac's page (its `mac` field,
 * from the connections list); null while the list is read, when it can't be, or when none does.
 */
export function useFindMyConnectionOf(burrow: string, serverId: string | null): FindMyConnectionLink | null {
  const list = useCatalogConnections(serverId ? { params: { burrow } } : null, { retry: false });
  const connections = list.data?.connections;
  return useMemo(
    () => (serverId ? findMyConnectionOf(connections, serverId) : null),
    [connections, serverId],
  );
}

/**
 * Who the Find My connections' last reads have at Home, by name, for the Automations page's ideas: what each Mac's
 * Find My holds now (never a read of its own, so nobody's screen is taken for an idea). Empty until known.
 */
export function useFindMyHome(burrow: string): string[] {
  const { queries } = useWhombat();
  const list = useCatalogConnections({ params: { burrow } }, { retry: false });
  const macs = [...new Set(findMyMacs(list.data?.connections).map((m) => m.serverId))];
  const reads = useQueries({
    queries: macs.map((serverId) => ({
      ...queries.endpoint(api.hosts.findMy, { params: { burrow, serverId } }),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const stamp = reads.map((r) => r.dataUpdatedAt).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reads' answers are keyed by `stamp`
  return useMemo(() => {
    const names = reads.flatMap((r) => (r.data as HostFindMy | undefined)?.people ?? []);
    return [...new Set(names.filter(findMyAtHome).map((p) => p.name))];
  }, [stamp]);
}

/**
 * The person's Macs as the choices of a Find My connection's Mac (findmy-connection.md §2.1), from the servers Whombat
 * watches, by the name the person sees; null until the fleet answers (or when `enabled` is false).
 */
export function useMacChoices(burrow: string, enabled = true): MacChoice[] | null {
  const fleet = useFleet(enabled ? { params: { burrow } } : null, { retry: false });
  const servers = fleet.data?.servers;
  return useMemo(
    () =>
      servers
        ? servers.filter((server) => isMacServer({ server })).map((s) => ({ id: s.id, name: s.name ?? s.id }))
        : null,
    [servers],
  );
}
