/**
 * A screen elsewhere's own ops (docs/decisions/desk-display.md DK-138, DK-146; desk-display-server.md “Screens
 * elsewhere”): `screen.state`, `screen.unlock`, `screen.lock` and `screen.image`, always for the screen whose endpoint
 * asks (`managed/display.ts` finds it). What a screen draws is the screens' store's (`ScreensApi.draw`, `picture`); this
 * keeps each screen's lock, in memory.
 *
 * - **The lock.** Locked as the box's lock says (`desk_screens.locked_view`: *Only the time* draws nothing at all)
 *   unless unlocked with the box screen's PIN. Unlocked lasts until `SCREEN_UNLOCK_IDLE_MS` after the screen last asked
 *   for its state (the page asks while it's used and locks itself after two minutes untouched; when it stops asking,
 *   this locks), never longer than `SCREEN_UNLOCK_MAX_MS`, and ends at once when the box's PIN changed or went. A PIN
 *   is the box's own, checked by the desk (`checkPin`): one count of wrong ones for the box and every screen, kept in
 *   the database (five, then a wait from a minute doubling to an hour, the fifth told to the person), one PIN at a
 *   time, and nothing is checked while the box waits.
 * - **The state.** `etag` is a hash of the answer without its times; `{same}` when the page already has it.
 * - **Pictures.** Only one that a view of this screen names and its lock lets show now (the store decides); every
 *   refusal is the same `not_found`.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_DESK_SETTINGS,
  DESK_SCREEN_UNLOCK_IDLE_S,
  DESK_WORDS,
  type DeskCalmView,
  type DeskLockedView,
  type DeskScreenSize,
  deskTriesLeft,
} from '@whombat/core';
import {
  DESK_ERROR_STATUS,
  type DeskErrorCode,
  type ScreenImage,
  type ScreenLock,
  type ScreenStateOutput,
} from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { personalPlace } from '../guides/place';
import { ApiError } from '../lib/errors';
import { SessionOpError } from '../managed/session-error';
import type { Services } from '../services';
import { screenText } from './glance';
import { loadDeskRow, loadWhombatName } from './store';
import type { ScreenRecord, ScreensApi } from './widgets/types';

/** An unlocked screen elsewhere locks this long after it last asked for its state. */
export const SCREEN_UNLOCK_IDLE_MS = DESK_SCREEN_UNLOCK_IDLE_S * 1000;
/** …and this long after it was unlocked, however much it is used. */
export const SCREEN_UNLOCK_MAX_MS = 30 * 60_000;
/** How often a screen's size and its being there are written while nothing changes. */
export const SCREEN_SEEN_EVERY_MS = 60_000;
/** A size that changed is written at most this often (a page flipping between two sizes costs one write in 30 s). */
export const SCREEN_SIZE_EVERY_MS = 30_000;
/** The picture types a screen draws. */
const PICTURE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** `ScreenImage.data`'s bound. */
const PICTURE_BASE64_MAX = 4_500_000;

/** A `desk.*` refusal as the other desk ops make them: the generic code, the desk's own in `details.code`. */
export function screenError(
  code: DeskErrorCode,
  message: string,
  extra: { triesLeft?: number } = {},
): SessionOpError {
  return new SessionOpError(DESK_ERROR_STATUS[code], message, { code, ...extra });
}

/** Every picture refusal is the same, so asking says nothing about what exists. */
const noPicture = () => new ApiError('not_found', 'That picture isn’t there.');

export interface ScreenLockSettings {
  /** What a locked screen shows (the box's lock choice). */
  view: DeskLockedView;
  /** The box screen's PIN hash; null when there is none (a screen can't be unlocked then). */
  pinHash: string | null;
  /** Wrong PINs since the last right one, at the box and every screen alike. */
  wrongPins: number;
  /** Until when the box waits after five wrong PINs (ms), or null. */
  retryAt: number | null;
}

/** A PIN typed on a screen elsewhere, checked as the box's own (`DeskService.checkScreenPin`). */
export type ScreenPinCheck =
  | { result: 'right'; pinHash: string }
  | { result: 'wrong'; triesLeft: number }
  | { result: 'backoff'; retryAt: number };

export interface ScreenSessionsDeps {
  api: ScreensApi;
  /** The box's lock choice and PIN (`desk_screens`), read each time: a change holds at the next ask. */
  lockSettings(): Promise<ScreenLockSettings>;
  /** The Whombat's name for the top bar. */
  whombatName(screen: ScreenRecord): Promise<string>;
  /** The assistant's name for Whombat's own widgets' words; null when there's none to name. */
  assistantName?(screen: ScreenRecord): Promise<string | null>;
  /** Checks a PIN as the box's own: the same count, wait and telling (`DeskService.checkScreenPin`). */
  checkPin(pin: string): Promise<ScreenPinCheck>;
  clock: () => number;
  log?: Pick<Services['log'], 'info' | 'warn'>;
}

