/**
 * Remote help in React (app docs/decisions/remote-help.md AP-4443): `remoteHelp.get` and the visits in the query cache,
 * asked again every 10 s while it's on or someone is connected (steps come as support works), whether the viewer has a
 * passkey (the button's hint), and turning it on and stopping it with the problem in words. The same on the web and the
 * phone; each brings its `RemoteHelpApi` (`remoteHelpApi(session)`, or a fixture's), its passkeys and its dialog.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import {
  REMOTE_HELP_POLL_MS,
  type RemoteHelpApi,
  type RemoteHelpChoice,
  type RemoteHelpState,
  type RemoteHelpVisit,
  remoteHelpErrorText,
  remoteHelpPollMs,
  type TurnOnRemoteHelpDeps,
  turnOnRemoteHelp,
} from '../managed/remote-help';
import { QUERY_ROOT } from '../query/keys';

/** Where `remoteHelp.get` is kept (endpoint-shaped, like the desk's). */
export const REMOTE_HELP_QUERY_KEY = [QUERY_ROOT, 'remoteHelp.get', {}, {}] as const;
export const REMOTE_HELP_VISITS_QUERY_KEY = [QUERY_ROOT, 'remoteHelp.visits', {}, {}] as const;
const PASSKEY_KEY = [QUERY_ROOT, 'remoteHelp.hasPasskey', {}, {}] as const;

/** How many visits the card lists (the op's most). */
export const REMOTE_HELP_VISITS_SHOWN = 20;

export interface RemoteHelpModel {
  /** `remoteHelp.get`; null until it answers (or where there is no remote help here). */
  state: RemoteHelpState | null;
  /** The newest visits first; null until they load. */
  visits: RemoteHelpVisit[] | null;
  /** The state or the visits didn't load. */
  loadError: boolean;
  hasPasskey: boolean | null;
  /** What runs now. */
  busy: 'on' | 'stop' | null;
  /** The last action's problem in words (`remoteHelpErrorText`); null when there is none. */
  problem: string | null;
  clearProblem(): void;
  /** Turns it on, or changes the level or the time (RH-04); a dismissed prompt or dialog changes nothing. */
  turnOn(choice: RemoteHelpChoice, deps: Omit<TurnOnRemoteHelpDeps, 'api'>): Promise<boolean>;
  /** Stops it at once (never asks, RH-04). */
  stop(): Promise<boolean>;
  reload(): void;
}

export function useRemoteHelp(api: RemoteHelpApi | null, enabled = true): RemoteHelpModel {
  const qc = useQueryClient();
  const on = api !== null && enabled;
  const state = useQuery({
    queryKey: REMOTE_HELP_QUERY_KEY,
    queryFn: () => (api as RemoteHelpApi).get(),
    enabled: on,
    retry: false,
    refetchInterval: (q) => remoteHelpPollMs(q.state.data) ?? false,
  });
  const live = remoteHelpPollMs(state.data) !== null;
  const visits = useQuery({
    queryKey: REMOTE_HELP_VISITS_QUERY_KEY,
    queryFn: () => (api as RemoteHelpApi).visits({ limit: REMOTE_HELP_VISITS_SHOWN }),
    enabled: on,
    retry: false,
    refetchInterval: live ? REMOTE_HELP_POLL_MS : false,
  });
  const passkey = useQuery({
    queryKey: PASSKEY_KEY,
    queryFn: () => (api as RemoteHelpApi).hasPasskey(),
    enabled: on,
    retry: false,
    staleTime: 60_000,
  });
  const [busy, setBusy] = useState<'on' | 'stop' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const put = useCallback(
    (next: RemoteHelpState) => {
      qc.setQueryData(REMOTE_HELP_QUERY_KEY, next);
      void qc.invalidateQueries({ queryKey: REMOTE_HELP_VISITS_QUERY_KEY });
    },
    [qc],
  );

  const turnOn = useCallback<RemoteHelpModel['turnOn']>(
    async (choice, deps) => {
      if (!api) return false;
      setBusy('on');
      setProblem(null);
      try {
        const r = await turnOnRemoteHelp({ ...deps, api }, choice);
        if (r.kind === 'cancelled') return false;
        put(r.state);
        return true;
      } catch (error) {
        setProblem(remoteHelpErrorText(error));
        // What the box holds now (a refused change leaves the grant as it was).
        void qc.invalidateQueries({ queryKey: REMOTE_HELP_QUERY_KEY });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, put, qc],
  );

  const stop = useCallback(async () => {
    if (!api) return false;
    setBusy('stop');
    setProblem(null);
    try {
      put(await api.stop());
      return true;
    } catch (error) {
      setProblem(remoteHelpErrorText(error));
      return false;
    } finally {
      setBusy(null);
    }
  }, [api, put]);

  const reload = useCallback(() => {
    void qc.invalidateQueries({ queryKey: REMOTE_HELP_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: REMOTE_HELP_VISITS_QUERY_KEY });
  }, [qc]);

  return useMemo(
    () => ({
      state: state.data ?? null,
      visits: visits.data ?? null,
      loadError: state.isError || visits.isError,
      hasPasskey: passkey.data ?? null,
      busy,
      problem,
      clearProblem: () => setProblem(null),
      turnOn,
      stop,
      reload,
    }),
    [
      state.data,
      visits.data,
      state.isError,
      visits.isError,
      passkey.data,
      busy,
      problem,
      turnOn,
      stop,
      reload,
    ],
  );
}
