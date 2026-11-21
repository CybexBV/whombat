/**
 * A device asking to become a screen (docs/decisions/desk-display.md DK-146; desk-display-server.md “Screens
 * elsewhere”): a tablet or computer asks for six letters (`enroll.display.request`), shows them for 10 minutes and asks
 * how it went (`enroll.display.status`); the person types them in Settings → Screens → *Add a screen*
 * (`desk.screen.add`, `display.ts`).
 *
 * In memory only: a restart ends every request (the device asks again), and the letters are never written, logged or
 * sent anywhere but to the device that shows them. One request per device key, a new one replaces it; a key asks at
 * most `DISPLAY_REQUESTS_PER_KEY` times an hour; at most `DISPLAY_WAITING_MAX` devices wait at once in each pool — those
 * that came over the local network and those that came through the relay, so strangers on one can't fill the other's
 * places — and the box takes at most `DISPLAY_REQUESTS_PER_MINUTE` new requests a minute. Letters that ran out are kept
 * a while, so whoever types them late hears they ran out rather than that they're wrong. The person has `DESK_TRIES`
 * wrong letters in `DISPLAY_TRIES_WINDOW_MS` before Settings makes them wait.
 *
 * The clock is passed in, so the rules are tested without waiting.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { DESK_SCREEN_CODE_TTL_S, DESK_TRIES } from '@whombat/core';
import { generateScreenSignInLetters } from '@whombat/protocol/claim';
import type { EndpointPlatform } from '../db/schema/index';

/** How long the letters work. */
export const DISPLAY_CODE_TTL_MS = DESK_SCREEN_CODE_TTL_S * 1000;
/** Requests one device key may make in an hour, as pairing codes. */
export const DISPLAY_REQUESTS_PER_KEY = 10;
/** Devices waiting to be added at once, in each pool (the local network's, the relay's). */
export const DISPLAY_WAITING_MAX = 32;
/** New requests the box takes in a minute, from anyone. */
export const DISPLAY_REQUESTS_PER_MINUTE = 30;
/** Letters that ran out still answer “ran out” this long, and an added device still hears it was added. */
export const DISPLAY_KEEP_MS = 10 * 60_000;
/** The window the person's wrong letters are counted in. */
export const DISPLAY_TRIES_WINDOW_MS = 10 * 60_000;
const HOUR_MS = 3600_000;

/** How a device reached the box: over the local network (or Tailscale) directly, or through the relay. */
export type DisplayPool = 'direct' | 'relay';

export interface DisplayEndpoint {
  label: string;
  platform: EndpointPlatform;
}

export interface DisplayRequest {
  readonly requestId: string;
  readonly peerId: string;
  readonly publicKey: string;
  readonly endpoint: DisplayEndpoint;
  readonly code: string;
  readonly expiresAt: number;
  readonly pool: DisplayPool;
  /** `adding`: someone typed its letters and the commit is running; `gone`: it can't be added any more. */
  state: 'waiting' | 'adding' | 'added' | 'gone';
  screen?: { id: string; name: string };
}

export type DisplayTake = { ok: true; request: DisplayRequest } | { ok: false; reason: 'wrong' | 'expired' };

/** `key_limit` this key asked too often, `full` its pool has too many waiting, `busy` the box had too many this minute. */
export type DisplayRefusal = 'key_limit' | 'full' | 'busy';

export class DisplayRequests {
  readonly #byId = new Map<string, DisplayRequest>();
  readonly #byCode = new Map<string, DisplayRequest>();
  readonly #byPeer = new Map<string, DisplayRequest>();
  readonly #perKey = new Map<string, number[]>();
  readonly #wrong = new Map<string, number[]>();
  #lastMinute: number[] = [];

  constructor(
    private readonly random: (n: number) => Uint8Array = (n) => new Uint8Array(nodeRandomBytes(n)),
  ) {}

