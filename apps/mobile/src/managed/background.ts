/**
 * The appliance connection while the app is away (AP-925, AP-926). In the background the connection is let go after
 * `BACKGROUND_GRACE_MS` (a quick look at another app keeps it), unless work is under way (the session says so) or a live
 * activity is on screen (a managed Whombat sends no live pushes, NT-13: its updates come only through the connection);
 * those are asked again every `BUSY_RETRY_MS`. Something that needs the connection while it is let go (a push that
 * reloads a list) opens it again, and it goes again after the grace. Back in the foreground it opens at once; the
 * subscriptions resume from their cursors, and the appliance asks for a resync where it can't (WE-04). One that still
 * says it is open after a while away is checked (`probe`): Android stops the app's timers in the background and mobile
 * networks drop quiet sockets without a word.
 *
 * A read is refetched on coming back or on getting online only when it may have missed a change: the live updates
 * came back without picking up where they left off since it was answered, or nothing changed it for a while
 * (`createFreshness`). A connection let go in
 * the background and opened again resumes its subscription from its cursor, so the events it missed arrive and nothing
 * needs reading again; one that can't resume says so, and what its topics feed is read again then (`onResync`).
 *
 * Box reads run while the box can be reached (`createBoxReach`): an open connection, whatever the phone thinks of the
 * internet (a Wi-Fi with no internet still reaches the box on its direct way).
 *
 * Pure: the session, the timers' clock and the live-activity check are passed in.
 */
import type { QueryClient } from '@tanstack/query-core';
import type { Realtime } from '@whombat/client';
import type { ApplianceSession } from '@whombat/client/session';

/** In the background the connection is let go after this long. */
export const BACKGROUND_GRACE_MS = 2 * 60_000;
/** Work under way or a live activity on screen: asked again this much later. */
export const BUSY_RETRY_MS = 30_000;
/** Back after this long away, a connection that says it is open is checked before it is trusted. */
export const WAKE_CHECK_AFTER_MS = 30_000;

type Connection = Pick<
  ApplianceSession,
  'state' | 'onState' | 'connect' | 'reconnectNow' | 'suspend' | 'probe'
>;

export interface BackgroundRelease {
  /** The app went to the background. */
  background(): void;
  /** The app is in the foreground again: the connection opens now (no backoff wait). */
  foreground(): void;
  dispose(): void;
}

export function createBackgroundRelease(input: {
  session: Connection;
  /** True while something on the phone still needs live updates (a live activity on screen). */
  keep: () => Promise<boolean>;
  graceMs?: number;
  retryMs?: number;
  now?: () => number;
}): BackgroundRelease {
  const { session } = input;
  const graceMs = input.graceMs ?? BACKGROUND_GRACE_MS;
  const retryMs = input.retryMs ?? BUSY_RETRY_MS;
  const now = input.now ?? Date.now;
  let away = false;
  let awayAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    clear();
    timer = setTimeout(() => void release(), ms);
  };
  async function release() {
    timer = null;
    if (!away) return;
    const kept = await input.keep().catch(() => false);
    // Back in the foreground meanwhile, or asked again.
    if (!away || timer) return;
    if (kept || !session.suspend?.()) schedule(retryMs);
  }
  // Opened again while away (something needed it): let go again after the grace.
  const off = session.onState((s) => {
    if (away && s.status === 'open' && !timer) schedule(graceMs);
  });
  return {
    background() {
      away = true;
      awayAt = now();
      schedule(graceMs);
    },
    foreground() {
      const wasAway = away;
      const awayFor = wasAway ? now() - awayAt : 0;
      away = false;
      clear();
      const status = session.state().status;
      if (status === 'idle') session.connect();
      else if (status !== 'open') session.reconnectNow();
      // Its timers stopped while away: the socket may have died without the session hearing of it.
      else if (awayFor >= WAKE_CHECK_AFTER_MS) session.probe?.();
      // A check begun in the background (another network) pinged before the freeze: it pings again now.
      else if (wasAway) session.probe?.({ onlyIfChecking: true });
    },
    dispose() {
      away = false;
      clear();
      off();
    },
  };
}

/** What the reach check reads of NetInfo's state. */
export interface NetSnapshot {
  type: string;
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
  details?: unknown;
}

/** The network the phone is on: its kind and, where NetInfo says, its address; null without one. */
export function networkKey(n: NetSnapshot): string | null {
  if (n.isConnected === false || n.type === 'none') return null;
  const ip = (n.details as { ipAddress?: unknown } | null | undefined)?.ipAddress;
  return `${n.type}|${typeof ip === 'string' ? ip : ''}`;
}

export interface BoxReach {
  /** NetInfo's newest state. */
  net(n: NetSnapshot): void;
  dispose(): void;
}

/**
 * Whether box reads may run (`setOnline`, TanStack's `onlineManager`): while the connection is open, or while the phone
 * says it is online (the connection is then being opened, and reads wait for it). An open connection on a Wi-Fi without
 * internet reaches the box on its direct way; going by the phone's internet check alone, every read waited there.
 *
 * NetInfo is a hint for the connection: connected again after none, or onto another network (`networkKey`), dials now
 * when it isn't open; another network while it is open checks it (`probe`), since its socket may be tied to the old
 * one. Nothing else counts: NetInfo repeats itself, and its internet check coming in (unknown or no internet, then yes)
 * is no new network, so neither dials.
 */