interface LockState {
  /** Unlocked until then (0: locked). */
  until: number;
  unlockedAt: number;
  /** The PIN it was unlocked with: another one since locks it. */
  pinHash: string | null;
  /** One PIN, lock or unlock at a time per screen. */
  queue: Promise<unknown>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The answer's hash, without what moves on every ask (its time, an unlock's end). */
function etagOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 32);
}

export class ScreenSessions {
  readonly #locks = new Map<string, LockState>();
  readonly #seen = new Map<string, { at: number; size: string }>();

  constructor(private readonly deps: ScreenSessionsDeps) {}

  /** The screens' store, for adding a device (`desk.screen.add`). */
  get api(): ScreensApi {
    return this.deps.api;
  }

  #lockOf(id: string): LockState {
    let l = this.#locks.get(id);
    if (!l) {
      // Screens removed long ago leave their entry; a few hundred is far past any box's screens.
      if (this.#locks.size > 256) this.#locks.clear();
      l = { until: 0, unlockedAt: 0, pinHash: null, queue: Promise.resolve() };
      this.#locks.set(id, l);
    }
    return l;
  }

  #unlocked(l: LockState, settings: ScreenLockSettings, now: number): boolean {
    return settings.pinHash !== null && l.pinHash === settings.pinHash && now < l.until;
  }

  #view(l: LockState, settings: ScreenLockSettings, now: number): ScreenLock {
    const base = { view: settings.view, hasPin: settings.pinHash !== null };
    if (this.#unlocked(l, settings, now)) return { state: 'unlocked', ...base, until: iso(l.until) };
    if (settings.retryAt !== null && settings.retryAt > now)
      return { state: 'backoff', ...base, retryAt: iso(settings.retryAt), triesLeft: 0 };
    const wrong = settings.wrongPins;
    return { state: 'locked', ...base, ...(wrong > 0 ? { triesLeft: deskTriesLeft(wrong) } : {}) };
  }

  /** Runs `fn` after the screen's earlier PIN, lock or unlock. */
  #queued<T>(l: LockState, fn: () => Promise<T>): Promise<T> {
    const run = l.queue.then(fn);
    l.queue = run.catch(() => {});
    return run;
  }

  /** Its size, and that it is there: a change at most every 30 s, else once a minute; never waited for. */
  #seenNow(screen: ScreenRecord, size: DeskScreenSize, now: number): void {
    const key = `${size.width}x${size.height}`;
    const last = this.#seen.get(screen.id);
    if (last && now - last.at < (last.size === key ? SCREEN_SEEN_EVERY_MS : SCREEN_SIZE_EVERY_MS)) return;
    if (this.#seen.size > 256) this.#seen.clear();
    this.#seen.set(screen.id, { at: now, size: key });
    this.deps.api
      .seen(screen.id, size, new Date(now))
      .catch((err) => this.deps.log?.warn({ err: String(err) }, 'screens: a screen’s size wasn’t kept'));
  }

  /** What the lock lets the screen show now: everything unlocked, else the box's choice. */
  async #drawView(
    screen: ScreenRecord,
    now: number,
  ): Promise<{ view: DeskCalmView; settings: ScreenLockSettings }> {
    const settings = await this.deps.lockSettings();
    const l = this.#lockOf(screen.id);
    return { view: this.#unlocked(l, settings, now) ? 'everything' : settings.view, settings };
  }

  /** `screen.state {size, known?}`: what the screen draws now, or `{same}`; asking while unlocked keeps it unlocked. */
  async state(
    screen: ScreenRecord,
    input: { size: DeskScreenSize; known?: string },
  ): Promise<ScreenStateOutput> {
    const now = this.deps.clock();
    this.#seenNow(screen, input.size, now);
    const settings = await this.deps.lockSettings();
    const l = this.#lockOf(screen.id);
    if (this.#unlocked(l, settings, now))
      l.until = Math.min(now + SCREEN_UNLOCK_IDLE_MS, l.unlockedAt + SCREEN_UNLOCK_MAX_MS);
    const lock = this.#view(l, settings, now);
    const view: DeskCalmView = lock.state === 'unlocked' ? 'everything' : settings.view;
    // *Only the time*: nothing is resolved at all, so nothing can leak.
    const drawn = view === 'time' ? null : await this.deps.api.draw(screen, view);
    const body = {
      screen: { id: screen.id, name: screen.name, popups: screen.popups },
      whombat: await this.deps.whombatName(screen),
      ...(await this.#assistant(screen)),
      ...(await this.#zone(screen)),
      lock,
      calm: drawn?.calm ?? null,
      grid: drawn?.grid ?? null,
    };
    const { until: _until, ...steady } = lock;
    const etag = etagOf({ ...body, lock: steady });
    if (input.known === etag) return { same: true, etag };
    return { etag, now: iso(now), ...body };
  }

  async #assistant(screen: ScreenRecord): Promise<{ assistant?: string }> {
    const name = await this.deps.assistantName?.(screen).catch(() => null);
    return name ? { assistant: name } : {};
  }

  /** The person's time zone, for the clock and the pages by time of day; none: the device's own. */
  async #zone(screen: ScreenRecord): Promise<{ timeZone?: string }> {
    const zone = await this.deps.api.timeZone?.(screen).catch(() => null);
    return zone ? { timeZone: zone.slice(0, 64) } : {};
  }

  /**
   * `screen.unlock {pin}`: the box screen's PIN unlocks it. It is checked as the box's own (`checkPin`): a wrong one
   * counts for the box and every screen, and while the box waits nothing is checked.
   */
  async unlock(screen: ScreenRecord, pin: string): Promise<ScreenLock> {
    const l = this.#lockOf(screen.id);
    return this.#queued(l, async () => {
      const settings = await this.deps.lockSettings();
      if (!settings.pinHash) throw screenError('no_pin', DESK_WORDS.errors.no_pin);
      // Waiting: the PIN isn't even checked.
      if (settings.retryAt !== null && settings.retryAt > this.deps.clock())
        return this.#view(l, settings, this.deps.clock());
      const checked = await this.deps.checkPin(pin);
      const now = this.deps.clock();
      const base = { view: settings.view, hasPin: true };
      if (checked.result === 'right') {
        l.unlockedAt = now;
        l.until = now + SCREEN_UNLOCK_IDLE_MS;
        l.pinHash = checked.pinHash;
        return { state: 'unlocked', ...base, until: iso(l.until) };
      }
      if (checked.result === 'backoff')
        return { state: 'backoff', ...base, retryAt: iso(checked.retryAt), triesLeft: 0 };
      return { state: 'locked', ...base, triesLeft: checked.triesLeft };
    });
  }

  /** `screen.lock`: locked at once. */
  async lock(screen: ScreenRecord): Promise<ScreenLock> {
    const l = this.#lockOf(screen.id);
    return this.#queued(l, async () => {
      l.until = 0;
      l.pinHash = null;
      return this.#view(l, await this.deps.lockSettings(), this.deps.clock());
    });
  }

  /** `screen.image {thing, ref}`: a picture one of its views names, if its lock lets it show now. */
  async image(screen: ScreenRecord, input: { thing: string; ref: string }): Promise<ScreenImage> {
    const { view } = await this.#drawView(screen, this.deps.clock());
    if (view === 'time') throw noPicture();
    const picture = await this.deps.api.picture(screen, view, input.thing, input.ref).catch(() => null);
    if (!picture || !PICTURE_TYPES.has(picture.type)) throw noPicture();
    const data = Buffer.from(picture.bytes).toString('base64');
    if (data.length > PICTURE_BASE64_MAX) throw noPicture();
    return { type: picture.type as ScreenImage['type'], data };
  }
}