  /** Requests that ran out long ago go; the per-key and wrong-letter counts keep only their windows. */
  #sweep(now: number): void {
    for (const r of this.#byId.values()) {
      if (r.expiresAt + DISPLAY_KEEP_MS > now) continue;
      this.#forget(r);
    }
  }

  #forget(r: DisplayRequest): void {
    this.#byId.delete(r.requestId);
    if (this.#byCode.get(r.code) === r) this.#byCode.delete(r.code);
    if (this.#byPeer.get(r.peerId) === r) this.#byPeer.delete(r.peerId);
  }

  /** Devices waiting now (letters showing that haven't run out), in `pool` or in both. */
  waiting(now: number, pool?: DisplayPool): number {
    let n = 0;
    for (const r of this.#byId.values())
      if (r.expiresAt > now && r.state !== 'added' && r.state !== 'gone' && (!pool || r.pool === pool)) n++;
    return n;
  }

  /**
   * New letters for this key for 10 minutes, replacing its earlier request; a refusal when the key asked too often this
   * hour (`key_limit`), its pool has too many waiting (`full`) or the box had too many new requests this minute (`busy`).
   */
  request(
    identity: { peerId: string; publicKey: string },
    endpoint: DisplayEndpoint,
    now: number,
    pool: DisplayPool = 'relay',
  ): { ok: true; request: DisplayRequest } | { ok: false; reason: DisplayRefusal } {
    this.#sweep(now);
    const recent = (this.#perKey.get(identity.peerId) ?? []).filter((at) => at > now - HOUR_MS);
    if (recent.length >= DISPLAY_REQUESTS_PER_KEY) return { ok: false, reason: 'key_limit' };
    const before = this.#byPeer.get(identity.peerId);
    // Its own earlier request doesn't count against its pool: it is replaced.
    const replacing =
      before && before.expiresAt > now && before.state === 'waiting' && before.pool === pool ? 1 : 0;
    if (this.waiting(now, pool) - replacing >= DISPLAY_WAITING_MAX) return { ok: false, reason: 'full' };
    this.#lastMinute = this.#lastMinute.filter((at) => at > now - 60_000);
    if (this.#lastMinute.length >= DISPLAY_REQUESTS_PER_MINUTE) return { ok: false, reason: 'busy' };
    this.#lastMinute.push(now);
    // A request someone is adding right now stays as it is: the device sees how that ends.
    if (before && before.state !== 'adding') this.#forget(before);
    if (this.#perKey.size > 10_000) this.#perKey.clear();
    this.#perKey.set(identity.peerId, [...recent, now]);
    let code = generateScreenSignInLetters(this.random);
    for (let i = 0; i < 16 && this.#byCode.has(code); i++) code = generateScreenSignInLetters(this.random);
    if (this.#byCode.has(code)) throw new Error('could not draw letters for a screen');
    const request: DisplayRequest = {
      requestId: Buffer.from(this.random(18)).toString('base64url'),
      peerId: identity.peerId,
      publicKey: identity.publicKey,
      endpoint,
      code,
      expiresAt: now + DISPLAY_CODE_TTL_MS,
      pool,
      state: 'waiting',
    };
    this.#byId.set(request.requestId, request);
    this.#byCode.set(code, request);
    this.#byPeer.set(identity.peerId, request);
    return { ok: true, request };
  }

  /** How this key's request is doing; null when it isn't this key's (or is long gone). */
  status(
    peerId: string,
    requestId: string,
    now: number,
  ): { state: 'waiting' | 'added' | 'expired'; screen?: { id: string; name: string } } | null {
    this.#sweep(now);
    const r = this.#byId.get(requestId);
    if (!r || r.peerId !== peerId) return null;
    if (r.state === 'added' && r.screen) return { state: 'added', screen: r.screen };
    if (r.state === 'gone' || r.expiresAt <= now) return { state: 'expired' };
    return { state: 'waiting' };
  }

  /**
   * The request showing these letters, now being added (nobody else can take it until `added`, `release` or `drop`);
   * `wrong` for letters no device shows, `expired` for letters that ran out.
   */
  take(code: string, now: number): DisplayTake {
    this.#sweep(now);
    const r = this.#byCode.get(code);
    if (!r || r.state === 'adding' || r.state === 'added') return { ok: false, reason: 'wrong' };
    if (r.state === 'gone' || r.expiresAt <= now) return { ok: false, reason: 'expired' };
    r.state = 'adding';
    return { ok: true, request: r };
  }

  /** The device is a screen now: its letters are used up, its status says so. */
  added(r: DisplayRequest, screen: { id: string; name: string }): void {
    r.state = 'added';
    r.screen = screen;
    if (this.#byCode.get(r.code) === r) this.#byCode.delete(r.code);
  }

  /** Adding it failed for a reason that may pass (a busy moment): its letters work again until they run out. */
  release(r: DisplayRequest): void {
    if (r.state === 'adding') r.state = 'waiting';
  }

  /** Adding it failed for good (its key is a device here already, or was removed): it waits no more. */
  drop(r: DisplayRequest): void {
    r.state = 'gone';
    if (this.#byCode.get(r.code) === r) this.#byCode.delete(r.code);
  }

  /** Wrong letters the person may still type before waiting; 0 means wait. */
  triesLeft(accountId: string, now: number): number {
    const recent = (this.#wrong.get(accountId) ?? []).filter((at) => at > now - DISPLAY_TRIES_WINDOW_MS);
    return Math.max(0, DESK_TRIES - recent.length);
  }

  /** One wrong try of the person's; the tries left after it. */
  wrongTry(accountId: string, now: number): number {
    const recent = (this.#wrong.get(accountId) ?? []).filter((at) => at > now - DISPLAY_TRIES_WINDOW_MS);
    if (this.#wrong.size > 1_000) this.#wrong.clear();
    this.#wrong.set(accountId, [...recent, now]);
    return Math.max(0, DESK_TRIES - recent.length - 1);
  }

  /** When the oldest wrong try in the window leaves it (the person may try again then). */
  retryAt(accountId: string, now: number): number {
    const recent = (this.#wrong.get(accountId) ?? []).filter((at) => at > now - DISPLAY_TRIES_WINDOW_MS);
    return recent.length ? Math.min(...recent) + DISPLAY_TRIES_WINDOW_MS : now;
  }
}
