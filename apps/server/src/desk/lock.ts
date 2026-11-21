/**
 * What the runtime holds in memory for the desk screen (docs/decisions/desk-display.md DK-02, DK-04, DK-28…DK-30,
 * DK-74; desk-display-server.md DK-S03, DK-S06, DK-S07, DK-S35, DK-S71): the pairing letters, whether the screen is
 * unlocked (until a time, or until Lock) and what the camera saw since. Nothing of it is written here: a runtime restart
 * ends a pairing and locks the screen, unless an unlock that stays was kept with its boot (DK-75, the service's). The
 * clock is passed in, so the rules are tested without waiting.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PRESENCE_KEEP_S, type PresenceState } from '@whombat/control-contracts/local';
import {
  DESK_PAIRING_TTL_S,
  DESK_PHONE_UNLOCK_TTL_S,
  DESK_PRESENCE_GONE_S,
  DESK_PRESENCE_MAX_S,
  DESK_TRIES,
  DESK_UNLOCKED_IDLE_S,
} from '@whombat/core';
import { generateClaimLetters } from '@whombat/protocol/claim';
import type { PresenceSeen } from './presence';
import type { DeskLockState } from './shapes';

/** How long the letters are shown (DK-02). */
export const PAIRING_TTL_MS = DESK_PAIRING_TTL_S * 1000;
/** Wrong letters before new ones are drawn (DK-02). */
export const PAIRING_TRIES = DESK_TRIES;
/** An unlocked screen locks this long after the last touch (DK-04). */
export const UNLOCK_IDLE_MS = DESK_UNLOCKED_IDLE_S * 1000;
/** How long the phone has to answer “Your desk screen wants to unlock” (DK-04). */
export const UNLOCK_REQUEST_TTL_MS = DESK_PHONE_UNLOCK_TTL_S * 1000;
/** Once the camera saw a face: the screen locks this long after the last face or touch (DK-28). */
export const PRESENCE_GONE_MS = DESK_PRESENCE_GONE_S * 1000;
/** The camera keeps an unlock for at most this long in a row (DK-28). */
export const PRESENCE_MAX_MS = DESK_PRESENCE_MAX_S * 1000;
/** The service turns the camera off by itself this long after the last watch (DK-30). */
export const PRESENCE_KEEP_MS = PRESENCE_KEEP_S * 1000;
/** A `watching` whose latest frame is older than this isn't watching: the camera stopped sending pictures (DK-S35). */
export const PRESENCE_FRAME_STALE_MS = 5_000;

/** What the service answers while the camera is open. */
export const CAMERA_ON: ReadonlySet<PresenceState> = new Set(['starting', 'watching', 'dark']);

const lettersFrom = (random: (n: number) => Uint8Array) => generateClaimLetters(random);
const systemRandom = (n: number) => new Uint8Array(randomBytes(n));

export type PairingCheck =
  | { ok: true }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'wrong'; triesLeft: number };

/** The four letters the screen shows while the person pairs it (DK-02). */
export class DeskPairing {
  #letters: string | null = null;
  #expiresAt = 0;
  #wrong = 0;

  constructor(private readonly random: (n: number) => Uint8Array = systemRandom) {}

