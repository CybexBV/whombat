/**
 * Tests only: an in-process stub server playing one home service (CS-20…CS-25), over http or https (the self-signed
 * home-network certificate), with an optional WebSocket at `/api/websocket` (Home Assistant), and a `ProvisionInput`
 * whose `fetch` and `socket` talk straight to it (no destination policy, the certificate not verified). Every request
 * is kept for the assertions.
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { type CatalogEntry, catalogEntry } from '@whombat/core';
import { expect } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { SELF_SIGNED_CERT_A, SELF_SIGNED_KEY_A } from '../../test/self-signed';
import {
  ProvisionError,
  type ProvisionFetch,
  type ProvisionInput,
  type ProvisionResponse,
  type ProvisionSocket,
  type SignInRefusal,
} from './types';

export interface StubRequest {
  method: string;
  /** The path without the query. */
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The body as JSON (anything when it isn't). */
  // biome-ignore lint/suspicious/noExplicitAny: test stubs read request bodies loosely.
  json(): any;
  /** The body as a form. */
  form(): Record<string, string>;
}

export interface StubReply {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string | string[]>;
}

export type StubRoute = (req: StubRequest) => StubReply | Promise<StubReply>;

/** The service's side of a WebSocket: send JSON, and each message the client sends. */
export interface StubSocket {
  send(message: unknown): void;
  close(): void;
}

export interface StubOptions {
  tls?: boolean;
  /** Answers each WebSocket message at `/api/websocket`; `open` runs when a client connects. */
  websocket?: {
    open(socket: StubSocket): void;
    // biome-ignore lint/suspicious/noExplicitAny: messages are whatever the client sent.
    message(socket: StubSocket, message: any): void;
  };
}

export interface Stub {
  url: string;
  requests: StubRequest[];
  /** Every WebSocket message the client sent. */
  socketMessages: unknown[];
  /** Calls by `METHOD /path` (`'POST /api2/json/access/ticket'`). */
  calls(methodAndPath: string): StubRequest[];
  close(): Promise<void>;
}

function stubRequest(req: http.IncomingMessage, body: string): StubRequest {
  const url = new URL(req.url ?? '/', 'http://stub');
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    body,
    json: () => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    },
    form: () => Object.fromEntries(new URLSearchParams(body)),
  };
}

export async function startStub(route: StubRoute, options: StubOptions = {}): Promise<Stub> {
  const requests: StubRequest[] = [];
  const socketMessages: unknown[] = [];
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const seen = stubRequest(req, Buffer.concat(chunks).toString('utf8'));
      requests.push(seen);
      let reply: StubReply;
      try {
        reply = await route(seen);
      } catch (err) {
        reply = { status: 500, body: String(err) };
      }
      const headers: Record<string, string | string[]> = { ...reply.headers };
      let body = reply.body ?? '';
      if (reply.json !== undefined) {
        body = JSON.stringify(reply.json);
        headers['Content-Type'] ??= 'application/json';
      }
      res.writeHead(reply.status ?? 200, headers);
      res.end(body);
    });
  };
  const server = options.tls
    ? https.createServer({ cert: SELF_SIGNED_CERT_A, key: SELF_SIGNED_KEY_A }, handler)
    : http.createServer(handler);

  let wss: WebSocketServer | null = null;
  if (options.websocket) {
    const ws = options.websocket;
    wss = new WebSocketServer({ server, path: '/api/websocket' });
    wss.on('connection', (client) => {
      const socket: StubSocket = {
        send: (m) => client.send(JSON.stringify(m)),
        close: () => client.close(),
      };
      client.on('message', (data) => {
        const message = JSON.parse(String(data));
        socketMessages.push(message);
        ws.message(socket, message);
      });
      ws.open(socket);
    });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    socketMessages,
    calls: (methodAndPath) => requests.filter((r) => `${r.method} ${r.path}` === methodAndPath),
    close: async () => {
      for (const client of wss?.clients ?? []) client.terminate();
      wss?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `fetch` straight to the stub: a path under the base URL or a same-origin URL; redirects answered, not followed. */
function stubFetch(baseUrl: string): ProvisionFetch {
  const origin = new URL(baseUrl).origin;
  return (pathOrUrl, init) => {
    const url = /^https?:\/\//.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(`${baseUrl}${pathOrUrl}`);
    if (url.origin !== origin) return Promise.reject(new Error(`not the service's origin: ${url.origin}`));
    const body = init.body === undefined ? undefined : Buffer.from(init.body);
    const headers: Record<string, string> = { 'User-Agent': 'Whombat', ...init.headers };
    if (body) headers['Content-Length'] = String(body.length);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise<ProvisionResponse>((resolve, reject) => {
      const req = client.request(url, { method: init.method, headers, rejectUnauthorized: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const all = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: all,
            text: () => all.toString('utf8'),
            json: () => {
              try {
                return JSON.parse(all.toString('utf8'));
              } catch {
                return null;
              }
            },
          });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  };
}

/** A WebSocket straight to the stub, with the `ProvisionSocket` queue. */
async function stubSocket(baseUrl: string, path: string): Promise<ProvisionSocket> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}${path}`);
  const queue: unknown[] = [];
  const waiting: { resolve(m: unknown): void; reject(e: Error): void }[] = [];
  let closed = false;
  ws.on('message', (data) => {
    const message = JSON.parse(String(data));
    const next = waiting.shift();
    if (next) next.resolve(message);
    else queue.push(message);
  });
  ws.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w.reject(new Error('socket closed'));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    send: (m) => ws.send(JSON.stringify(m)),
    next: (timeoutMs = 10_000) => {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.reject(new Error('socket closed'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        waiting.push({
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    },
    close: () => ws.close(),
  };
}

export const TEST_PASSWORD = 'correct horse battery staple';

/** A `ProvisionInput` for the catalog entry, talking to the stub. */
export function stubInput(
  stub: Stub,
  catalogId: string,
  overrides: Partial<Omit<ProvisionInput, 'fetch' | 'socket' | 'entry' | 'baseUrl'>> = {},
): ProvisionInput {
  const entry = catalogEntry(catalogId) as CatalogEntry;
  return {
    entry,
    baseUrl: stub.url,
    fields: { url: stub.url },
    account: 'mara',
    password: TEST_PASSWORD,
    code: null,
    challenge: null,
    access: 'read',
    name: 'Whombat',
    publicUrl: 'https://whombat.home.test',
    clientId: 'whombat-test-client',
    clock: () => new Date('2026-10-08T12:00:00Z'),
    ...overrides,
    fetch: stubFetch(stub.url),
    socket: (path) => stubSocket(stub.url, path),
  };
}

/**
 * The provisioner stopped with a `ProvisionError` of this kind (`second_factor_needed`, or `sign_in_refused` with the
 * reason), and its message never holds the password.
 */
export async function expectStop(
  run: Promise<unknown>,
  expected: SignInRefusal | 'second_factor_needed',
  password = TEST_PASSWORD,
): Promise<ProvisionError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProvisionError);
  const stop = err as ProvisionError;
  if (expected === 'second_factor_needed') expect(stop.code).toBe('second_factor_needed');
  else expect([stop.code, stop.reason]).toEqual(['sign_in_refused', expected]);
  expect(stop.message).not.toContain(password);
  expect(stop.message.length).toBeGreaterThan(0);
  return stop;
}
