/**
 * Servers in React (contracts 0.80 `api.hosts.*`; AP-1303): one hook per read, the live topic, and changes that
 * refetch what they touch. The same on the web and Android (`@whombat/client/hosts/react`).
 */
import { keepPreviousData, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { type AnyEndpoint, api, topics } from '@whombat/core/contracts';
import type {
  HostScreenBody,
  HostScreenResult,
  HostSeries,
  HostSeriesRange,
  HostServerDetail,
  ThingPagePanel,
} from '@whombat/core/domain';
import { hostScreenTimeoutMs } from '@whombat/core/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallInput, CommitResult, ResponseData } from '../http/types';
import { useI18n } from '../i18n/react';
import { useWhombat } from '../react/context';
import { type Sealed, sealOnce, useApiMutation } from '../react/mutations';
import { queryHook } from '../react/queries';
import { useSubscription } from '../react/realtime';
import { invalidateHosts } from './apply';
import {
  DASHBOARD_FORECAST_RANGE,
  dashboardGuests,
  SERVER_DASHBOARD_REFRESH_MS,
  type ServerDashboardHead,
  serverDashboardHead,
  serverDashboardSeries,
  serverDashboardView,
  serverDashboardVolumeSeries,
  serverPageTellsProblem,
} from './dashboard';
import { commitOutcomeText, hostErrorInfo } from './errors';
import { INSTALL_POLL_MS, installRunning } from './install';
import { macStepText } from './macos';
import { type RepointView, repointView } from './repoint';
import type { Verdict } from './verdict';

export * from './findmy-react';
export * from './findmy-timeline-react';
export { useHostsStatus } from './status';

/**
 * The reader's language for the servers' words: null in English, so English pages keep the words and dates they had
 * before the pages spoke other languages (a locale also switches on the localized tab names and forecast words).
 */
function useHostsLocale(): string | null {
  const { displayLanguage, rawLocale } = useI18n();
  return displayLanguage === 'en' ? null : rawLocale;
}

/** Every server with its status and load, the totals, open alerts and hints. */
export const useHostsFleet = queryHook(api.hosts.fleet);
/** A server's page. */
export const useHostServer = queryHook(api.hosts.getServer);
export const useHostServerMetrics = queryHook(api.hosts.serverMetrics);
export const useHostServerSettings = queryHook(api.hosts.serverSettings);
/** “Keep server agents up to date” (contracts 0.99, `hosts.agent_updates`). */
export const useHostAgentSettings = queryHook(api.hosts.agentSettings);
export const useHostGuests = queryHook(api.hosts.listGuests);
export const useHostGuest = queryHook(api.hosts.getGuest);
export const useHostGuestMetrics = queryHook(api.hosts.guestMetrics);
/** A guest's configuration and digest, form choices, backups, storage content, tasks, firewall, snapshots. */
export const useHostManageRead = queryHook(api.hosts.manageRead);
export const useHostTask = queryHook(api.hosts.getTask);
export const useHostEnrollments = queryHook(api.hosts.listEnrollments);
export const useHostInspect = queryHook(api.hosts.inspect);
/**
 * A picture of a Mac's screen now (`hosts.screenLook`, Whombat macos-servers.md): larger than one session message, so
 * the session reads it through an export stream by itself (`EXPORT_READ_OPS`). Read on demand: pass null until asked.
 */
export const useHostScreenLook = queryHook(api.hosts.screenLook);
/** An install job as it is (`hosts.getInstall`). `useHostInstall` follows a running one. */
export const useHostInstallRead = queryHook(api.hosts.getInstall);

/**
 * Follow an install job (Whombat SI-02; AP-1680): `hosts.install` frames refetch it (`apply.ts`); while it runs it is
 * also read every 2 s, in case a frame doesn't come. Null: no job.
 */
export function useHostInstall(burrow: string, installId: string | null) {
  return useHostInstallRead(installId ? { params: { burrow, installId } } : null, {
    refetchInterval: (q) => (q.state.data && !installRunning(q.state.data) ? false : INSTALL_POLL_MS),
  });
}

/**
 * Whether this Whombat's address changed and which servers haven't found it since (contracts 0.117, `hosts.repoint`;
 * BF-16): null when there is nothing to say.
 */
export const useHostsAddressChange = queryHook(api.hosts.addressChange);
/** A repoint job as it is (`hosts.getRepoint`). `useRepointServers` follows a running one. */
export const useHostRepointRead = queryHook(api.hosts.getRepoint);

/**
 * Follow a repoint job (BF-15, BF-16; AP-4415): `hosts.repoint` frames refetch it (`apply.ts`); while it runs it is also
 * read every 2 s, in case a frame doesn't come. Null: no job.
 */
export function useHostRepoint(burrow: string, repointId: string | null) {
  return useHostRepointRead(repointId ? { params: { burrow, repointId } } : null, {
    refetchInterval: (q) => (q.state.data?.state === 'done' ? false : INSTALL_POLL_MS),
  });
}

/** Point them here, as the web's dialog and Android's screen use it. */
export interface RepointServers {
  view: RepointView;
  /** Starts `hosts.repoint` for the waiting servers; `view` then follows the job. */
  start(): Promise<void>;
  starting: boolean;
  /** Why the change couldn't be read or the job didn't start, in words; null otherwise. */
  error: string | null;
}

/**
 * Point them here (BF-15, BF-16; AP-4415): reads the address change (`hosts.addressChange`), starts `hosts.repoint` for
 * the servers still looking for the old address and follows the job server by server. The change as first read stays
 * the dialog's lead while the job runs (the servers it points leave the waiting list). Null `burrow` waits.
 */
export function useRepointServers(burrow: string | null): RepointServers {
  const locale = useHostsLocale();
  const change = useHostsAddressChange(burrow ? { params: { burrow } } : null, { retry: false });
  const start = useHostsChange(api.hosts.repoint);
  const [job, setJob] = useState<ResponseData<typeof api.hosts.repoint> | null>(null);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const followed = useHostRepoint(burrow ?? '', burrow ? (job?.id ?? null) : null);
  const first = useRef<ResponseData<typeof api.hosts.addressChange> | undefined>(undefined);
  if (change.data && first.current === undefined) first.current = change.data;
  const current = followed.data ?? job;
  const view = repointView(current ? (change.data ?? first.current ?? null) : change.data, current, locale);
  // A finished job read again what it changed (a frame may not come: fixture mode, a dropped socket).
  const qc = useQueryClient();
  const finished = current?.state === 'done';
  useEffect(() => {
    if (finished) invalidateHosts(qc, ['hosts.addressChange', 'hosts.fleet', 'home.overview']);
  }, [finished, qc]);

  const run = useCallback(async () => {
    if (!burrow || view.servers.length === 0) return;
    setStarting(true);
    setRefusal(null);
    try {
      const r = await start.mutateAsync({ params: { burrow }, body: { servers: view.servers } });
      if (r.status === 'ok') setJob(r.data);
      else setRefusal(commitOutcomeText(r, locale));
    } catch (err) {
      setRefusal(hostErrorInfo(err, locale).message);
    } finally {
      setStarting(false);
    }
  }, [burrow, start, view.servers, locale]);

  const loadError =
    change.error && change.data === undefined ? hostErrorInfo(change.error, locale).message : null;
  const lost = followed.error && !followed.data && job ? hostErrorInfo(followed.error, locale).message : null;
  return { view, start: run, starting, error: refusal ?? lost ?? loadError };
}

/** Follow the burrow's servers live (`hosts:<burrowId>`) while mounted. */
export function useHostsLive(burrowId: string | null | undefined): void {
  useSubscription(burrowId ? topics.hosts(burrowId) : null);
}

/** What each change refetches when it went through. */
const AFTER: Partial<Record<string, readonly string[]>> = {
  'hosts.guestAction': ['hosts.getGuest', 'hosts.listGuests', 'hosts.getServer', 'hosts.manageRead'],
  'hosts.manage': [
    'hosts.manageRead',
    'hosts.getGuest',
    'hosts.listGuests',
    'hosts.getServer',
    'hosts.fleet',
  ],
  // A new name shows in the sidebar and on Home too.
  'hosts.updateServer': ['hosts.serverSettings', 'hosts.getServer', 'hosts.fleet', 'home.overview'],
  'hosts.removeServer': ['hosts.fleet', 'hosts.status', 'home.overview'],
  'hosts.serverAction': ['hosts.getServer', 'hosts.fleet'],
  // A Mac's screen step changes what its page says (the password, the lock, the helper).
  'hosts.screen': ['hosts.getServer'],
  // An on-request disk breakdown updates what the Storage tab shows.
  'hosts.diskUsage': ['hosts.getServer'],
  // Update now also clears the halt (Whombat agent-updates.md AU-05).
  'hosts.updateAgent': ['hosts.serverSettings', 'hosts.getServer', 'hosts.agentSettings', 'hosts.fleet'],
  'hosts.updateAgentSettings': ['hosts.agentSettings', 'hosts.serverSettings'],
  'hosts.ackAlert': ['hosts.listAlerts', 'hosts.fleet', 'hosts.getServer', 'home.overview', 'watch.list'],
  'hosts.unackAlert': ['hosts.listAlerts', 'hosts.fleet', 'hosts.getServer', 'home.overview', 'watch.list'],
  'hosts.createMaintenance': ['hosts.listMaintenance', 'hosts.fleet', 'hosts.getServer'],
  'hosts.removeMaintenance': ['hosts.listMaintenance', 'hosts.fleet', 'hosts.getServer'],
  'hosts.createCheck': ['hosts.listChecks'],
  'hosts.updateCheck': ['hosts.listChecks'],
  'hosts.removeCheck': ['hosts.listChecks'],
  'hosts.createEnrollment': ['hosts.listEnrollments'],
  'hosts.approveEnrollment': ['hosts.listEnrollments', 'hosts.fleet', 'hosts.status', 'home.overview'],
  'hosts.rejectEnrollment': ['hosts.listEnrollments', 'home.overview'],
  'hosts.repoint': ['hosts.addressChange', 'home.overview'],
};

/**
 * A hosts change (`useHostsChange(api.hosts.manage).mutateAsync({params, body})`): resolves to its `CommitResult`
 * and, when it went through, refetches the reads it touches.
 */
export function useHostsChange<E extends AnyEndpoint>(ep: E) {
  const qc = useQueryClient();
  return useApiMutation(ep, {
    onSuccess: (result: CommitResult<ResponseData<E>>) => {
      if (result.status === 'ok') invalidateHosts(qc, AFTER[ep.id] ?? []);
    },
  });
}

/** Refetch every server read (after a console closed a guest, a task finished). */
export function useRefreshHosts(): (endpoints?: readonly string[]) => void {
  const qc = useQueryClient();
  return useCallback(
    (endpoints?: readonly string[]) => {
      invalidateHosts(
        qc,
        endpoints ?? ['hosts.getServer', 'hosts.getGuest', 'hosts.listGuests', 'hosts.manageRead'],
      );
    },
    [qc],
  );
}

export type HostsChangeInput<E extends AnyEndpoint> = CallInput<E>;

/* A server's Summary (dashboards.md DS-02, DS-16; AP-2005) ------------------------------------------------------- */

/** The `hosts.getServer` query the Summary reads: the same as the web's server page, so they share one read. */
export const SERVER_DASHBOARD_DETAIL_RANGE: HostSeriesRange = '24h';

/** How long the storages' 30 days stay fresh. */
const VOLUMES_STALE_MS = 10 * 60_000;

/** The metrics query's series as one comma list, kept within the API's 500 characters. */
function seriesParam(keys: readonly string[]): string {
  let out = '';
  for (const k of keys) {
    const next = out ? `${out},${k}` : k;
    if (next.length > 500) break;
    out = next;
  }
  return out;
}

export interface ServerDashboardState {
  detail: HostServerDetail | undefined;
  head: ServerDashboardHead | null;
  /** The Summary's panels (`serverDashboardView`), null until the server's page is read. */
  panels: ThingPagePanel[] | null;
  /** Its Technical details (storage, pools, the platform's facts, the cluster), folded under the Summary. */
  details: ThingPagePanel[] | null;
  /** The sentence at the top of the page, from Worth a look's lines. */
  verdict: Verdict | null;
  /** Right now or Worth a look tells a problem (`serverPageTellsProblem`): the head need not say it again. */
  told: boolean;
  /** The range's history, the previous range's while a new one loads. */
  series: HostSeries | undefined;
  /** The server's page is being read for the first time. */
  loading: boolean;
  /** Anything is being read (a new range, the 60-second refresh). */
  fetching: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * A server's Summary (DS-02): its page (`hosts.getServer`, kept live by the `hosts` topic — follow it with
 * `useHostsLive`), its history for the range (`hosts.serverMetrics` with `serverDashboardSeries`, read again every 60 s,
 * DS-16; the previous range stays on screen while a new one loads), its storages' last 30 days for the forecasts (every
 * 10 minutes) and the busiest guests' own history, built into panels with `serverDashboard`. Null `serverId` waits.
 */