  /** New letters for 10 minutes; a pairing already shown starts again. */
  start(now: number): { code: string; expiresAt: number } {
    this.#letters = lettersFrom(this.random);
    this.#expiresAt = now + PAIRING_TTL_MS;
    this.#wrong = 0;
    return { code: this.#letters, expiresAt: this.#expiresAt };
  }

  /** The letters on the screen now, or null. */
  live(now: number): { code: string; expiresAt: number } | null {
    if (!this.#letters || now >= this.#expiresAt) return null;
    return { code: this.#letters, expiresAt: this.#expiresAt };
  }

  /**
   * Checks typed letters. Right: the pairing ends (the caller pairs). The fifth wrong one draws new letters, shown until
   * the same end: whoever types them must read them off the screen again.
   */
  check(typed: string, now: number): PairingCheck {
    const live = this.live(now);
    if (!live) return { ok: false, reason: 'expired' };
    const a = Buffer.from(typed.toUpperCase());
    const b = Buffer.from(live.code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      this.end();
      return { ok: true };
    }
    this.#wrong += 1;
    if (this.#wrong >= PAIRING_TRIES) {
      this.#letters = lettersFrom(this.random);
      this.#wrong = 0;
      return { ok: false, reason: 'wrong', triesLeft: PAIRING_TRIES };
    }
    return { ok: false, reason: 'wrong', triesLeft: PAIRING_TRIES - this.#wrong };
  }

  end(): void {
    this.#letters = null;
    this.#expiresAt = 0;
    this.#wrong = 0;
  }
}

export interface UnlockRequest {
  id: string;
  expiresAt: number;
}

export interface LockView {
  state: DeskLockState;
  until?: number;
  retryAt?: number;
  expiresAt?: number;
  /** Unlocked: the camera is on now (DK-30). */
  camera?: boolean;
  /** Unlocked: the camera sees someone, and the screen locks at most 30 s after they go (DK-28). */
  present?: boolean;
  /** Unlocked until someone presses Lock (DK-74): `until` is 2 minutes after the view's `now`, every time. */
  stays?: boolean;
}

/** The camera watching for this unlock (the loop runs). */
interface Watch {
  /** The latest answer was `watching` on a fresh frame: once a face was seen, the camera's rule holds (DK-28). */
  keeps: boolean;
  /** Since when it keeps: a picture back from dark has its 30 s from then. */
  since: number;
  /** The camera is on until then, as far as the runtime knows: the last answer that said so + the service's 6 s. */
  cameraUntil: number;
}

/**
 * Locked or unlocked, and a phone unlock waiting for its answer (DK-04). Unlocked lasts 2 minutes past the last touch;
 * the lock button locks at once. The wait after five wrong PINs is the database's (`retry_at`): it is passed in.
 *
 * An unlock that stays (*When you press Lock*, DK-74, DK-S71) is unlocked until `lock`: no time locks it and the camera
 * keeps nothing of it; its view says `stays` with `until` 2 minutes after the view's time, so a console that stops
 * hearing from Whombat draws it locked. The choice changed while unlocked (`stay`): on, the unlock going on stays; off,
 * it counts as made then (the 2 minutes, the camera's 30 s and its 4 hours from the change). Neither is a new epoch.
 *
 * With the camera (DK-28, DK-S35): before the first face since this unlock, and whenever the latest answer isn't
 * `watching`, DK-04's rule holds with the last face counted as a touch (2 minutes after the later of the two). Once a
 * face was seen and the camera is watching, the screen locks 30 s after the later of the last face and the last touch
 * (a picture back from dark: 30 s from then, never past DK-04's 2 minutes). A face keeps it at most until the unlock +
 * 4 hours and counts only from frames after the unlock; past the 4 hours a touch keeps DK-04's rule as before. The time
 * it locks is worked out at each event (unlock, touch, an answer, the loop stopping), the 4 hours included, and an
 * event on a screen that has locked by then does nothing, so a lock is never undone.
 */
export class DeskLock {
  #epoch = 0;
  #unlockedAt = 0;
  #touchedAt = 0;
  #until = 0;
  /** The last face since this unlock (from frames after it and before its 4 hours), or null. */
  #faceAt: number | null = null;
  #watch: Watch | null = null;
  /** Unlocked until Lock (DK-74). */
  #stays = false;
  #request: UnlockRequest | null = null;

  constructor(private readonly newId: () => string = () => `dur_${randomUUID().replaceAll('-', '')}`) {}

  /** Which unlock this is: every unlock and lock makes a new one, so what was seen for an earlier one is dropped. */
  get epoch(): number {
    return this.#epoch;
  }

  unlocked(now: number): boolean {
    return this.#stays || now < this.#until;
  }

  /** Unlocked until someone presses Lock (DK-74). */
  get stays(): boolean {
    return this.#stays;
  }

  /** When the screen locks unless something keeps it (in the past once it is locked; never while it stays). */
  untilAt(): number {
    return this.#stays ? Number.POSITIVE_INFINITY : this.#until;
  }

  /** The end of the 4 hours the camera may keep this unlock (DK-28). */
  presenceEndsAt(): number {
    return this.#unlockedAt + PRESENCE_MAX_MS;
  }

  /** The state the screen draws: unlocked, else a phone request waiting, else the PIN wait, else locked. */
  view(now: number, retryAt: number | null): LockView {
    if (this.#stays) return { state: 'unlocked', until: now + UNLOCK_IDLE_MS, stays: true };
    if (this.unlocked(now)) {
      const w = this.#watch;
      const camera = !!w && now < w.cameraUntil;
      const present = camera && !!w?.keeps && this.#faceAt !== null && now - this.#faceAt < PRESENCE_GONE_MS;
      return {
        state: 'unlocked',
        until: this.#until,
        ...(camera ? { camera: true } : {}),
        ...(present ? { present: true } : {}),
      };
    }
    const request = this.request(now);
    if (request) return { state: 'phone', expiresAt: request.expiresAt };
    if (retryAt !== null && retryAt > now) return { state: 'backoff', retryAt };
    return { state: 'locked' };
  }

  /** Unlocked by a PIN or the phone (or again after a restart on the same boot, DK-75); `stays` until Lock (DK-74). */
  unlock(now: number, stays = false): number {
    this.#epoch++;
    this.#unlockedAt = now;
    this.#touchedAt = now;
    this.#faceAt = null;
    this.#watch = null;
    this.#stays = stays;
    this.#until = now + UNLOCK_IDLE_MS;
    this.#request = null;
    return this.#until;
  }

  /** A touch keeps an unlocked screen unlocked; null when it is locked. Staying: 2 minutes from now, as its view says. */
  touch(now: number): number | null {
    if (!this.unlocked(now)) return null;
    this.#touchedAt = now;
    if (this.#stays) return now + UNLOCK_IDLE_MS;
    this.#recompute();
    return this.#until;
  }

  lock(): void {
    this.#epoch++;
    this.#until = 0;
    this.#unlockedAt = 0;
    this.#faceAt = null;
    this.#watch = null;
    this.#stays = false;
  }

  /**
   * *Lock again* changed while the screen is unlocked (DK-74, DK-S71). To *When you press Lock*: the unlock going on
   * stays (what the camera saw is forgotten; it keeps nothing now). From it: the unlock counts as made now — DK-04's 2
   * minutes from the change (it counts as a touch), and with the camera (DK-28) its 30 s and 4 hours from then too. False
   * when the screen is locked: a choice never unlocks.
   */
  stay(stays: boolean, now: number): boolean {
    if (!this.unlocked(now)) return false;
    if (stays === this.#stays) return true;
    this.#faceAt = null;
    this.#watch = null;
    this.#stays = stays;
    if (!stays) {
      this.#unlockedAt = now;
      this.#touchedAt = now;
      this.#until = now + UNLOCK_IDLE_MS;
    }
    return true;
  }

  /**
   * The camera starts watching for the unlock `epoch`; false when that isn't the screen's unlock any more, or it stays
   * (nothing the camera sees matters to it then).
   */
  watchFrom(epoch: number, now: number): boolean {
    if (this.#stays || epoch !== this.#epoch || !this.unlocked(now)) return false;
    this.#watch ??= { keeps: false, since: now, cameraUntil: 0 };
    return true;
  }

  /**
   * What a watch saw, for the unlock `epoch`. A face counts from `seenAt` (else the frame's time when the latest has
   * one), only from frames after the unlock and before its 4 hours, and never later than now. False when the screen
   * is locked (now, or by what was seen): the loop stops.
   */
  seen(epoch: number, seen: PresenceSeen, now: number): boolean {
    const w = this.#watch;
    if (epoch !== this.#epoch || !w || !this.unlocked(now)) return false;
    const fresh = seen.frameAt !== null && now - seen.frameAt <= PRESENCE_FRAME_STALE_MS;
    const keeps = seen.state === 'watching' && fresh;
    if (keeps && !w.keeps) w.since = now;
    w.keeps = keeps;
    w.cameraUntil = CAMERA_ON.has(seen.state) ? now + PRESENCE_KEEP_MS : 0;
    const face = seen.seenAt ?? (seen.face ? seen.frameAt : null);
    if (face !== null) {
      const at = Math.min(face, now);
      if (at >= this.#unlockedAt && at < this.presenceEndsAt())
        this.#faceAt = Math.max(this.#faceAt ?? at, at);
    }
    this.#recompute();
    return this.unlocked(now);
  }

  /** A watch that failed or was too slow: DK-04's rule until the next answer (the camera may still be on). */
  unanswered(epoch: number, now: number): boolean {
    const w = this.#watch;
    if (epoch !== this.#epoch || !w || !this.unlocked(now)) return false;
    w.keeps = false;
    this.#recompute();
    return this.unlocked(now);
  }

  /** The loop stopped (the switch off, the 4 hours, a lock): DK-04's rule for the rest of an unlock still going. */
  unwatched(epoch: number, now: number): void {
    if (epoch !== this.#epoch || !this.#watch) return;
    this.#watch = null;
    if (this.unlocked(now)) this.#recompute();
  }

  #recompute(): void {
    const face = this.#faceAt;
    const w = this.#watch;
    const keeps = !!w?.keeps && face !== null;
    let until = this.#touchedAt + (keeps ? PRESENCE_GONE_MS : UNLOCK_IDLE_MS);
    if (face !== null) {
      const kept =
        keeps && w
          ? Math.min(Math.max(face, w.since) + PRESENCE_GONE_MS, face + UNLOCK_IDLE_MS)
          : face + UNLOCK_IDLE_MS;
      until = Math.max(until, Math.min(kept, this.presenceEndsAt()));
    }
    // Unlocked through the 4 hours: from then on the camera keeps nothing and a touch has DK-04's 2 minutes again.
    if (until >= this.presenceEndsAt()) until = Math.max(until, this.#touchedAt + UNLOCK_IDLE_MS);
    this.#until = until;
  }

  /**
   * Asks the phone (one request at a time): a request still waiting is the answer again (`fresh` false), so pressing
   * the button twice doesn't ring the phone twice.
   */
  ask(now: number): { request: UnlockRequest; fresh: boolean } {
    const live = this.request(now);
    if (live) return { request: live, fresh: false };
    this.#request = { id: this.newId(), expiresAt: now + UNLOCK_REQUEST_TTL_MS };
    return { request: this.#request, fresh: true };
  }

  /** The live phone request, or null. */
  request(now: number): UnlockRequest | null {
    if (this.#request && now >= this.#request.expiresAt) this.#request = null;
    return this.#request;
  }

  /** Takes the live request with this id (it is answered); null when there is none. */
  take(id: string, now: number): UnlockRequest | null {
    const live = this.request(now);
    if (!live || live.id !== id) return null;
    this.#request = null;
    return live;
  }

  /** Everything back to locked (paired, unpaired). */
  reset(): void {
    this.lock();
    this.#request = null;
  }
}
