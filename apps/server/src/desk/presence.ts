/**
 * The camera that keeps the desk screen unlocked while someone is there and tells the clock whether anyone is
 * (docs/decisions/desk-display.md DK-28…DK-33, DK-70…DK-73; desk-display-server.md DK-S34…, DK-S70…): the presence
 * service on the box (`whombat-presence`, YuNet on the camera's frames, no network) as the runtime sees it, a small
 * JSON API on its unix socket (`WHOMBAT_PRESENCE_SOCKET`, contracts 0.103.0 CT-597…CT-599):
 *
 *   GET  /v1/presence/health → {v, camera, detector}
 *   POST /v1/presence/watch  {v} → {v, state, face, seenAt?, frameAt?}   (starts the camera, keeps it 6 s more)
 *   POST /v1/presence/stop   {v} → {v}                                  (the camera off now)
 *
 * Errors are `LocalError`s (`bad_request`, `too_large`, `unavailable`). `WHOMBAT_PRESENCE=fake` puts the fake
 * (`testing/fake-presence.ts`) in its place for development and tests. Only whether and when a face was seen crosses:
 * no picture ever does.
 *
 * The watch loop (`PresenceLoop`) asks every 2 s while the camera is wanted — the screen unlocked with *When you leave*
 * (DK-28), or *Use the camera to see when you’re here* by day while the console shows the desk (DK-72) — and tells
 * the lock (`lock.ts`, the first case only) and the clock (`presence`) what it saw; it stops, and sends `stop`, the
 * moment nothing wants it.
 */
import { request } from 'node:http';
import {
  LocalError,
  PRESENCE_PATHS,
  PresenceAck,
  PresenceHealth,
  type PresenceState,
  PresenceStopRequest,
  PresenceWatch,
  PresenceWatchRequest,
} from '@whombat/control-contracts/local';
import { DESK_AWAY_S, DESK_PRESENCE_CHECK_S, type DeskSettings, deskQuietNow } from '@whombat/core';
import type { Config } from '../config';
import { CAMERA_ON, type DeskLock, PRESENCE_FRAME_STALE_MS, PRESENCE_KEEP_MS } from './lock';
import { FakePresence } from './testing/fake-presence';

/* The presence service -------------------------------------------------------------------------------------------- */

/** What the box can do with its camera (`presenceHealth`): a capture camera, and a detector that loads and runs. */
export interface PresenceAbility {
  camera: boolean;
  detector: boolean;
}

export const NO_PRESENCE: PresenceAbility = { camera: false, detector: false };

/** A watch's answer as the lock reads it (`PresenceWatch` with its times in ms). */
export interface PresenceSeen {
  state: PresenceState;
  /** A face in the latest checked frame. */
  face: boolean;
  /** The last frame with a face since the camera came on. */
  seenAt: number | null;
  /** The last frame checked. */
  frameAt: number | null;
}

/** Why a call to the presence service failed: it isn't there (or too slow), it refused the request, or else. */
export class PresenceCallError extends Error {
  constructor(
    readonly code: 'unavailable' | 'bad_request' | 'too_large' | 'error',
    message: string,
  ) {
    super(message);
    this.name = 'PresenceCallError';
  }
}

/** The presence service: the socket client, or the fake. */
export interface PresencePort {
  health(): Promise<PresenceAbility>;
  /** Starts the camera when it is off and keeps it on 6 s more; what the latest frames showed. */
  watch(): Promise<PresenceSeen>;
  /** The camera off now. */
  stop(): Promise<void>;
}

/** The service answers from the latest frame it has, so every call is quick; a watch well within the 2 s between them. */
const HEALTH_TIMEOUT_MS = 2_000;
export const PRESENCE_WATCH_TIMEOUT_MS = 1_500;
const STOP_TIMEOUT_MS = 1_000;
const ANSWER_MAX_BYTES = 16 * 1024;

const msOf = (at: string | undefined): number | null => (at === undefined ? null : Date.parse(at));

/** The presence service on its unix socket, validated both ways. */
export class PresenceSocketClient implements PresencePort {
  constructor(private readonly socketPath: string) {}