export function useServerDashboard({
  burrow,
  serverId,
  range,
  timeZone,
  updates = null,
  quiet = false,
  name,
  assistant,
}: {
  burrow: string;
  serverId: string | null | undefined;
  range: HostSeriesRange;
  timeZone?: string;
  /** Where the waiting-updates hint's way out goes (SWU-13); null: System, as before. */
  updates?: 'web' | 'phone' | null;
  /** May the viewer quiet its lines (`things.quiet` and `things.watch`'s `mayChange`; quiet-notices.md AP-4810). */
  quiet?: boolean;
  /** The server's name in the verdict (the fleet's); absent: its id. */
  name?: string;
  /** The assistant's name, for a problem's “Ask {assistant}”. */
  assistant?: string;
}): ServerDashboardState {
  const { queries } = useWhombat();
  const locale = useHostsLocale();
  const detailQ = useHostServer(
    serverId ? { params: { burrow, serverId }, query: { range: SERVER_DASHBOARD_DETAIL_RANGE } } : null,
  );
  const detail = detailQ.data;
  const keys = detail ? seriesParam(serverDashboardSeries(detail)) : '';
  const metricsQ = useHostServerMetrics(
    serverId && detail ? { params: { burrow, serverId }, query: { range, series: keys } } : null,
    { refetchInterval: SERVER_DASHBOARD_REFRESH_MS, placeholderData: keepPreviousData },
  );
  // The storages' last 30 days for their forecasts (DS-08), whatever the range; they move slowly.
  const volKeys = detail ? seriesParam(serverDashboardVolumeSeries(detail)) : '';
  const volumesQ = useHostServerMetrics(
    serverId && volKeys
      ? { params: { burrow, serverId }, query: { range: DASHBOARD_FORECAST_RANGE, series: volKeys } }
      : null,
    { staleTime: VOLUMES_STALE_MS, refetchInterval: VOLUMES_STALE_MS, retry: false },
  );
  const guestIds = detail ? dashboardGuests(detail).map((g) => g.id) : [];
  const guestQs = useQueries({
    queries: guestIds.map((guestId) => ({
      ...queries.endpoint(api.hosts.guestMetrics, {
        params: { burrow, serverId: serverId ?? '', guestId },
        query: { range, series: 'cpu_pct' },
      }),
      enabled: !!serverId,
      refetchInterval: SERVER_DASHBOARD_REFRESH_MS,
      placeholderData: keepPreviousData,
      retry: false,
    })),
  });
  const guestData = guestQs.map((q) => q.data as HostSeries | undefined);
  const guestStamp = guestQs.map((q) => q.dataUpdatedAt).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the guests' answers are keyed by `guestStamp`
  const guests = useMemo(() => {
    const out: Record<string, HostSeries | undefined> = {};
    guestIds.forEach((id, i) => {
      out[id] = guestData[i];
    });
    return out;
  }, [guestIds.join(','), guestStamp]);
  const series = metricsQ.data;
  const volumes = volumesQ.data;
  // While a new range loads the previous one stays on screen, with its own words (“24 h”).
  const shown: HostSeriesRange = series && series.range !== 'custom' ? series.range : range;
  const view = useMemo(
    () =>
      detail
        ? serverDashboardView({
            detail,
            series,
            guests,
            volumes,
            range: shown,
            timeZone,
            updates,
            quiet,
            ...(name ? { name } : {}),
            ...(assistant ? { assistant } : {}),
            locale,
          })
        : null,
    [detail, series, guests, volumes, shown, timeZone, updates, quiet, name, assistant, locale],
  );
  const head = useMemo(
    () => (detail ? serverDashboardHead(detail, undefined, locale) : null),
    [detail, locale],
  );
  // Whether Right now or Worth a look tells a problem: then the head doesn't say it again in a sentence.
  const told = useMemo(() => (detail ? serverPageTellsProblem(detail) : false), [detail]);
  const refetch = useCallback(() => {
    void detailQ.refetch();
    void metricsQ.refetch();
    void volumesQ.refetch();
    for (const q of guestQs) void q.refetch();
  }, [detailQ, metricsQ, volumesQ, guestQs]);
  return {
    detail,
    head,
    panels: view?.panels ?? null,
    details: view?.details ?? null,
    verdict: view?.verdict ?? null,
    told,
    series,
    loading: !!serverId && detailQ.isPending,
    fetching: detailQ.isFetching || metricsQ.isFetching || guestQs.some((q) => q.isFetching),
    error: detailQ.error ?? null,
    refetch,
  };
}

