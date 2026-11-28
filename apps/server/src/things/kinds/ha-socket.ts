/**
 * Home Assistant's WebSocket API for its page (connection-pages.md CP-07; connection-pages-server.md CP-S08): one socket
 * per read, under the connection's destination policy (`outboundConnectOptions`: the checked URL, the pinned lookup and,
 * with a pinned certificate, its agent), signed in with the connection's own credential; a refused OAuth token is
 * refreshed once and tried again, like `signedConnectionFetch` does on a 401. Commands run side by side on the socket;
 * a subscription (`system_health/info`, `render_template`) collects its events until it says it is done or its time is
 * up. Nothing here writes to Home Assistant.
 */
import { WebSocket } from 'ws';
import { externalEffect } from '../../commit/scope';
import { resolveCredential } from '../../connections/credentials';
import { connectionPolicy } from '../../connections/destination';
import { pinOf } from '../../connections/http';
import type { CatalogConnectionRow } from '../../connections/types';
import { outboundConnectOptions } from '../../lib/outbound';
import type { Services } from '../../services';
import { KIND_MAX_BYTES, problemOf, ReadProblem } from './read';

/** A command's answer: its result, or Home Assistant's error code (`unauthorized`, `unknown_command`, `timeout`). */
export type HaResult = { success: true; result: unknown } | { success: false; code: string; message: string };

/** The commands of a signed-in socket. */
export interface HaCommands {
  /** The version Home Assistant said when it asked for the sign-in. */
  readonly haVersion: string | null;
  call(type: string, data?: Record<string, unknown>, timeoutMs?: number): Promise<HaResult>;
  /** A subscription: its result, then its events until `done` says so or the time is up. */
  collect(
    type: string,
    data: Record<string, unknown>,
    done: (event: unknown) => boolean,
    timeoutMs: number,
  ): Promise<{ result: HaResult; events: unknown[] }>;
  close(): void;
}

/**
 * A socket kept open (the automations' triggers follow entities on it): a subscription that lasts as long as the
 * socket, a ping to tell a socket that went quiet from one that is gone, and the moment it closed.
 */
export interface HaLive extends HaCommands {
  /** Subscribes: Home Assistant's answer, then every event to `onEvent` until the socket closes. */
  subscribe(
    type: string,
    data: Record<string, unknown>,
    onEvent: (event: unknown) => void,
    timeoutMs?: number,
  ): Promise<HaResult>;
  /** Whether Home Assistant answers a ping in time. */
  ping(timeoutMs?: number): Promise<boolean>;
  /** Settles once the socket closed, whoever closed it. */
  readonly closed: Promise<void>;
  /**
   * How far Home Assistant's clock is ahead of this box's (ms; behind when below 0), from the time its answer to the
   * socket said (`Date`); null when it said none. Its own times (`last_changed`) are judged against its own clock.
   */
  readonly clockAheadMs?: number | null;
}

/** How far the clock behind an HTTP `Date` header is ahead of `now` (ms), or null when the header isn't a time. */
export function clockAheadOf(date: string | string[] | undefined, now: number): number | null {
  const said = typeof date === 'string' ? Date.parse(date) : Number.NaN;
  return Number.isFinite(said) ? said - now : null;
}

/** Home Assistant refused the token (`auth_invalid`). */
export class HaAuthInvalid extends Error {
  override name = 'HaAuthInvalid';
}

const COMMAND_MS = 8_000;

interface Pending {
  onMessage(message: Record<string, unknown>): void;
  onClose(): void;
}

/**
 * A socket's messages from the moment it was made (Home Assistant asks for the sign-in as soon as it opens, before
 * anyone may be listening): `next` takes them one by one, `each` hands over the rest and every later one.
 */
export interface MessageBuffer {
  readonly ws: WebSocket;
  next(ms: number): Promise<Record<string, unknown>>;
  each(handler: (message: Record<string, unknown>) => void, onClose: () => void): void;
}