  private call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          // A connection per call, as the voice service's client (DK-T02).
          agent: false,
          path,
          method,
          headers:
            method === 'POST'
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > ANSWER_MAX_BYTES) {
              req.destroy(new PresenceCallError('error', `presence ${path}: answer too large`));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 500;
            if (status >= 300) {
              reject(presenceErrorOf(path, status, text));
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new PresenceCallError('error', `presence ${path}: not JSON`));
            }
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(new PresenceCallError('unavailable', `presence ${path}: timed out`)),
      );
      req.on('error', (err) =>
        reject(err instanceof PresenceCallError ? err : new PresenceCallError('unavailable', String(err))),
      );
      req.end(payload);
    });
  }

  async health(): Promise<PresenceAbility> {
    const h = PresenceHealth.parse(
      await this.call('GET', PRESENCE_PATHS.health, undefined, HEALTH_TIMEOUT_MS),
    );
    return { camera: h.camera, detector: h.detector };
  }

  async watch(): Promise<PresenceSeen> {
    const body = PresenceWatchRequest.parse({ v: 1 });
    const a = PresenceWatch.parse(
      await this.call('POST', PRESENCE_PATHS.watch, body, PRESENCE_WATCH_TIMEOUT_MS),
    );
    return { state: a.state, face: a.face, seenAt: msOf(a.seenAt), frameAt: msOf(a.frameAt) };
  }

  async stop(): Promise<void> {
    const body = PresenceStopRequest.parse({ v: 1 });
    PresenceAck.parse(await this.call('POST', PRESENCE_PATHS.stop, body, STOP_TIMEOUT_MS));
  }
}

function presenceErrorOf(path: string, status: number, text: string): PresenceCallError {
  let code = '';
  try {
    code = LocalError.parse(JSON.parse(text)).error.code;
  } catch {
    /* not a LocalError */
  }
  const message = `presence ${path}: ${status} ${code || text.slice(0, 120)}`;
  if (status === 413) return new PresenceCallError('too_large', message);
  if (status === 400) return new PresenceCallError('bad_request', message);
  if (status === 503) return new PresenceCallError('unavailable', message);
  return new PresenceCallError('error', message);
}

/* Per process ----------------------------------------------------------------------------------------------------- */

type PresenceConfig = Pick<Config, 'WHOMBAT_PRESENCE' | 'WHOMBAT_PRESENCE_SOCKET'>;
type PresenceServices = { config: PresenceConfig; clock?: () => Date };

const ports = new WeakMap<object, PresencePort | null>();

/** The process's presence service (one per `Services`): the fake (on the services' clock), the socket's client, or none. */
export function presenceFor(services: PresenceServices): PresencePort | null {
  if (ports.has(services)) return ports.get(services) ?? null;
  const { WHOMBAT_PRESENCE: mode, WHOMBAT_PRESENCE_SOCKET: socket } = services.config;
  const clock = services.clock;
  const port =
    mode === 'off'
      ? null
      : mode === 'fake'
        ? new FakePresence(clock ? () => clock().getTime() : Date.now)
        : socket
          ? new PresenceSocketClient(socket)
          : null;
  ports.set(services, port);
  return port;
}

/** Tests: this presence service (or none) for these services; the health cache starts over. */
export function setPresenceFor(services: object, port: PresencePort | null): void {
  ports.set(services, port);
  healths.delete(services);
}

/** How long a health answer is kept: a minute, a failure 15 s (the service may just be starting), as voice's. */
export const PRESENCE_HEALTH_TTL_MS = 60_000;
const PRESENCE_HEALTH_FAILED_TTL_MS = 15_000;

const healths = new WeakMap<object, { at: number; ttl: number; value: Promise<PresenceAbility> }>();

/** What the box can do with its camera, cached a minute. No presence service, or one that doesn't answer: nothing. */
export function presenceHealth(services: PresenceServices): Promise<PresenceAbility> {
  const now = Date.now();
  const hit = healths.get(services);
  if (hit && now - hit.at <= hit.ttl) return hit.value;
  const port = presenceFor(services);
  const entry = { at: now, ttl: PRESENCE_HEALTH_TTL_MS, value: Promise.resolve(NO_PRESENCE) };
  entry.value = port
    ? port.health().catch(() => {
        entry.ttl = PRESENCE_HEALTH_FAILED_TTL_MS;
        return NO_PRESENCE;
      })
    : Promise.resolve(NO_PRESENCE);
  healths.set(services, entry);
  return entry.value;
}