/* A Mac's screen (Whombat macos-servers.md) --------------------------------------------------------------------- */

/** How a screen step went: its words for a toast or the form, and the Mac's answer when there is one. */
export type ScreenStepOutcome =
  | { ok: true; text: string; result: HostScreenResult }
  /** The Mac (or Whombat) said no: its words; `result` when the Mac answered. */
  | { ok: false; text: string; result?: HostScreenResult; error?: unknown };

/**
 * What the screen step's mutation keeps: the step without the Mac's account, which rides sealed (`sealOnce`) and is
 * taken out by the request, so neither the mutation cache nor `useMutation().variables` holds the password after.
 */
export interface ScreenStepVariables {
  params: { burrow: string; serverId: string };
  body: Omit<HostScreenBody, 'account'>;
  account?: Sealed<NonNullable<HostScreenBody['account']>>;
}

/** The screen step's mutation: the Mac's account goes with the request and nowhere else. */
export function useHostScreenMutation() {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<HostScreenResult>, Error, ScreenStepVariables>({
    // Offline, TanStack would pause the step before the request takes the account out of its box and send it later,
    // after the person closed the form: a screen step runs now or fails now.
    networkMode: 'always',
    mutationFn: ({ params, body, account }) => {
      const sealed = account?.take();
      return client.request(api.hosts.screen, {
        params,
        body: (sealed ? { ...body, account: sealed } : body) as HostScreenBody,
        // Typing the Mac's password one checked key at a time takes up to a minute (`hostScreenTimeoutMs`).
        deadlineMs: hostScreenTimeoutMs(body.op) + 10_000,
      });
    },
    onSuccess: (result) => {
      if (result.status === 'ok') invalidateHosts(qc, AFTER['hosts.screen'] ?? []);
    },
  });
}

