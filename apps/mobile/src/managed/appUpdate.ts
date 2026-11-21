/**
 * Whether a newer build of this app is out (AP-701): the APK control hands out (`downloads.android`, CT-191) against
 * this build's `versionCode`. “Update the app” is offered only when there is one; without it the notice says the update
 * is on its way and offers nothing to tap (DEV once served an old APK for days, and the button led to the same build).
 *
 * One answer for the whole app (update-check.md AP-2970): every screen that shows an update reads the same check, so
 * “Check for updates” in Settings moves the card on top, the banner and the tab dot at once. An answer counts five
 * minutes; the app asks again when it comes back to the front or Settings opens after that, and a forced check asks
 * now. It was an hour for the life of the process, so a phone left in the background only saw a new build after
 * the app was closed. Pure: control and the clock are injected, so the rule and the cache are unit-tested.
 */
import type { AndroidDownload } from '@whombat/client/managed';

/** How long an answer (or a failure) counts: asked again after it, at most this often. */
export const UPDATE_CHECK_FRESH_MS = 5 * 60_000;

/** A published APK newer than this build: its `versionCode` above ours. Unknown on either side: no. */
export function newerAppPublished(published: AndroidDownload | null, ownBuild: number | undefined): boolean {
  return !!published && ownBuild !== undefined && published.versionCode > ownBuild;
}

export interface UpdateCheckState {
  /** The APK control last named (null: none published, or not asked yet). A failed ask keeps the one before. */
  published: AndroidDownload | null;
  /** Control has answered at least once. */
  answered: boolean;
  /** A request is out. */
  checking: boolean;
  /** The last ask failed. */
  failed: boolean;
}

export interface UpdateCheck {
  /** Asks control unless an ask younger than `UPDATE_CHECK_FRESH_MS` stands, or now with `force`; one at a time. */
  get(force?: boolean): Promise<AndroidDownload | null>;
  state(): UpdateCheckState;
  subscribe(listener: () => void): () => void;
}

/** Before control has been asked. */
export const UPDATE_UNASKED: UpdateCheckState = {
  published: null,
  answered: false,
  checking: false,
  failed: false,
};

export function createUpdateCheck(
  fetch: () => Promise<AndroidDownload | null>,
  now: () => number = Date.now,
): UpdateCheck {
  let state = UPDATE_UNASKED;
  let askedAt: number | null = null;
  let pending: Promise<AndroidDownload | null> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<UpdateCheckState>) => {
    state = { ...state, ...next };
    for (const l of listeners) l();
  };
  return {
    get(force = false) {
      if (pending) return pending;
      if (!force && askedAt !== null && now() - askedAt < UPDATE_CHECK_FRESH_MS)
        return Promise.resolve(state.published);
      askedAt = now();
      set({ checking: true });
      pending = fetch().then(
        (published) => {
          pending = null;
          set({ published, answered: true, checking: false, failed: false });
          return published;
        },
        () => {
          pending = null;
          set({ checking: false, failed: true });
          return state.published;
        },
      );
      return pending;
    },
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const checks = new WeakMap<object, UpdateCheck>();

/** The one check per control client (it outlives a session: switching Whombats doesn't ask again). */
export function updateCheckFor(control: { androidDownload(): Promise<AndroidDownload | null> }): UpdateCheck {
  let check = checks.get(control);
  if (!check) {
    check = createUpdateCheck(() => control.androidDownload());
    checks.set(control, check);
  }
  return check;
}

/**
 * Where this app stands, for the VERSION card's “This app” row (AP-2972): a newer build is out, this is the newest,
 * the check is running, it failed, or nothing is known yet (no answer, or this build doesn't know its number).
 */
export type AppUpdateStatus = 'newer' | 'newest' | 'checking' | 'failed' | 'unknown';

export function appUpdateStatus(state: UpdateCheckState, ownBuild: number | undefined): AppUpdateStatus {
  if (newerAppPublished(state.published, ownBuild)) return 'newer';
  if (state.checking) return 'checking';
  if (state.failed) return 'failed';
  return state.answered && ownBuild !== undefined ? 'newest' : 'unknown';
}