export function createBoxReach(input: {
  session: Pick<ApplianceSession, 'state' | 'onState' | 'reconnectNow' | 'probe'>;
  setOnline: (online: boolean) => void;
}): BoxReach {
  const { session } = input;
  let netOnline = true;
  // Unknown until NetInfo first says: that first answer is no change.
  let key: string | null | undefined;
  let shown: boolean | null = null;
  const update = () => {
    const online = session.state().status === 'open' || netOnline;
    if (online === shown) return;
    shown = online;
    input.setOnline(online);
  };
  const off = session.onState(update);
  update();
  return {
    net(n) {
      netOnline = n.isConnected !== false && n.isInternetReachable !== false;
      // Connected again, or onto another network: the key changes. The internet check coming in doesn't change it.
      const next = networkKey(n);
      const moved = key !== undefined && next !== key;
      key = next;
      if (moved && session.state().status === 'open') session.probe?.();
      else if (moved && next !== null) session.reconnectNow();
      update();
    },
    dispose: off,
  };
}

export interface Freshness {
  /** True when a read answered at `dataUpdatedAt` may have missed a change: refetch it on focus or reconnect. */
  missed(dataUpdatedAt: number): boolean;
  dispose(): void;
}

/**
 * When the live updates last came back without resuming, for `refetchOnWindowFocus` / `refetchOnReconnect`. Coming
 * back to the app usually happens before the connection is open again: asking every read on screen then would fetch
 * them all for nothing when the subscription resumes, as it does after a while in the background. So a read counts as
 * missed only once the subscription said it couldn't resume (or had to start over on some topics) after the read was
 * answered; those topics' reads are invalidated at that moment anyway (`invalidateForResync`), this catches the rest
 * on the next focus.
 */
export function createFreshness(
  session: Pick<ApplianceSession, 'state'>,
  realtime: Pick<Realtime, 'onResync'>,
  now: () => number = Date.now,
  quietMs: number = QUIET_READ_MS,
): Freshness {
  let lostAt = Number.NEGATIVE_INFINITY;
  const off = realtime.onResync(() => {
    lostAt = now();
  });
  return {
    // Not open: the subscription answers when it is, and resumes or says what was lost. A read nothing changed for
    // `quietMs` is asked again all the same: a change the live updates lost without saying so (an event this build
    // couldn't read, one the box never sent) is then on screen the next time the person comes back, not never.
    missed: (dataUpdatedAt) =>
      (session.state().status === 'open' && dataUpdatedAt < lostAt) || now() - dataUpdatedAt > quietMs,
    dispose: off,
  };
}

/** A read on screen that nothing changed for this long is read again on coming back to the app. */
export const QUIET_READ_MS = 5 * 60_000;
/** A read on screen that failed is asked again this often while the app is in the foreground. */
export const FAILED_READ_RETRY_MS = 30_000;

/** How often, in the foreground, the failed reads on screen whose wait is over are looked for. */
export const FAILED_READ_SWEEP_MS = 5_000;

/**
 * A read whose retry is due: it failed `FAILED_READ_RETRY_MS` ago or more, isn't being asked now, and the box didn't
 * answer that it won't (gone, not allowed, a bad request: a 4xx other than 408 and 429).
 */
export function failedReadDue(
  query: { state: { status: string; error: unknown; errorUpdatedAt: number; fetchStatus: string } },
  now: number,
): boolean {
  const { state } = query;
  if (state.status !== 'error' || state.fetchStatus !== 'idle') return false;
  const status = (state.error as { status?: unknown } | null)?.status;
  const refused =
    typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
  return !refused && now - state.errorUpdatedAt >= FAILED_READ_RETRY_MS;
}

/**
 * Asks again every read on screen that failed, `FAILED_READ_RETRY_MS` after it failed, while the app is in the
 * foreground (`failedReadDue`, looked for every `FAILED_READ_SWEEP_MS`); returns the stop function. With data from
 * before on screen most screens show no failure, so without this it stayed until the next return to the app.
 *
 * Not TanStack's `refetchInterval`: it starts over on every change to the query, a live update to what it shows too,
 * so a read patched more often than its interval (a busy conversation, a run's log) was never asked again.
 */
export function retryFailedReads(
  qc: Pick<QueryClient, 'refetchQueries'>,
  input: { foreground: () => boolean; now?: () => number; everyMs?: number },
): () => void {
  const now = input.now ?? Date.now;
  const timer = setInterval(() => {
    if (!input.foreground()) return;
    const at = now();
    void qc
      .refetchQueries({ type: 'active', predicate: (q) => failedReadDue(q, at) }, { cancelRefetch: false })
      .catch(() => {});
  }, input.everyMs ?? FAILED_READ_SWEEP_MS);
  return () => clearInterval(timer);
}
