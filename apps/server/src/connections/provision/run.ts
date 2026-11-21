/**
 * Running a provisioner (docs/decisions/connections-setup.md CS-01…CS-05): what it gets to talk to the service with,
 * and the time it has.
 *
 * - `fetch`: one request at a time under the connection destination policy of the request's own URL, which must be on
 *   the base URL's origin (the home-network list with its ports, DNS pinned to the checked addresses, the pinned
 *   certificate of the `fingerprint` field), `User-Agent: Whombat` unless the provisioner sets its own, redirects
 *   answered and never followed, the answer capped at 1 MiB, 15 s per request. Each is an external effect of the
 *   command (a key is made: anything but a read may not be repeated blindly). A sign-in that stops with a
 *   `ProvisionError` (the service said no, or answered in a way Whombat doesn't know) answers with its words (“Wrong
 *   password”, the two-step code asked for), not “this may have happened”: the form needs them, and the command is
 *   never sent again either way.
 * - `socket`: a WebSocket (`ws`) under the same policy: the same lookup and pin (`outboundConnectOptions`), no
 *   redirects, 1 MiB per message.
 * - 45 s for the whole sign-in: past it the run fails `timeout`, every request still asked for is refused and every
 *   socket it opened is closed.
 *
 * Nothing here logs or keeps what passes through: the password is the provisioner's to send and is dropped with it.
 */
import WebSocket from 'ws';
import { externalEffect, undoneEffect } from '../../commit/scope';
import {
  OutboundError,
  type OutboundResponse,
  outboundConnectOptions,
  outboundErrorOf,
  outboundRequest,
} from '../../lib/outbound';
import type { Services } from '../../services';
import { connectionPolicy } from '../destination';
import { pinOf } from '../http';
import { redirectOrigin } from '../redirect';
import {
  ProvisionError,
  type Provisioned,
  type Provisioner,
  type ProvisionFetch,
  type ProvisionInput,
  type ProvisionRequest,
  type ProvisionResponse,
  type ProvisionSocket,
} from './types';

/** The whole sign-in, from the first request to the key (CS-04: one try, so this is plenty). */
export const PROVISION_DEADLINE_MS = 45_000;
/** One request or WebSocket handshake. */
export const PROVISION_REQUEST_DEADLINE_MS = 15_000;
/** An answer or a WebSocket message. */
export const PROVISION_BODY_MAX = 1024 * 1024;
/** Messages a socket keeps unread before it gives up (Home Assistant sends one per request). */
const SOCKET_QUEUE_MAX = 256;
const SOCKET_NEXT_MS = 10_000;

/** What Whombat makes in a service is called this (CS-06); there is no instance name to add (CS-D11). */
export const PROVISIONED_NAME = 'Whombat';

/**
 * What the caller knows; the run adds the fetch, the socket, the clock and the client id (from `burrowId`: the burrow
 * the connection is made from).
 */
export type ProvisionRunInput = Omit<
  ProvisionInput,
  'fetch' | 'socket' | 'clock' | 'name' | 'publicUrl' | 'clientId'
> & { burrowId?: string };

/** This Whombat's stable client id in a burrow (`ProvisionInput.clientId`): a MAC of the burrow under the master key. */
export function provisionClientId(services: Services, burrowId: string | undefined): string {
  return `whombat-${services.custody.mac('provision-client-id', burrowId ?? 'whombat').slice(0, 32)}`;
}

const ranOut = () => new OutboundError('timeout', 'Signing in took too long.');

/**
 * The request's full URL: a path under the base URL, or a URL on its origin. (Plex's plex.tv was the one origin besides
 * it, CM-06, until Plex signed in on its own page, connection-signin.md SG-04.)
 */