/**
 * The screen ops over the database: the box's lock, PIN and wait, the Whombat's name as the box's top bar has it, and
 * PINs checked as the box's own (`DeskService.checkScreenPin`).
 */
export function screenSessionsFor(
  services: Services,
  api: ScreensApi,
  checkPin: (pin: string) => Promise<ScreenPinCheck>,
): ScreenSessions {
  return new ScreenSessions({
    api,
    checkPin,
    clock: () => services.clock().getTime(),
    log: services.log,
    async lockSettings() {
      const row = await loadDeskRow(services.db);
      return {
        view: row?.lockedView ?? DEFAULT_DESK_SETTINGS.lockedView,
        pinHash: row?.pinHash ?? null,
        wrongPins: row?.wrongPins ?? 0,
        retryAt: row?.retryAt?.getTime() ?? null,
      };
    },
    async whombatName(screen) {
      const given = await loadWhombatName(services.db);
      if (given) return given;
      const [burrow] = await services.db
        .select({ name: burrows.name })
        .from(burrows)
        .where(eq(burrows.id, screen.burrowId));
      return screenText(burrow?.name, 40) || 'Whombat';
    },
    async assistantName(screen) {
      const personId = screen.personId ?? (await loadDeskRow(services.db))?.personId;
      if (!personId) return null;
      const place = await personalPlace(services.db, screen.burrowId, personId);
      return screenText(place?.agent.name, 40) || null;
    },
  });
}
