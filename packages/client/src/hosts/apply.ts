/**
 * Servers' realtime frames on the cache (topic `hosts:<burrowId>`, contracts 0.80 CT-339; AP-1304). A frame that
 * carries the new state patches it in place, so a server's row, a guest's dot and Home's Servers card move without a
 * refetch; the reads a frame can't patch refetch. `query/apply.ts` hands the `hosts.*` events here.
 */
import type { QueryClient } from '@tanstack/query-core';
import type {
  HostFleet,
  HostGuest,
  HostGuestDetail,
  HostGuestPage,
  HostGuestState,
  HostServerDetail,
  RealtimeEventOf,
} from '@whombat/core';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';

/** Every read a `hosts.resync` refetches. */
export const HOSTS_READS = [
  'hosts.status',
  'hosts.fleet',
  'hosts.getServer',
  'hosts.serverMetrics',
  'hosts.serverSettings',
  'hosts.listGuests',
  'hosts.getGuest',
  'hosts.guestMetrics',
  'hosts.manageRead',
  'hosts.getTask',
  'hosts.listAlerts',
  'hosts.listMaintenance',
  'hosts.listChecks',
  'hosts.listEnrollments',
  'home.overview',
  'watch.list',
] as const;

export function invalidateHosts(qc: QueryClient, endpoints: readonly string[]): true {
  for (const id of endpoints) void qc.invalidateQueries({ queryKey: queryKeys.scope(id) });
  return true;
}

/** A server's row changed (or went: `server` null). */
export function applyHostServer(qc: QueryClient, e: RealtimeEventOf<'hosts.server'>): true {
  patchEndpoint<HostFleet>(qc, 'hosts.fleet', (d) => {
    if (!Array.isArray(d?.servers)) return d;
    const at = d.servers.findIndex((s) => s.id === e.serverId);
    if (!e.server) return at < 0 ? d : { ...d, servers: d.servers.filter((s) => s.id !== e.serverId) };
    if (at < 0) return { ...d, servers: [...d.servers, e.server] };
    const servers = d.servers.slice();
    servers[at] = e.server;
    return { ...d, servers };
  });
  // The fleet's totals and the page (sensors, disks, guests) refetch behind the patched row.
  void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.fleet') });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.getServer', { serverId: e.serverId }) });
  // Its agent's version and update (agent-updates-app.md AP-2985): the owner's Updates row follows a rollout.
  void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.serverSettings', { serverId: e.serverId }) });
  if (!e.server) void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.status') });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
  return true;
}

function withState<G extends HostGuest>(g: G, guestId: string, state: HostGuestState): G {
  if (g.id !== guestId || g.state === state) return g;
  const on = state === 'running' || state === 'unhealthy';
  return on ? { ...g, state } : { ...g, state, cpuPct: null, memoryUsedMb: null };
}

/** A guest's power state changed: its dot moves at once everywhere, then the numbers refetch. */
export function applyHostGuest(qc: QueryClient, e: RealtimeEventOf<'hosts.guest'>): true {
  const { serverId, guestId, state } = e;
  patchEndpoint<HostGuestPage>(qc, 'hosts.listGuests', (d) => {
    if (
      !Array.isArray(d?.guests) ||
      !d.guests.some((g) => g.id === guestId && g.serverId === serverId && g.state !== state)
    )
      return d;
    return {
      ...d,
      guests: d.guests.map((g) => (g.serverId === serverId ? withState(g, guestId, state) : g)),
    };
  });
  patchEndpoint<HostGuestDetail>(
    qc,
    'hosts.getGuest',
    (d) => (d?.serverId === serverId ? withState(d, guestId, state) : d),
    undefined,
  );
  patchEndpoint<HostServerDetail>(qc, 'hosts.getServer', (d) => {
    if (d?.server?.id !== serverId) return d;
    const map = <W extends { guests: HostGuest[] } | undefined>(w: W): W =>
      w?.guests.some((g) => g.id === guestId)
        ? { ...w, guests: w.guests.map((g) => withState(g, guestId, state)) }
        : w;
    return {
      ...d,
      ...(d.proxmox
        ? {
            proxmox: {
              ...d.proxmox,
              guests: { vm: map(d.proxmox.guests.vm), container: map(d.proxmox.guests.container) },
            },
          }
        : {}),
      ...(d.workloads
        ? {
            workloads: Object.fromEntries(
              Object.entries(d.workloads).map(([k, w]) => [k, map(w)]),
            ) as typeof d.workloads,
          }
        : {}),
    };
  });
  return invalidateHosts(qc, ['hosts.listGuests', 'hosts.getGuest', 'hosts.getServer', 'hosts.fleet']);
}

/** The `hosts.*` frames, for `query/apply.ts`. */
export const HOSTS_APPLIERS = {
  'hosts.server': (qc: QueryClient, e: RealtimeEventOf<'hosts.server'>) => applyHostServer(qc, e),
  'hosts.guest': (qc: QueryClient, e: RealtimeEventOf<'hosts.guest'>) => applyHostGuest(qc, e),
  'hosts.alert': (qc: QueryClient) =>
    invalidateHosts(qc, [
      'hosts.listAlerts',
      'hosts.fleet',
      'hosts.getServer',
      'home.overview',
      'watch.list',
    ]),
  'hosts.task': (qc: QueryClient) =>
    invalidateHosts(qc, [
      'hosts.listGuests',
      'hosts.getGuest',
      'hosts.getServer',
      'hosts.manageRead',
      'hosts.getTask',
      'hosts.fleet',
    ]),
  'hosts.enrollment': (qc: QueryClient) =>
    invalidateHosts(qc, ['hosts.listEnrollments', 'hosts.fleet', 'hosts.status', 'home.overview']),
  'hosts.resync': (qc: QueryClient) => invalidateHosts(qc, HOSTS_READS),
  // Sign in once (server-signin.md SI-02): a job moved on; a finished one may have added a server.
  'hosts.install': (qc: QueryClient) =>
    invalidateHosts(qc, ['hosts.getInstall', 'hosts.fleet', 'hosts.listEnrollments', 'home.overview']),
  // Point them here (contracts 0.117, CT-911; BF-15, BF-16; AP-4415): a repoint job moved on; a server it pointed here
  // leaves the address change's waiting list and Needs you.
  'hosts.repoint': (qc: QueryClient) =>
    invalidateHosts(qc, ['hosts.getRepoint', 'hosts.addressChange', 'hosts.fleet', 'home.overview']),
} as const;
