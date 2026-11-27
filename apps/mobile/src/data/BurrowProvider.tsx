/**
 * The open burrow: bootstrap (me, principals, sidebar, preferences), realtime topics, the viewer's time
 * zone and the app clock. Screens read it with `useBurrow()` and build view models with `useViewContext()`.
 *
 * Every new message and read marker changes the bootstrap (its sidebar), so it has a context of its own (AP-900): who is
 * in the burrow, the viewer, the time zone and the clock (`useBurrowBase()`) change only when they do, and so does
 * `useViewContext()`; `now` moves in 15-second steps from one shared timer (`lib/now`).
 */

import { useBootstrap, useSubscription } from '@whombat/client/react';
import type { Bootstrap, Decider } from '@whombat/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useI18n } from '../i18n';
import { createNowStore, type NowStore } from '../lib/now';
import { deviceTimeZone, resolveTimeZone } from '../lib/time';
import type { AppMode } from './config';
import { type People, peopleFrom, type ViewContext, viewerOf } from './people';

export interface BurrowContextValue {
  slug: string;
  mode: AppMode;
  bootstrap: Bootstrap;
  people: People;
  viewer: Decider;
  timeZone: string;
  /** The app clock (real against a server; the fixture world runs from 11:22 on 23 September 2026). */
  clock: () => Date;
}

/** The burrow without its bootstrap: what doesn't change with every message (AP-900). */
export interface BurrowBase extends Omit<BurrowContextValue, 'bootstrap'> {
  /** The viewer as the bootstrap has them (the same object until they change). */
  me: Bootstrap['me'];
  /** The bootstrap as it is now, for an event handler (a tap) that needs it; reading it doesn't subscribe. */
  currentBootstrap: () => Bootstrap;
}

const BaseContext = createContext<BurrowBase | null>(null);
const BootstrapContext = createContext<Bootstrap | null>(null);
const NowContext = createContext<NowStore | null>(null);

export interface BurrowProviderProps {
  slug: string;
  mode: AppMode;
  clock: () => Date;
  /** Shown while the bootstrap loads or after it failed. */
  renderState: (state: { error: Error | null; retry: () => void }) => ReactNode;
  children: ReactNode;
}

export function BurrowProvider({ slug, mode, clock, renderState, children }: BurrowProviderProps) {
  const query = useBootstrap({ params: { burrow: slug } });
  const bootstrap = query.data;
  useSubscription(bootstrap?.realtime.topics);

  // Each from its own part of the bootstrap (the cache keeps unchanged parts the same objects), AP-900.
  const principals = bootstrap?.principals;
  const people = useMemo(() => (principals ? peopleFrom(principals) : null), [principals]);
  const me = bootstrap?.me;
  const viewer = useMemo(() => (me ? viewerOf({ me }) : null), [me]);
  // The device's zone is the last resort: asked (a new `Intl.DateTimeFormat`) only when the others change (AP-913).
  const preferredZone = bootstrap?.preferences.timeZone;
  const burrowZone = bootstrap?.burrow.timeZone;
  const timeZone = useMemo(
    () => resolveTimeZone([preferredZone, burrowZone, deviceTimeZone()]),
    [preferredZone, burrowZone],
  );
  const latest = useRef(bootstrap);
  latest.current = bootstrap;
  const currentBootstrap = useCallback(() => {
    if (!latest.current) throw new Error('The bootstrap is not loaded');
    return latest.current;
  }, []);
  const base = useMemo<BurrowBase | null>(
    () =>
      people && viewer && me ? { slug, mode, people, viewer, me, timeZone, clock, currentBootstrap } : null,
    [slug, mode, people, viewer, me, timeZone, clock, currentBootstrap],
  );
  const now = useMemo(() => createNowStore(clock), [clock]);

  if (!base || !bootstrap)
    return <>{renderState({ error: query.error, retry: () => void query.refetch() })}</>;
  return (
    <NowContext.Provider value={now}>
      <BaseContext.Provider value={base}>
        <BootstrapContext.Provider value={bootstrap}>{children}</BootstrapContext.Provider>
      </BaseContext.Provider>
    </NowContext.Provider>
  );
}

/** Everything but the bootstrap; doesn't re-render with every message (AP-900). */
export function useBurrowBase(): BurrowBase {
  const value = useContext(BaseContext);
  if (!value) throw new Error('useBurrowBase() must be used inside <BurrowProvider>');
  return value;
}

/** The burrow with its bootstrap; re-renders whenever the bootstrap changes (every new message does). */
export function useBurrow(): BurrowContextValue {
  const base = useBurrowBase();
  const bootstrap = useContext(BootstrapContext);
  if (!bootstrap) throw new Error('useBurrow() must be used inside <BurrowProvider>');
  return useMemo(() => ({ ...base, bootstrap }), [base, bootstrap]);
}

/**
 * The app clock for time labels: the same `Date` until it moves, every 15 seconds, for every reader at once
 * (`lib/now`, AP-900).
 */
export function useNow(): Date {
  const store = useContext(NowContext);
  if (!store) throw new Error('useNow() must be used inside <BurrowProvider>');
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The shared clock store itself, for code that reads `now` when it builds something instead of following it. */
export function useNowStore(): NowStore {
  const store = useContext(NowContext);
  if (!store) throw new Error('useNowStore() must be used inside <BurrowProvider>');
  return store;
}

const NO_SUBSCRIPTION = () => () => {};
const always = () => true;

/**
 * A label read from the shared `now`: the caller re-renders only when the label changes, not at every 15-second step
 * (a row's “just now” turns into its time once; “Last reply 12 min ago” once a minute). While `follows` says no, it
 * reads the label without listening to the clock (a label that can't change any more).
 */
export function useNowLabel<T extends string | null>(
  read: (now: Date) => T,
  follows: (now: Date) => boolean = always,
): T {
  const store = useNowStore();
  const live = follows(store.get());
  const snapshot = () => read(store.get());
  return useSyncExternalStore(live ? store.subscribe : NO_SUBSCRIPTION, snapshot, snapshot);
}

/** Everything the pure view models need: people, viewer, now and the time zone. */
export function useViewContext(): ViewContext {
  const { people, viewer, timeZone } = useBurrowBase();
  const now = useNow();
  const { rawLocale } = useI18n();
  return useMemo(
    () => ({ people, viewer, now, timeZone, locale: rawLocale }),
    [people, viewer, now, timeZone, rawLocale],
  );
}