/** `DeskScreen.presenceAvailable` (DK-28, DK-31): a camera it can read and a detector that runs. */
export const presenceAvailable = (a: PresenceAbility): boolean => a.camera && a.detector;

/* The watch loop -------------------------------------------------------------------------------------------------- */

/** How often the loop asks while something wants the camera (DK-33). */
export const PRESENCE_CHECK_MS = DESK_PRESENCE_CHECK_S * 1000;
/** Someone is here while the camera saw a face within this (DK-71, `DeskPresence.here`). */
export const PRESENCE_AWAY_MS = DESK_AWAY_S * 1000;

/** What wants the camera now (DK-S70): the service's answer at every check of the loop and every `poke`. */
export interface PresenceWant {
  /**
   * DK-28's case: the unlock (the lock's epoch) the camera keeps while someone is there — unlocked with *When you
   * leave* and a camera that works. Its answers go to the lock while that is the screen's unlock, within its 4 hours.
   */
  lock: number | null;
  /** DK-72's case: the camera looks for someone for the clock (`DeskState.presence`); a face never touches the lock. */
  clock: boolean;
}

/** What the camera tells the clock (`DeskPresence`): on now, can tell now, a face within a minute. */
export interface PresenceNow {
  camera: boolean;
  watching: boolean;
  here: boolean;
}

/** The camera for the clock only while the console asked for the state this recently (DK-72: no console, no camera). */
export const CONSOLE_ASKED_MS = 10_000;

/** What the desk service knows when the loop asks what wants the camera (`cameraWant`). */
export interface CameraWantInput {
  /** The paired person's choices (null: unpaired; pairing implies the screen is on, off unpairs, DK-S28). */
  settings: Pick<DeskSettings, 'presence' | 'stayUnlocked' | 'cameraWake' | 'quietHours'> | null;
  /** The camera works on this box (`presenceAvailable`). */
  cameraWorks: boolean;
  /** The lock's epoch now, and whether its unlock stays (DK-74). */
  epoch: number;
  stays: boolean;
  /** When the console last asked for the paired screen's state, and the person's zone then; null: not since pairing. */
  console: { at: number; timeZone: string } | null;
  /** The latest power reading says the box runs on its battery (DK-10). */
  onBattery: boolean;
  now: number;
}

/**
 * What wants the camera (DK-S70), only where it works: (a) DK-28's case — *When you leave* (`presence` without
 * `stayUnlocked`, which wins, DK-76) and an unlock that doesn't stay: the lock's epoch, which the loop reads only while
 * that unlock is the screen's, within its 4 hours; (b) DK-72's — `cameraWake`, the console asked for the paired
 * screen's state within `CONSOLE_ASKED_MS`, outside quiet hours in the person's zone, not on battery.
 */
export function cameraWant(i: CameraWantInput): PresenceWant {
  const s = i.settings;
  if (!s || !i.cameraWorks) return { lock: null, clock: false };
  const keeps = s.presence && !s.stayUnlocked && !i.stays;
  const clock =
    s.cameraWake &&
    i.console !== null &&
    i.now - i.console.at <= CONSOLE_ASKED_MS &&
    !deskQuietNow(s, new Date(i.now), i.console.timeZone) &&
    !i.onBattery;
  return { lock: keeps ? i.epoch : null, clock };
}

export interface PresenceLoopOptions {
  /** The lock it keeps in DK-28's case (the desk service's). */
  lock: DeskLock;
  now: () => number;
  /** Runs `fn` in `ms` (tests: a fake clock's); returns what cancels it. */
  after: (ms: number, fn: () => void) => () => void;
  /** The presence service now (none: the loop stops). */
  port: () => PresencePort | null;
  /** What wants the camera now: asked at every check and every `poke`; nothing wants it, the loop stops. */
  wanted: () => PresenceWant;
  warn: (message: string, err: unknown) => void;
}

