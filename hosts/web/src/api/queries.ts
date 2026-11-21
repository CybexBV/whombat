// TanStack Query hooks. Live data refreshes every 10 s (G3); chart series for
// ranges longer than 6 h refresh at their bucket size. Previous data stays on
// screen while a new range or group loads (no flicker, focus and scroll kept).

import { keepPreviousData, useInfiniteQuery, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from './client';
import type {
  AgentInfo,
  Alert,
  Annotation,
  AuthState,
  Check,
  Fleet,
  FleetSeries,
  GuestList,
  GuestListPage,
  GuestListParams,
  InspectKind,
  InspectResult,
  Maintenance,
  Metrics,
  Passkey,
  PendingEnrollment,
  Range,
  ServerDetail,
  ServerListItem,
  ServerSettings,
  Snapshot,
  Zoom,
} from './types';

export const LIVE_REFRESH_MS = 10_000;

const STEP_S: Record<Range, number> = { '1h': 60, '6h': 300, '24h': 900, '7d': 7200, '30d': 21600, '90d': 64800 };

/** Charts for 1h and 6h follow the 10 s refresh; longer ranges refresh at their bucket size. */
export function seriesRefreshMs(range: Range): number {
  return range === '1h' || range === '6h' ? LIVE_REFRESH_MS : STEP_S[range] * 1000;
}

export const qk = {
  auth: ['auth'] as const,
  fleet: (group: string, range: Range) => ['fleet', group, range] as const,
  fleetSeries: (group: string, range: Range) => ['fleetSeries', group, range] as const,
  servers: ['servers'] as const,
  server: (id: string, range: Range) => ['server', id, range] as const,
  metrics: (id: string, range: Range, zoom?: Zoom | null) => ['metrics', id, range, zoom?.from ?? '', zoom?.to ?? ''] as const,
  annotations: (id: string, range: Range, zoom?: Zoom | null) => ['annotations', id, range, zoom?.from ?? '', zoom?.to ?? ''] as const,
  guestMetrics: (id: string, guestId: string, range: Range) => ['guestMetrics', id, guestId, range] as const,
  guests: (id: string, platform: string, kind?: string) => ['guests', id, platform, kind ?? ''] as const,
  guestList: (p: GuestListParams) => ['guestList', p.q ?? '', p.state ?? '', p.platform ?? '', p.kind ?? '', p.server ?? '', p.tag ?? '', p.sort ?? '', p.limit ?? 0, p.cursor ?? ''] as const,
  alerts: ['alerts'] as const,
  resolvedAlerts: ['alerts', 'resolved'] as const,
  alertHistory: (f: Record<string, string>) => ['alerts', 'history', f] as const,
  maintenance: ['maintenance'] as const,
  enrollments: ['enrollments'] as const,
  agents: ['agents'] as const,
  groups: ['groups'] as const,
  settings: (id: string) => ['settings', id] as const,
  passkeys: ['passkeys'] as const,
  audit: (event: string, server: string) => ['audit', event, server] as const,
  snapshots: (server: string, guest: string) => ['snapshots', server, guest] as const,
  inspect: (server: string, kind: InspectKind) => ['inspect', server, kind] as const,
  checks: ['checks'] as const,
};

export function useAuthState(): UseQueryResult<AuthState> {
  return useQuery({
    queryKey: qk.auth,
    queryFn: async ({ signal }) => {
      const s = await api.authState(signal);
      setCsrfToken(s.csrf_token);
      return s;
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export function useFleet(group: string, range: Range): UseQueryResult<Fleet> {
  return useQuery({
    queryKey: qk.fleet(group, range),
    queryFn: ({ signal }) => api.fleet(group, range, signal),
    refetchInterval: LIVE_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useFleetSeries(group: string, range: Range): UseQueryResult<FleetSeries> {
  return useQuery({
    queryKey: qk.fleetSeries(group, range),
    queryFn: ({ signal }) => api.fleetSeries(group, range, signal),
    refetchInterval: seriesRefreshMs(range),
    placeholderData: keepPreviousData,
  });
}

export function useServers(): UseQueryResult<ServerListItem[]> {
  return useQuery({
    queryKey: qk.servers,
    queryFn: ({ signal }) => api.servers(signal),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useServer(id: string, range: Range): UseQueryResult<ServerDetail> {
  return useQuery({
    queryKey: qk.server(id, range),
    queryFn: ({ signal }) => api.server(id, range, signal),
    refetchInterval: LIVE_REFRESH_MS,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
}

export function useMetrics(id: string, range: Range, zoom?: Zoom | null): UseQueryResult<Metrics> {
  return useQuery({
    queryKey: qk.metrics(id, range, zoom),
    queryFn: ({ signal }) => api.metrics(id, range, undefined, signal, zoom),
    // A zoomed window is history: no refresh.
    refetchInterval: zoom ? false : seriesRefreshMs(range),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
  });
}

/** Chart markers of a host (alerts, reboots, actions) for the range or window. */
export function useAnnotations(id: string, range: Range, zoom?: Zoom | null): UseQueryResult<Annotation[]> {
  return useQuery({
    queryKey: qk.annotations(id, range, zoom),
    queryFn: ({ signal }) => api.annotations(id, range, zoom, signal),
    refetchInterval: zoom ? false : 60_000,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
    retry: 1,
  });
}

/** History of one guest. */
export function useGuestMetrics(id: string, guestId: string, range: Range, enabled = true): UseQueryResult<Metrics> {
  return useQuery({
    queryKey: qk.guestMetrics(id, guestId, range),
    queryFn: ({ signal }) => api.guestMetrics(id, guestId, range, signal),
    refetchInterval: Math.max(60_000, seriesRefreshMs(range)),
    enabled,
    retry: 1,
  });
}

export function useGuests(id: string, platform: string, kind: string | undefined, enabled: boolean): UseQueryResult<GuestList> {
  return useQuery({
    queryKey: qk.guests(id, platform, kind),
    queryFn: ({ signal }) => api.guests(id, platform, kind, signal),
    refetchInterval: LIVE_REFRESH_MS,
    enabled,
    retry: 1,
  });
}

/** Fleet-wide guest list (CONTRACT 1): the Guests page and the command palette. */
export function useGuestList(p: GuestListParams, enabled = true, refetchMs = LIVE_REFRESH_MS): UseQueryResult<GuestListPage> {
  const params: GuestListParams = { ...p, q: p.q?.trim() || undefined };
  return useQuery({
    queryKey: qk.guestList(params),
    queryFn: ({ signal }) => api.listGuests(params, signal),
    enabled,
    refetchInterval: refetchMs,
    placeholderData: keepPreviousData,
  });
}

/** Guest search for the command palette; idle below two characters. */
export function useGuestSearch(q: string): UseQueryResult<GuestListPage> {
  const term = q.trim();
  return useGuestList({ q: term, limit: 12 }, term.length >= 2);
}

export function useAlerts(): UseQueryResult<Alert[]> {
  return useQuery({
    queryKey: qk.alerts,
    queryFn: ({ signal }) => api.alerts(signal),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useResolvedAlerts(limit = 50): UseQueryResult<Alert[]> {
  return useQuery({
    queryKey: qk.resolvedAlerts,
    queryFn: ({ signal }) => api.resolvedAlerts(limit, signal),
    refetchInterval: LIVE_REFRESH_MS * 3,
  });
}

/** Alert history with filters, paged by `before` (newest first). */
export function useAlertHistory(f: { server?: string; severity?: string; q?: string; group?: string }) {
  const key: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v) key[k] = v;
  return useInfiniteQuery({
    queryKey: qk.alertHistory(key),
    queryFn: ({ signal, pageParam }) => api.alertHistory({ ...f, before: pageParam, limit: 50 }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: LIVE_REFRESH_MS * 3,
  });
}

export function useMaintenance(enabled = true): UseQueryResult<Maintenance[]> {
  return useQuery({ queryKey: qk.maintenance, queryFn: ({ signal }) => api.maintenance(signal), enabled, refetchInterval: 60_000 });
}

/** Pending agents. Polled every 5 s while `fast` (the enrollment dialog waits for its agent), else 15 s; SSE `enrollment.pending` refetches at once. */
export function usePendingEnrollments(enabled = true, fast = false): UseQueryResult<PendingEnrollment[]> {
  return useQuery({
    queryKey: qk.enrollments,
    queryFn: ({ signal }) => api.pendingEnrollments(signal),
    refetchInterval: fast ? 5_000 : 15_000,
    enabled,
  });
}

export function useAgents(): UseQueryResult<AgentInfo[]> {
  return useQuery({
    queryKey: qk.agents,
    queryFn: ({ signal }) => api.agents(signal),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useGroups(enabled = true): UseQueryResult<string[]> {
  return useQuery({ queryKey: qk.groups, queryFn: ({ signal }) => api.groups(signal), enabled, staleTime: 30_000 });
}

export function useServerSettings(id: string, enabled = true): UseQueryResult<ServerSettings> {
  return useQuery({ queryKey: qk.settings(id), queryFn: ({ signal }) => api.serverSettings(id, signal), enabled });
}

export function usePasskeys(enabled = true): UseQueryResult<Passkey[]> {
  return useQuery({ queryKey: qk.passkeys, queryFn: ({ signal }) => api.passkeys(signal), enabled, retry: 1 });
}

/** Audit log, newest first, cursor paginated (CONTRACT 3). */
export function useAuditLog(event: string, server: string) {
  return useInfiniteQuery({
    queryKey: qk.audit(event, server),
    queryFn: ({ signal, pageParam }) => api.audit({ limit: 100, cursor: pageParam, event: event || null, server: server || null }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

/** A guest's snapshots, asked from the agent when the dialog opens. */
export function useSnapshots(serverId: string, guestId: string, enabled = true): UseQueryResult<InspectResult<Snapshot>> {
  return useQuery({
    queryKey: qk.snapshots(serverId, guestId),
    queryFn: ({ signal }) => api.snapshots(serverId, guestId, signal),
    enabled,
    retry: false,
  });
}

/**
 * A live view of the host (never stored). `refreshMs` polls while the view
 * is shown (processes); TanStack Query pauses polling in a hidden tab.
 */
export function useInspect<T>(serverId: string, kind: InspectKind, refreshMs?: number): UseQueryResult<InspectResult<T>> {
  return useQuery({
    queryKey: qk.inspect(serverId, kind),
    queryFn: ({ signal }) => api.inspect<T>(serverId, kind, signal),
    refetchInterval: refreshMs,
    refetchOnWindowFocus: false,
    staleTime: refreshMs ?? 60_000,
    retry: false,
  });
}

/** Checks with their 24 h uptime and latency; SSE `checks.changed` refetches at once. */
export function useChecks(enabled = true): UseQueryResult<Check[]> {
  return useQuery({ queryKey: qk.checks, queryFn: ({ signal }) => api.checks(signal), enabled, refetchInterval: 60_000 });
}