export function provisionUrl(baseUrl: string, pathOrUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (pathOrUrl.startsWith('/')) return `${base}${pathOrUrl}`;
  let url: URL;
  try {
    url = new URL(pathOrUrl);
  } catch {
    throw new OutboundError('bad_url', 'Not a URL.');
  }
  if (url.origin !== new URL(base).origin)
    throw new OutboundError('destination', 'Sign in once stays on the service’s own address.');
  return url.toString();
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function responseOf(res: OutboundResponse): ProvisionResponse {
  let text: string | null = null;
  const read = () => {
    text ??= res.body.toString('utf8');
    return text;
  };
  return {
    status: res.status,
    headers: { ...res.headers },
    body: res.body,
    text: read,
    json: () => {
      try {
        return JSON.parse(read()) as unknown;
      } catch {
        return null;
      }
    },
  };
}

/** A socket's messages as a queue the provisioner reads with `next`. */
function socketOf(
  ws: WebSocket,
  remaining: () => number,
): { socket: ProvisionSocket; opened: Promise<void> } {
  const queue: unknown[] = [];
  const waiting: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  let ended: OutboundError | null = null;
  const end = (err: OutboundError) => {
    ended ??= err;
    for (const w of waiting.splice(0)) {
      clearTimeout(w.timer);
      w.reject(ended);
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(outboundErrorOf(err)));
    ws.once('close', () => reject(new OutboundError('network', 'The connection closed.')));
  });
  opened.catch(() => {});
  ws.on('message', (data, isBinary) => {
    const text = isBinary ? null : data.toString();
    let value: unknown = text;
    if (text !== null)
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    const w = waiting.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(value);
      return;
    }
    queue.push(value);
    if (queue.length > SOCKET_QUEUE_MAX) {
      ws.terminate();
      end(new OutboundError('too_large', 'It sent too many messages.'));
    }
  });
  ws.on('error', (err) => end(outboundErrorOf(err)));
  ws.on('close', () => end(new OutboundError('network', 'The connection closed.')));
  const socket: ProvisionSocket = {
    send(message) {
      if (ws.readyState !== WebSocket.OPEN)
        throw ended ?? new OutboundError('network', 'The connection closed.');
      ws.send(JSON.stringify(message));
    },
    next(timeoutMs = SOCKET_NEXT_MS) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.reject(ended);
      const wait = Math.min(timeoutMs, remaining());
      if (wait <= 0) return Promise.reject(ranOut());
      return new Promise<unknown>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = waiting.indexOf(entry);
            if (i >= 0) waiting.splice(i, 1);
            reject(new OutboundError('timeout', 'It didn’t answer in time.'));
          }, wait),
        };
        entry.timer.unref?.();
        waiting.push(entry);
      });
    },
    close() {
      ws.terminate();
    },
  };
  return { socket, opened };
}

/**
 * Runs `provisioner` with the person's account and password, the fetch and the socket under the destination policy,
 * and 45 s (`deadlineMs` for tests). Throws what the provisioner throws (`ProvisionError`, `OutboundError`), or
 * `OutboundError` `timeout`. Every socket it opened is closed when it ends, whichever way.
 */
export async function runProvisioner(
  services: Services,
  provisioner: Provisioner,
  input: ProvisionRunInput,
  options: { deadlineMs?: number } = {},
): Promise<Provisioned> {
  const deadlineAt = Date.now() + (options.deadlineMs ?? PROVISION_DEADLINE_MS);
  let over = false;
  const remaining = () => (over ? 0 : deadlineAt - Date.now());
  const sockets = new Set<WebSocket>();
  const target = { fields: input.fields };

  const fetch: ProvisionFetch = async (pathOrUrl: string, init: ProvisionRequest) => {
    const url = provisionUrl(input.baseUrl, pathOrUrl);
    const left = remaining();
    if (left <= 0) throw ranOut();
    const method = init.method.toUpperCase();
    const headers = { ...(init.headers ?? {}) };
    if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = PROVISIONED_NAME;
    const res = await externalEffect(
      'connections.provision',
      async () => {
        const policy = await connectionPolicy(services, url, {
          ...pinOf(target),
          deadlineMs: Math.min(PROVISION_REQUEST_DEADLINE_MS, left),
          maxBytes: PROVISION_BODY_MAX,
        });
        return outboundRequest(
          url,
          { method, headers, ...(init.body !== undefined ? { body: init.body } : {}) },
          policy,
        );
      },
      { idempotent: method === 'GET' || method === 'HEAD' },
    );
    return responseOf(res);
  };

  const socket = async (path: string): Promise<ProvisionSocket> => {
    const httpUrl = provisionUrl(input.baseUrl, path);
    const left = remaining();
    if (left <= 0) throw ranOut();
    const handshakeMs = Math.min(PROVISION_REQUEST_DEADLINE_MS, left);
    return externalEffect(
      'connections.provision',
      async () => {
        const policy = await connectionPolicy(services, httpUrl, {
          ...pinOf(target),
          deadlineMs: handshakeMs,
        });
        const { url, lookup, agent } = outboundConnectOptions(httpUrl, policy);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(url, {
          lookup,
          ...(agent ? { agent } : {}),
          followRedirects: false,
          maxPayload: PROVISION_BODY_MAX,
          handshakeTimeout: handshakeMs,
          perMessageDeflate: false,
          headers: { 'User-Agent': PROVISIONED_NAME },
        });
        sockets.add(ws);
        const { socket: made, opened } = socketOf(ws, remaining);
        await opened;
        return made;
      },
      { idempotent: true },
    );
  };

  const { burrowId, ...given } = input;
  const work = provisioner({
    ...given,
    name: PROVISIONED_NAME,
    publicUrl: redirectOrigin(services.config),
    clientId: provisionClientId(services, burrowId),
    fetch,
    socket,
    clock: services.clock,
  });
  // Past the deadline the provisioner may still settle: nobody listens then.
  work.catch(() => {});
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(ranOut()), Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    if (err instanceof ProvisionError) undoneEffect('connections.provision');
    throw err;
  } finally {
    over = true;
    if (timer) clearTimeout(timer);
    for (const ws of sockets) ws.terminate();
  }
}