interface Run {
  cancel: (() => void) | null;
  /** The unlock whose lock reads the answers now (DK-28's case), or null. */
  lockEpoch: number | null;
  /** Counts the lock's readings in this run: an answer to a watch sent for an earlier one isn't the lock's. */
  reading: number;
  /** A failed watch was logged (once per run and per unlock read: a service that is down would log every 2 s). */
  warned: boolean;
}

/** What the camera saw in this run, for the clock (DK-72, DK-S72). */
interface Seen {
  /** The camera is on until then, as far as the runtime knows: the last answer that said so + the service's 6 s. */
  cameraUntil: number;
  /** The latest answer was `watching`, and the frame it was on. */
  watching: boolean;
  frameAt: number | null;
  /** The last face in this run (from `seenAt`, else the frame's time when `face`), never later than its answer. */
  faceAt: number | null;
}

const NOTHING_SEEN: Seen = { cameraUntil: 0, watching: false, frameAt: null, faceAt: null };

/**
 * One loop per runtime, one camera, one service (DK-S37, DK-S70). It runs while something *wants* the camera
 * (`wanted`): DK-28's case (an unlock the camera keeps) or DK-72's (the clock), and `poke` re-checks that at once —
 * an unlock, a lock, a setting, the console asking for the state. Each check is one watch, given at most 1.5 s, and
 * its answer goes to two readers: the lock, only in DK-28's case and only for the unlock its reading began in (the
 * lock keeps the rules, DK-28, DK-S35), and the clock's *seen* record (`presence`). The next check is in 2 s, or
 * sooner while the lock reads when the screen would lock or its 4 hours end first, so a lock by time is seen when it
 * happens; an unlock or a lock only begins or ends the lock's reading, so the camera never goes off and on again while
 * the clock still wants it. Stopping sends `stop` (errors ignored: the service turns the camera off by itself 6 s after
 * the last watch), and again when a watch still on its way when it stopped comes back while nothing watches, since that
 * watch may have opened the camera after the stop.
 */
export class PresenceLoop {
  #run: Run | null = null;
  #seen: Seen = NOTHING_SEEN;

  constructor(private readonly o: PresenceLoopOptions) {}

  /** The camera is wanted and asked now. */
  get running(): boolean {
    return this.#run !== null;
  }

  /** The unlock whose lock reads the camera's answers now (DK-28's case), or null. */
  get keeping(): number | null {
    return this.#run?.lockEpoch ?? null;
  }

