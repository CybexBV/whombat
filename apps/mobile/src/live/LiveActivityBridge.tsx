/**
 * The in-app path for live activities (self-hosted and managed alike): while the app runs, `run.updated` and
 * `approval.updated` from the socket start, update and end the viewer's activities at once (a self-hosted server's data
 * pushes cover the time the app is closed; a managed Whombat sends none, NT-13). After every (re)load of the burrow's
 * runs and approvals the activities are reconciled: current ones on screen are shown fresh, new ones appear, and those
 * that ended meanwhile are finished or dismissed. A reload happens at start, on a socket resync, on coming back to the
 * foreground (only a reconcile when realtime stayed up, AP-927) and on every push that reaches the running app but a
 * live one (MN-02). Natively an ongoing activity goes 10 minutes after its last update, so while the app is in the
 * foreground the ones on screen are refreshed every 5 minutes.
 */
import { useApprovals, useRealtimeEvent, useRuns, useWhombat } from '@whombat/client/react';
import { type LiveActivityState, liveActivityAttributes } from '@whombat/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  approvalLiveFor,
  LIVE_COLORS,
  reconcileActivities,
  runLiveFor,
  WhombatLive,
} from '../../modules/whombat-live';
import { useBurrowBase } from '../data/BurrowProvider';
import { phoneNotifications } from '../push/phoneNotifications';
import { liveViewer } from './viewer';

/** Pushes and foregrounds closer together than this reload once (MN-02). */
const RELOAD_GAP_MS = 10_000;
/** While in the foreground, the activities on screen are refreshed this often (their native timeout is 10 minutes). */
const KEEPALIVE_MS = 5 * 60_000;

export function LiveActivityBridge() {
  // The viewer from the bootstrap as it is when an event comes: following it would draw this again for every message.
  const { slug, people, currentBootstrap } = useBurrowBase();
  const viewerRef = useRef(() => liveViewer(currentBootstrap(), people));
  viewerRef.current = () => liveViewer(currentBootstrap(), people);
  /** Keys shown in this session: an ended run or approval only replaces an activity that was shown. */
  const shown = useRef(new Set<string>());

  useEffect(() => WhombatLive.configure(LIVE_COLORS), []);

  const render = useCallback(
    (state: LiveActivityState | null) => {
      if (!state) return;
      const key = state.display.key;
      if (state.ended) {
        if (!shown.current.delete(key)) return;
      } else {
        shown.current.add(key);
      }
      WhombatLive.show(state.display, {
        burrow: slug,
        attributes: liveActivityAttributes(state.activity, slug),
      }).catch(() => {});
    },
    [slug],
  );

  useRealtimeEvent('run.updated', ({ run }) => render(runLiveFor(run, viewerRef.current())));
  useRealtimeEvent('approval.updated', ({ approval }) =>
    render(approvalLiveFor(approval, viewerRef.current())),
  );

  const runs = useRuns({ params: { burrow: slug }, query: {} });
  const approvals = useApprovals({ params: { burrow: slug }, query: {} });

  // Reconcile after each completed fetch (not on every realtime patch of the cached lists).
  const fetching = runs.isFetching || approvals.isFetching;
  const [loads, setLoads] = useState(0);
  const wasFetching = useRef(true);
  useEffect(() => {
    if (wasFetching.current && !fetching) setLoads((n) => n + 1);
    wasFetching.current = fetching;
  }, [fetching]);

  // A push reached the running app, or it came back to the foreground: load runs and approvals again, which
  // reconciles (MN-02). Back in the foreground with realtime up all the while, the lists are current: reconciling them
  // is enough; otherwise the reload joins the foreground refetch rather than cancelling and repeating it (AP-927).
  // While in the foreground, the activities on screen are refreshed before their timeout.
  const { realtime } = useWhombat();
  const refetch = useRef({ runs: runs.refetch, approvals: approvals.refetch });
  refetch.current = { runs: runs.refetch, approvals: approvals.refetch };
  useEffect(() => {
    let last = 0;
    const reload = (join = false) => {
      const now = Date.now();
      if (now - last < RELOAD_GAP_MS) return;
      last = now;
      const options = { cancelRefetch: !join };
      void refetch.current.runs(options).catch(() => {});
      void refetch.current.approvals(options).catch(() => {});
    };
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const foreground = (active: boolean) => {
      if (keepalive) clearInterval(keepalive);
      keepalive = active ? setInterval(() => setLoads((n) => n + 1), KEEPALIVE_MS) : null;
    };
    // Visible counts as in front: in Split View on the iPhone Duo the app shows while `inactive` (iphone-duo.md).
    foreground(AppState.currentState !== 'background');
    /** Realtime went down (or never was up) since the app left the foreground. */
    let away = false;
    let dropped = false;
    const offStatus = realtime?.onStatus((status) => {
      if (away && status !== 'open') dropped = true;
    });
    const appState = AppState.addEventListener('change', (next) => {
      foreground(next !== 'background');
      if (next === 'background' && !away) {
        away = true;
        dropped = realtime?.status() !== 'open';
      }
      if (next !== 'active') return;
      const current = away && !dropped && realtime?.status() === 'open';
      away = false;
      if (current) setLoads((n) => n + 1);
      else reload(true);
    });
    // A live push already carries its activity's state (rendered natively); any other push may mean one ended.
    const offs = [
      WhombatLive.onPush((payload) => !payload.liveActivity && reload()),
      WhombatLive.onGenericPush(() => reload()),
      // iOS: an alert reached the running app (its live activities update through ActivityKit itself).
      ...(Platform.OS === 'ios' ? [phoneNotifications.onPush(() => reload())] : []),
    ];
    return () => {
      if (keepalive) clearInterval(keepalive);
      offStatus?.();
      appState.remove();
      for (const off of offs) off();
    };
  }, [realtime]);

  const latest = useRef({ runs: runs.data, approvals: approvals.data });
  latest.current = { runs: runs.data, approvals: approvals.data };
  useEffect(() => {
    const { runs: r, approvals: a } = latest.current;
    if (!loads || !r || !a) return;
    let alive = true;
    const viewer = viewerRef.current();
    const current = [
      ...r.runs.map((run) => runLiveFor(run, viewer)),
      ...a.approvals.map((approval) => approvalLiveFor(approval, viewer)),
    ].filter((s): s is LiveActivityState => s !== null);
    void Promise.all([WhombatLive.active(), WhombatLive.recent()]).then(([onScreen, recent]) => {
      if (!alive) return;
      const plan = reconcileActivities(onScreen, current, slug, new Set(recent));
      for (const key of plan.end) {
        shown.current.delete(key);
        void WhombatLive.end(key, slug).catch(() => {});
      }
      for (const state of plan.finish) {
        shown.current.add(state.display.key);
        render(state);
      }
      for (const state of plan.show) render(state);
    });
    return () => {
      alive = false;
    };
  }, [loads, slug, render]);

  return null;
}
