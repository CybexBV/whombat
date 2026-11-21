/**
 * A fake presence service (desk-display-server.md DK-S38, DK-S75): what `whombat-presence` answers (contracts 0.103.0,
 * the presence socket), without a camera. Development runs it in process (`WHOMBAT_PRESENCE=fake`, someone always
 * there: with *Use the camera to see when you’re here* the glance always shows with the camera on, DK-72); tests drive
 * it directly on a fake clock or on a unix socket (`startFakePresence`), as the runtime's client talks to the real one.
 *
 * Like the real one, a watch opens the camera when it is closed (the first watch after that answers `starting`, no frame
 * yet), keeps it open 6 s after the last watch, and `stop` closes it; `seenAt` is the last face since it opened. Tests
 * say whether someone is in front of it (`someone`), what the picture is like (`picture`: light enough, dark, failed, no
 * camera), switch what `health` says, fail the next call, or hold watches until they let them go; `calls` records what it
 * was asked, `cameraOn()` whether the camera is open now.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRESENCE_KEEP_S,
  PRESENCE_PATHS,
  PRESENCE_REQUEST_MAX_BYTES,
  PresenceStopRequest,
  PresenceWatchRequest,
} from '@whombat/control-contracts/local';
import { type PresenceAbility, PresenceCallError, type PresencePort, type PresenceSeen } from '../presence';

/** What the camera's picture is like once it is open. */
export type FakePicture = 'watching' | 'dark' | 'failed' | 'no_camera';

export class FakePresence implements PresencePort {
  /** What `health` answers: a camera and a detector by default. */
  ability: PresenceAbility = { camera: true, detector: true };
  /** Someone in front of the camera (a face in every frame). */
  someone = true;
  picture: FakePicture = 'watching';
  /** Watches that answer `starting` after the camera opens. */
  startingWatches = 1;
  /** The next watch fails with this (once). */
  failNext: PresenceCallError | null = null;
  /** What it was asked, in order. */
  readonly calls: ('watch' | 'stop')[] = [];
  #openedAt: number | null = null;
  #lastWatch = 0;
  #seenAt: number | null = null;
  #starting = 0;
  #held: { promise: Promise<void>; release: () => void } | null = null;

  constructor(private readonly clock: () => number = Date.now) {}

  async health(): Promise<PresenceAbility> {
    return { ...this.ability };
  }

  /** Whether the camera is open now: from a watch until `stop`, or 6 s after the last watch. */
  cameraOn(): boolean {
    if (this.#openedAt !== null && this.clock() - this.#lastWatch >= PRESENCE_KEEP_S * 1000) this.#close();
    return this.#openedAt !== null;
  }

  /** Watches wait until `release()` (a slow service). */
  hold(): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#held = { promise, release };
  }

  release(): void {
    this.#held?.release();
    this.#held = null;
  }

  async watch(): Promise<PresenceSeen> {
    this.calls.push('watch');
    if (this.#held) await this.#held.promise;
    const failure = this.failNext;
    if (failure) {
      this.failNext = null;
      throw failure;
    }
    const now = this.clock();
    if (!this.ability.camera || this.picture === 'no_camera') {
      this.#close();
      return { state: 'no_camera', face: false, seenAt: null, frameAt: null };
    }
    if (!this.cameraOn()) {
      this.#openedAt = now;
      this.#starting = this.startingWatches;
    }
    this.#lastWatch = now;
    if (this.#starting > 0) {
      this.#starting--;
      return { state: 'starting', face: false, seenAt: null, frameAt: null };
    }
    if (this.picture === 'failed')
      return { state: 'failed', face: false, seenAt: this.#seenAt, frameAt: null };
    const face = this.picture === 'watching' && this.someone;
    if (face) this.#seenAt = now;
    return { state: this.picture, face, seenAt: this.#seenAt, frameAt: now };
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    this.#close();
  }

  #close(): void {
    this.#openedAt = null;
    this.#seenAt = null;
  }
}

/* On a unix socket ------------------------------------------------------------------------------------------------ */

export interface FakePresenceServer {
  socketPath: string;
  presence: FakePresence;
  close(): Promise<void>;
}

/** The fake behind the presence socket's API, as `whombat-presence` serves it (errors as `LocalError`s). */
export async function startFakePresence(
  options: { socketPath?: string; presence?: FakePresence } = {},
): Promise<FakePresenceServer> {
  const presence = options.presence ?? new FakePresence();
  const dir = options.socketPath ? null : mkdtempSync(join(tmpdir(), 'wb-presence-'));
  const socketPath = options.socketPath ?? join(dir as string, 'presence.sock');
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = createServer((req, res) => {
    serve(presence, req, res).catch((err: unknown) => fail(res, 500, 'internal', String(err)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    presence,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          if (dir) rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  if (!res.headersSent) send(res, status, { error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= PRESENCE_REQUEST_MAX_BYTES) chunks.push(chunk as Buffer);
  }
  return size > PRESENCE_REQUEST_MAX_BYTES ? null : Buffer.concat(chunks);
}

const iso = (at: number | null) => (at === null ? undefined : new Date(at).toISOString());

const ERROR_STATUS: Record<PresenceCallError['code'], number> = {
  bad_request: 400,
  too_large: 413,
  unavailable: 503,
  error: 500,
};

async function serve(presence: FakePresence, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === PRESENCE_PATHS.health) {
    send(res, 200, { v: 1, ...(await presence.health()) });
    return;
  }
  if (req.method !== 'POST' || (req.url !== PRESENCE_PATHS.watch && req.url !== PRESENCE_PATHS.stop)) {
    fail(res, 404, 'not_found', 'no such route');
    return;
  }
  const raw = await readBody(req);
  if (!raw) return fail(res, 413, 'too_large', 'body too large');
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return fail(res, 400, 'bad_request', 'not JSON');
  }
  const schema = req.url === PRESENCE_PATHS.watch ? PresenceWatchRequest : PresenceStopRequest;
  if (!schema.safeParse(json).success) return fail(res, 400, 'bad_request', 'bad request');
  if (req.url === PRESENCE_PATHS.stop) {
    await presence.stop();
    send(res, 200, { v: 1 });
    return;
  }
  try {
    const seen = await presence.watch();
    const seenAt = iso(seen.seenAt);
    const frameAt = iso(seen.frameAt);
    send(res, 200, {
      v: 1,
      state: seen.state,
      face: seen.face,
      ...(seenAt ? { seenAt } : {}),
      ...(frameAt ? { frameAt } : {}),
    });
  } catch (err) {
    if (err instanceof PresenceCallError) fail(res, ERROR_STATUS[err.code], err.code, err.message);
    else throw err;
  }
}