  /** What wants the camera now, worked out: the lock's case only while its unlock is the screen's, in its 4 hours. */
  #want(now: number): { keep: number | null; clock: boolean } {
    const want = this.o.wanted();
    const lock = this.o.lock;
    const keep =
      want.lock !== null &&
      want.lock === lock.epoch &&
      lock.unlocked(now) &&
      !lock.stays &&
      now < lock.presenceEndsAt()
        ? want.lock
        : null;
    return { keep, clock: want.clock };
  }

  /** Re-checks what wants the camera: starts the loop, begins or ends the lock's reading, or stops it. */
  poke(): void {
    const now = this.o.now();
    let run = this.#run;
    if (!run) {
      const want = this.#want(now);
      if ((want.keep === null && !want.clock) || !this.o.port()) return;
      run = { cancel: null, lockEpoch: null, reading: 0, warned: false };
      this.#run = run;
      this.#seen = NOTHING_SEEN;
      this.#next(run, 0);
    }
    this.#follow(run, now);
  }

  /** The camera off: no more checks, `stop` sent, the lock back to DK-04's rule, nothing seen. */
  stop(): void {
    const run = this.#run;
    if (!run) return;
    this.#run = null;
    run.cancel?.();
    if (run.lockEpoch !== null) this.o.lock.unwatched(run.lockEpoch, this.o.now());
    this.#seen = NOTHING_SEEN;
    this.#sendStop();
  }

  /**
   * What the camera tells the clock now (DK-72, DK-S72): `camera` while the last answer saying it is open (starting,
   * watching, dark) is less than 6 s old; `watching` while the latest was `watching` on a frame at most 5 s old; `here`
   * while a face was seen within a minute. All false while the loop doesn't run.
   */
  presence(now: number): PresenceNow {
    if (!this.#run) return { camera: false, watching: false, here: false };
    const s = this.#seen;
    return {
      camera: now < s.cameraUntil,
      watching: s.watching && s.frameAt !== null && now - s.frameAt <= PRESENCE_FRAME_STALE_MS,
      here: s.faceAt !== null && now - s.faceAt < PRESENCE_AWAY_MS,
    };
  }

  /** Follows what wants the camera: the lock's reading begun or ended; false (and stopped) when nothing wants it. */
  #follow(run: Run, now: number): boolean {
    const { keep, clock } = this.#want(now);
    if ((keep === null && !clock) || !this.o.port()) {
      this.stop();
      return false;
    }
    if (run.lockEpoch === keep) return true;
    const lock = this.o.lock;
    if (run.lockEpoch !== null) lock.unwatched(run.lockEpoch, now);
    run.reading++;
    run.lockEpoch = keep !== null && lock.watchFrom(keep, now) ? keep : null;
    if (run.lockEpoch !== null) run.warned = false;
    else if (!clock) {
      this.stop();
      return false;
    }
    return true;
  }

  #sendStop(): void {
    const port = this.o.port();
    if (port) void port.stop().catch(() => {});
  }

  async #check(run: Run): Promise<void> {
    run.cancel = null;
    const port = this.o.port();
    if (!port) {
      this.stop();
      return;
    }
    if (!this.#follow(run, this.o.now())) return;
    const reading = run.reading;
    const seen = await this.#watch(run, port);
    if (this.#run !== run) {
      if (this.#run === null) this.#sendStop();
      return;
    }
    const at = this.o.now();
    this.#record(seen, at);
    const lock = this.o.lock;
    const epoch = run.lockEpoch;
    // The lock's reader (DK-28's case): only an answer to a watch sent for this reading. False: it locked by now.
    if (epoch !== null && run.reading === reading) {
      const unlocked = seen ? lock.seen(epoch, seen, at) : lock.unanswered(epoch, at);
      if (!unlocked) {
        lock.unwatched(epoch, at);
        run.lockEpoch = null;
        run.reading++;
      }
    }
    if (!this.#follow(run, at)) return;
    const keeping = run.lockEpoch !== null;
    this.#next(
      run,
      keeping
        ? Math.min(PRESENCE_CHECK_MS, lock.untilAt() - at, lock.presenceEndsAt() - at)
        : PRESENCE_CHECK_MS,
    );
  }

  /** The clock's reader (DK-S72): no answer keeps the camera mark as long as the service would keep the camera. */
  #record(seen: PresenceSeen | null, at: number): void {
    const s = this.#seen;
    if (!seen) {
      this.#seen = { ...s, watching: false };
      return;
    }
    const face = seen.seenAt ?? (seen.face ? seen.frameAt : null);
    this.#seen = {
      cameraUntil: CAMERA_ON.has(seen.state) ? at + PRESENCE_KEEP_MS : 0,
      watching: seen.state === 'watching',
      frameAt: seen.frameAt,
      faceAt: face === null ? s.faceAt : Math.max(s.faceAt ?? Number.NEGATIVE_INFINITY, Math.min(face, at)),
    };
  }

  #next(run: Run, ms: number): void {
    run.cancel = this.o.after(Math.max(0, ms), () => {
      this.#check(run).catch((err) => this.o.warn('desk: the camera check failed', err));
    });
  }

  /** One watch, at most `PRESENCE_WATCH_TIMEOUT_MS`; null when the service failed or was too slow. */
  #watch(run: Run, port: PresencePort): Promise<PresenceSeen | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (seen: PresenceSeen | null, err?: unknown) => {
        if (done) return;
        done = true;
        cancel();
        if (!seen && !run.warned) {
          run.warned = true;
          this.o.warn('desk: the camera didn’t answer', err ?? 'timed out');
        }
        resolve(seen);
      };
      const cancel = this.o.after(PRESENCE_WATCH_TIMEOUT_MS, () => finish(null));
      port.watch().then(
        (seen) => finish(seen),
        (err) => finish(null, err),
      );
    });
  }
}