/**
 * One screen step at a time on a Mac (`hosts.screen`): `step(body)` resolves to its outcome in words (`macStepText`), a
 * refusal before the Mac answered as Whombat's own words. The page is read again after a step that went through. The
 * Mac's password in `account.set` goes with the request only and is never kept here (`useHostScreenMutation`).
 */
export function useHostScreenStep(burrow: string, serverId: string, serverName: string) {
  const change = useHostScreenMutation();
  const locale = useHostsLocale();
  const [busy, setBusy] = useState<HostScreenBody['op'] | null>(null);
  const mutate = useRef(change.mutateAsync);
  mutate.current = change.mutateAsync;
  const step = useCallback(
    async ({ account, ...body }: HostScreenBody): Promise<ScreenStepOutcome> => {
      setBusy(body.op);
      try {
        const result = await mutate.current({
          params: { burrow, serverId },
          body,
          ...(account ? { account: sealOnce(account) } : {}),
        });
        if (result.status !== 'ok') return { ok: false, text: commitOutcomeText(result, locale) ?? '' };
        const words = macStepText(
          {
            op: body.op,
            ...(body.target ? { target: body.target } : {}),
            ...(account ? { account: { user: account.user } } : {}),
          },
          result.data,
          serverName,
          locale,
        );
        return words.ok
          ? { ok: true, text: words.text, result: result.data }
          : { ok: false, text: words.text, result: result.data };
      } catch (error) {
        return { ok: false, text: hostErrorInfo(error, locale).message, error };
      } finally {
        setBusy(null);
      }
    },
    [burrow, serverId, serverName, locale],
  );
  return { step, busy };
}