/** Buffers a socket's messages; call it right after making the socket. */
export function bufferMessages(ws: WebSocket): MessageBuffer {
  const queue: Record<string, unknown>[] = [];
  let waiter: ((m: Record<string, unknown> | null) => void) | null = null;
  let handler: ((m: Record<string, unknown>) => void) | null = null;
  let closedHandler: (() => void) | null = null;
  let closed = false;
  ws.on('message', (data) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      message = { type: '__unreadable' };
    }
    if (handler) handler(message);
    else if (waiter) {
      const w = waiter;
      waiter = null;
      w(message);
    } else queue.push(message);
  });
  const onEnd = () => {
    if (closed) return;
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
    closedHandler?.();
  };
  ws.on('close', onEnd);
  ws.on('error', onEnd);
  return {
    ws,
    next(ms) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (closed) return Promise.reject(new ReadProblem('Home Assistant closed the connection.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new ReadProblem('Home Assistant didn’t answer in time.'));
        }, ms);
        waiter = (m) => {
          clearTimeout(timer);
          if (m) resolve(m);
          else reject(new ReadProblem('Home Assistant closed the connection.'));
        };
      });
    },
    each(h, onClose) {
      handler = h;
      closedHandler = onClose;
      for (const m of queue.splice(0)) h(m);
      if (closed) onClose();
    },
  };
}

/**
 * Signs in on a socket (its messages buffered from the start) and gives its commands. Throws `HaAuthInvalid` when the
 * token is refused, `ReadProblem` when Home Assistant doesn't follow its protocol.
 */
export async function haSession(
  buffer: MessageBuffer,
  token: string,
  timeoutMs = COMMAND_MS,
): Promise<HaLive> {
  const ws = buffer.ws;
  const hello = await buffer.next(timeoutMs);
  if (hello.type !== 'auth_required') throw new ReadProblem('This doesn’t answer like Home Assistant.');
  const haVersion = typeof hello.ha_version === 'string' ? hello.ha_version : null;
  ws.send(JSON.stringify({ type: 'auth', access_token: token }));
  const auth = await buffer.next(timeoutMs);
  if (auth.type === 'auth_invalid') throw new HaAuthInvalid('auth_invalid');
  if (auth.type !== 'auth_ok') throw new ReadProblem('Home Assistant didn’t let Whombat sign in.');

  let nextId = 1;
  const pending = new Map<number, Pending>();
  let ended: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    ended = resolve;
  });
  buffer.each(
    (message) => {
      const id = typeof message.id === 'number' ? message.id : null;
      if (id !== null) pending.get(id)?.onMessage(message);
    },
    () => {
      for (const p of [...pending.values()]) p.onClose();
      pending.clear();
      ended();
    },
  );

  const resultOf = (message: Record<string, unknown>): HaResult => {
    if (message.success === true) return { success: true, result: message.result ?? null };
    const error = (message.error ?? {}) as Record<string, unknown>;
    return {
      success: false,
      code: typeof error.code === 'string' ? error.code : 'error',
      message: typeof error.message === 'string' ? error.message.slice(0, 200) : '',
    };
  };
  const send = (id: number, type: string, data: Record<string, unknown>) => {
    try {
      ws.send(JSON.stringify({ ...data, id, type }));
      return true;
    } catch {
      return false;
    }
  };

  return {
    haVersion,
    closed,
    subscribe(type, data, onEvent, ms = timeoutMs) {
      const id = nextId++;
      return new Promise<HaResult>((resolve) => {
        let answered = false;
        const answer = (r: HaResult) => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          if (!r.success) pending.delete(id);
          resolve(r);
        };
        const timer = setTimeout(() => answer({ success: false, code: 'timeout', message: '' }), ms);
        pending.set(id, {
          onMessage: (m) => {
            if (m.type === 'result') answer(resultOf(m));
            else if (m.type === 'event') {
              answer({ success: true, result: null });
              onEvent(m.event);
            }
          },
          onClose: () => answer({ success: false, code: 'closed', message: '' }),
        });
        if (!send(id, type, data)) answer({ success: false, code: 'closed', message: '' });
      });
    },
    ping(ms = timeoutMs) {
      const id = nextId++;
      return new Promise<boolean>((resolve) => {
        const done = (ok: boolean) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(ok);
        };
        const timer = setTimeout(() => done(false), ms);
        pending.set(id, { onMessage: (m) => done(m.type === 'pong'), onClose: () => done(false) });
        if (!send(id, 'ping', {})) done(false);
      });
    },
    call(type, data = {}, ms = timeoutMs) {
      const id = nextId++;
      return new Promise<HaResult>((resolve) => {
        const done = (r: HaResult) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(r);
        };
        const timer = setTimeout(() => done({ success: false, code: 'timeout', message: '' }), ms);
        pending.set(id, {
          onMessage: (m) => {
            if (m.type === 'result') done(resultOf(m));
          },
          onClose: () => done({ success: false, code: 'closed', message: '' }),
        });
        if (!send(id, type, data)) done({ success: false, code: 'closed', message: '' });
      });
    },
    collect(type, data, isDone, ms) {
      const id = nextId++;
      return new Promise((resolve) => {
        const events: unknown[] = [];
        let result: HaResult = { success: false, code: 'timeout', message: '' };
        const done = () => {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ result, events });
        };
        const timer = setTimeout(done, ms);
        pending.set(id, {
          onMessage: (m) => {
            if (m.type === 'result') {
              result = resultOf(m);
              if (!result.success) done();
            } else if (m.type === 'event') {
              result = result.success ? result : { success: true, result: null };
              events.push(m.event);
              if (isDone(m.event)) done();
            }
          },
          onClose: done,
        });
        if (!send(id, type, data)) done();
      });
    },
    close() {
      ws.terminate();
    },
  };
}

