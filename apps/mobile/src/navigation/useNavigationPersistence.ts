/**
 * Where the person was, kept across a killed process (MN-01): the navigation state is saved in the secure box (sealed
 * like the outbox and the cached reads, per storage scope, wiped with them) a moment after it changes and when the app
 * goes to the background, and restored once per process — on a cold start — before the first screen, unless a link or
 * a notification opened the app (then it decides, with the tabs beneath). `persist.ts` decides what may be restored;
 * a restored entity screen whose read says it is gone falls back to the tabs. Without a scope (the demo world) nothing
 * is kept. The saved place is read ahead, alongside the last-seen burrow (`prefetchNavigation`, AP-923), and what decides
 * the first screen (a link, a notification, the saved place) is asked all at once.
 */
import { type InitialState, StackActions } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { parseKey } from '@whombat/client/query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { deviceBox } from '../data/secureBoxNative';
import { useI18n } from '../i18n';
import { initialNotificationUrl } from '../push/taps';
import { navigationRef } from './hooks';
import {
  isGoneError,
  NAV_STATE_NAME,
  RESTORE_WATCH,
  restorableNavigation,
  type SavedNavigation,
  type SavedState,
  snapshotNavigation,
} from './persist';

/** A place is restored once per process (its cold start), not when a burrow or session switch remounts the app. */
let restoredOnce = false;

/** Starts reading the saved place of `scope` while the rest loads (a cold start only: later ones restore nothing). */
export function prefetchNavigation(scope: string): void {
  if (!restoredOnce) deviceBox().prefetch(scope, NAV_STATE_NAME);
}
/** Saves follow changes after this long. */
const SAVE_MS = 1000;
/** The first screen waits at most this long for the saved place. */
const RESTORE_WAIT_MS = 1000;
/** A restored screen's read is watched this long for “gone”. */
const WATCH_MS = 60_000;

export interface NavigationPersistence {
  /** False while the saved place loads (render nothing yet). */
  ready: boolean;
  initialState: InitialState | undefined;
  onReady: () => void;
  onStateChange: () => void;
}

export function useNavigationPersistence(scope: string | null, managed: boolean): NavigationPersistence {
  // The bootstrap is read when the saved place is checked, not followed: every new message changes it.
  const { slug, currentBootstrap } = useBurrowBase();
  const { rawLocale } = useI18n();
  const qc = useQueryClient();
  const [restore, setRestore] = useState<{ ready: boolean; state?: SavedState }>(() => ({
    ready: !scope || restoredOnce,
  }));
  const world = useRef({ currentBootstrap, managed, rawLocale });
  world.current = { currentBootstrap, managed, rawLocale };

  useEffect(() => {
    if (restore.ready || !scope) return;
    restoredOnce = true;
    let alive = true;
    const load = async (): Promise<SavedState | undefined> => {
      const [link, notification, saved] = await Promise.all([
        Linking.getInitialURL(),
        initialNotificationUrl(),
        deviceBox().load<SavedNavigation>(scope, NAV_STATE_NAME),
      ]);
      // A link or a notification opened the app: it decides the screen.
      if (link ?? notification) return undefined;
      const { currentBootstrap: bootstrap, managed: m, rawLocale: locale } = world.current;
      return restorableNavigation(saved, {
        now: Date.now(),
        burrow: slug,
        world: { sidebar: bootstrap().sidebar, managed: m },
        locale,
      });
    };
    const late = new Promise<undefined>((ok) => setTimeout(() => ok(undefined), RESTORE_WAIT_MS));
    void Promise.race([load().catch(() => undefined), late]).then((state) => {
      if (alive) setRestore(state ? { ready: true, state } : { ready: true });
    });
    return () => {
      alive = false;
    };
  }, [restore.ready, scope, slug]);

  const save = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const write = () => {
      timer = null;
      if (!scope || !navigationRef.isReady()) return;
      const snapshot = snapshotNavigation(navigationRef.getRootState(), slug, Date.now());
      if (snapshot)
        void deviceBox()
          .save(scope, NAV_STATE_NAME, snapshot)
          .catch(() => {});
    };
    return {
      schedule() {
        if (scope && !timer) timer = setTimeout(write, SAVE_MS);
      },
      flush() {
        if (timer) clearTimeout(timer);
        write();
      },
      // Not written on unmount: a sign-out or a switch of Whombats wipes the box first.
      cancel() {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
  }, [scope, slug]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') save.flush();
    });
    return () => {
      sub.remove();
      save.cancel();
    };
  }, [save]);

  // A restored screen whose read answers that it is gone (deleted, or no longer this person's) goes back to the tabs,
  // as long as the person is still on it.
  const restoredKey = useRef<string | null>(null);
  const top = restore.state?.routes[restore.state.index];
  const watched = top ? RESTORE_WATCH[top.name] : undefined;
  useEffect(() => {
    if (!watched) return;
    const off = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error' || !isGoneError(event.action.error))
        return;
      if (parseKey(event.query.queryKey)?.endpointId !== watched) return;
      const here = navigationRef.isReady() ? navigationRef.getCurrentRoute()?.key : undefined;
      if (!here || here !== restoredKey.current) return;
      restoredKey.current = null;
      navigationRef.dispatch(StackActions.popToTop());
    });
    const timer = setTimeout(off, WATCH_MS);
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [qc, watched]);

  const onReady = useCallback(() => {
    if (restore.state) restoredKey.current = navigationRef.getCurrentRoute()?.key ?? null;
  }, [restore.state]);

  return {
    ready: restore.ready,
    initialState: restore.state as InitialState | undefined,
    onReady,
    onStateChange: save.schedule,
  };
}
