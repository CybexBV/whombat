/**
 * “What’s new” on the phone: the web app's page of what changed in Whombat lately (public on the hosted app, so the
 * phone opens it in the browser), its row in About, and the one-time “Whombat updated” notice after an update. What
 * this phone saw last is kept per Whombat in the secure store; a store that can't be read shows nothing.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import {
  onSessionReopen,
  WHATS_NEW_PATH,
  WHATS_NEW_TEXT,
  whatsNewNotice,
  whatsNewSeenKey,
} from '@whombat/client/managed';
import type { ApplianceStatus } from '@whombat/client/session';
import type { KeyValueStore } from '../lib/kv';
import { UI_ORIGINS } from './config';

export const WHATS_NEW_URL = `${UI_ORIGINS[0] ?? 'https://app.whombat.com'}${WHATS_NEW_PATH}`;

/** About's row under the updates. */
export const WHATS_NEW_ROW = {
  title: WHATS_NEW_TEXT.link,
  body: WHATS_NEW_TEXT.linkMeta,
  label: `${WHATS_NEW_TEXT.link}. ${WHATS_NEW_TEXT.linkMeta}`,
} as const;

/** Checks of one store and Whombat waiting for the one before them (see `whatsNewToShow`). */
const turns = new WeakMap<KeyValueStore, Map<string, Promise<unknown>>>();

function inTurn<T>(store: KeyValueStore, key: string, run: () => Promise<T>): Promise<T> {
  let queue = turns.get(store);
  if (!queue) {
    queue = new Map();
    turns.set(store, queue);
  }
  const next = (queue.get(key) ?? Promise.resolve()).then(run, run);
  queue.set(key, next);
  return next;
}

/**
 * Updates kept as seen by a watcher that stopped before it could tell (the app moved to another Whombat while it kept
 * the release): the next check of that Whombat tells of it instead.
 */
const untold = new WeakMap<KeyValueStore, Map<string, string>>();

function untoldOf(store: KeyValueStore): Map<string, string> {
  let map = untold.get(store);
  if (!map) {
    map = new Map();
    untold.set(store, map);
  }
  return map;
}

/**
 * The release the notice tells about, or null for none. It is kept as seen at once, so the notice shows once even when
 * nobody taps it; the first look only remembers the release (there is nothing to compare it with), quietly; a release
 * that can't be kept says nothing. Checks of one Whombat run one after another, so a slow write can't land after a newer
 * one and bring an update back.
 */
export function whatsNewToShow(
  store: KeyValueStore,
  whombat: string,
  status: Pick<ApplianceStatus, 'update'> | null | undefined,
  live: () => boolean = () => true,
): Promise<string | null> {
  const key = whatsNewSeenKey(whombat);
  return inTurn(store, key, async () => {
    let seen: string | null;
    try {
      seen = await store.get(key);
    } catch {
      return null;
    }
    // Gone while reading (the app moved to another Whombat): nothing is kept, so coming back still tells.
    if (!live()) return null;
    const waiting = untoldOf(store);
    // An older answer (a status from before the update) never replaces what is kept: it says 'none'.
    const { action, release, value } = whatsNewNotice(status, seen);
    if (action === 'none') {
      const missed = waiting.get(key) ?? null;
      waiting.delete(key);
      return missed;
    }
    // Not kept, it would tell again at every start: it says nothing, as when the store can't be read.
    try {
      await store.set(key, value);
    } catch {
      return null;
    }
    if (action !== 'show') return null;
    waiting.delete(key);
    // Gone while keeping it: the next check of this Whombat tells.
    if (!live()) waiting.set(key, release);
    return release;
  });
}

/**
 * Checks each status answer of one Whombat and calls `show` for the update to tell about, until stopped. A later
 * answer never cancels an earlier one's notice: the earlier one already kept the release, so only it can tell.
 */
export function whatsNewWatcher(
  store: KeyValueStore,
  whombat: string,
  show: (release: string) => void,
): { see: (status: Pick<ApplianceStatus, 'update'> | null | undefined) => void; stop: () => void } {
  let live = true;
  return {
    see: (status) => {
      if (!status) return;
      void whatsNewToShow(store, whombat, status, () => live).then((release) => {
        if (live && release) show(release);
      });
    },
    stop: () => {
      live = false;
    },
  };
}

/**
 * Asks for the status again each time the box's session opens after a drop (an update restarts the box), however
 * fresh the last answer, and remembers when: for a short while after, a missing or failed answer is asked again. A
 * session already open counts as just opened, so the first answer gets the same second chance.
 */
export function watchStatusOnReopen(
  session: Parameters<typeof onSessionReopen>[0],
  queryClient: QueryClient,
  queryKey: QueryKey,
): { stop: () => void; backAt: () => number } {
  let backAt = session.state().status === 'open' ? Date.now() : 0;
  const stop = onSessionReopen(session, () => {
    backAt = Date.now();
    void queryClient.invalidateQueries({ queryKey });
  });
  return { stop, backAt: () => backAt };
}

/** What the strip under the status bar draws: both notices while the session is open, neither waiting for the other. */
export function stripNotices({
  open,
  nudge,
  whatsNew,
}: {
  open: boolean;
  nudge: boolean;
  whatsNew: boolean;
}): {
  nudge: boolean;
  whatsNew: boolean;
} {
  return { nudge: open && nudge, whatsNew: open && whatsNew };
}