/** The connection's access token (Home Assistant signs in with a bearer token, its own OAuth or a long-lived one). */
async function tokenOf(services: Services, row: CatalogConnectionRow, force: boolean): Promise<string> {
  const { credential } = await resolveCredential(services, row, { forceRefresh: force });
  const header = Object.entries(credential.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new ReadProblem('Whombat can’t sign in to Home Assistant’s live connection this way.');
  return token;
}

/** Opens a socket to `<base>/api/websocket` under the connection's policy (not signed in yet). */
async function openSocket(
  services: Services,
  row: CatalogConnectionRow,
  deadlineMs: number,
): Promise<MessageBuffer & { clockAheadMs: number | null }> {
  const httpUrl = `${row.baseUrl.replace(/\/+$/, '')}/api/websocket`;
  return externalEffect(
    'things.read',
    async () => {
      const policy = await connectionPolicy(services, httpUrl, { ...pinOf(row), deadlineMs });
      const { url, lookup, agent } = outboundConnectOptions(httpUrl, policy);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url, {
        lookup,
        ...(agent ? { agent } : {}),
        followRedirects: false,
        maxPayload: KIND_MAX_BYTES,
        handshakeTimeout: deadlineMs,
        perMessageDeflate: false,
        headers: { 'User-Agent': 'Whombat' },
      });
      const buffer = bufferMessages(ws);
      let clockAheadMs: number | null = null;
      ws.once('upgrade', (res) => {
        clockAheadMs = clockAheadOf(res.headers.date, services.clock().getTime());
      });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (err) => reject(err));
        ws.once('unexpected-response', (_req, res) =>
          reject(
            new ReadProblem(
              res.statusCode === 404
                ? 'Home Assistant’s live connection isn’t switched on.'
                : 'Home Assistant refused the live connection.',
            ),
          ),
        );
      });
      return { ...buffer, clockAheadMs };
    },
    { idempotent: true },
  );
}

const RENEWED = new Set(['ha_oauth']);

/** A signed-in socket as the connection; the caller closes it. */
export async function openHomeAssistant(
  services: Services,
  row: CatalogConnectionRow,
  deadlineMs: number,
): Promise<HaLive> {
  const attempt = async (force: boolean) => {
    const token = await tokenOf(services, row, force);
    let buffer: MessageBuffer & { clockAheadMs: number | null };
    try {
      buffer = await openSocket(services, row, deadlineMs);
    } catch (err) {
      throw problemOf(err, 'Home Assistant');
    }
    try {
      return { ...(await haSession(buffer, token)), clockAheadMs: buffer.clockAheadMs };
    } catch (err) {
      buffer.ws.terminate();
      throw err;
    }
  };
  try {
    return await attempt(false);
  } catch (err) {
    if (!(err instanceof HaAuthInvalid)) throw problemOf(err, 'Home Assistant');
    if (!RENEWED.has(row.signIn)) throw new ReadProblem('Home Assistant refused Whombat’s sign-in.', true);
  }
  try {
    return await attempt(true);
  } catch (err) {
    if (err instanceof HaAuthInvalid)
      throw new ReadProblem('Home Assistant refused Whombat’s sign-in.', true);
    throw problemOf(err, 'Home Assistant');
  }
}
